// SPDX-License-Identifier: GPL-3.0-or-later
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runSensitiveProcess } from "../admin/sensitive-process.js";
import { fsyncDir, unlinkDurable, writeFileDurable } from "../fs/durable.js";
import type { DurableState, StateCoordinator, StateProjectionContext, StateProjector } from "../state/types.js";

const NETWORK = /^[0-9a-f]{16}$/;
const MEMBERSHIP_FILE = /^([0-9a-f]{16})\.conf$/;
const MANAGED_NETWORK_FILE = /^[0-9a-f]{16}(?:\.local)?\.conf$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ZeroTierState {
  identitySecret: string;
  identityPublic: string;
  memberships: { networkId: string }[];
}

export type ZeroTierRecoveryErrorCode =
  | "ZEROTIER_UNAVAILABLE"
  | "ZEROTIER_IDENTITY_INVALID"
  | "ZEROTIER_STATE_INVALID"
  | "ZEROTIER_SERVICE_FAILED";

/** Fixed diagnostics only: identity text, paths and native output never escape. */
export class ZeroTierRecoveryError extends Error {
  constructor(readonly code: ZeroTierRecoveryErrorCode) {
    super(code === "ZEROTIER_UNAVAILABLE" ? "ZeroTier is unavailable on this device"
      : code === "ZEROTIER_IDENTITY_INVALID" ? "The ZeroTier identity is invalid"
        : code === "ZEROTIER_SERVICE_FAILED" ? "The ZeroTier service could not be safely restored"
          : "The ZeroTier state could not be safely read or projected");
    this.name = "ZeroTierRecoveryError";
  }
}

export interface ZeroTierNative {
  run(command: string, args: readonly string[]): Promise<Buffer>;
}

class SensitiveZeroTierNative implements ZeroTierNative {
  async run(command: string, args: readonly string[]): Promise<Buffer> {
    return (await runSensitiveProcess({ command, args, timeoutMs: 30_000, maxOutputBytes: 256 * 1024 })).stdout;
  }
}

interface ServiceState { active: boolean; unitFileState: "enabled" | "disabled" | "masked" }

export interface ZeroTierAdapterOptions {
  stateDirectory?: string;
  scratchDirectory?: string;
  idtoolPath?: string;
  cliPath?: string;
  systemctlPath?: string;
  envPath?: string;
  unit?: string;
  native?: ZeroTierNative;
  expectedUid?: number;
  clientWaitMs?: number;
  clientPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function canonicalMemberships(values: readonly { networkId: string }[]): { networkId: string }[] {
  const ids = values.map(value => value.networkId);
  if (ids.some(id => !NETWORK.test(id)) || new Set(ids).size !== ids.length) {
    throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
  }
  return [...ids].sort().map(networkId => ({ networkId }));
}

export function validateCanonicalZeroTierState(value: ZeroTierState): ZeroTierState {
  if (typeof value.identitySecret !== "string" || typeof value.identityPublic !== "string"
    || value.identitySecret.length < 1 || Buffer.byteLength(value.identitySecret) > 64 * 1024
    || value.identityPublic.length < 1 || Buffer.byteLength(value.identityPublic) > 64 * 1024
    || /[\r\n\0]/.test(value.identitySecret) || /[\r\n\0]/.test(value.identityPublic)) {
    throw new ZeroTierRecoveryError("ZEROTIER_IDENTITY_INVALID");
  }
  const memberships = canonicalMemberships(value.memberships);
  if (JSON.stringify(memberships) !== JSON.stringify(value.memberships)) {
    throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
  }
  return { identitySecret: value.identitySecret, identityPublic: value.identityPublic, memberships };
}

function outputText(output: Buffer): string {
  try { return output.toString("utf8").trim(); }
  finally { output.fill(0); }
}

/** Fixed-path adapter used only by the root helper. */
export class ZeroTierStateAdapter implements StateProjector {
  readonly name = "zerotier";
  readonly sections = ["zeroTier"] as const;
  private readonly directory: string;
  private readonly scratch: string;
  private readonly idtool: string;
  private readonly cli: string;
  private readonly systemctl: string;
  private readonly env: string;
  private readonly unit: string;
  private readonly native: ZeroTierNative;
  private readonly expectedUid: number;
  private readonly clientWaitMs: number;
  private readonly clientPollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ZeroTierAdapterOptions = {}) {
    this.directory = options.stateDirectory ?? "/var/lib/zerotier-one";
    this.scratch = options.scratchDirectory ?? "/run/yonder-admin";
    this.idtool = options.idtoolPath ?? "/usr/sbin/zerotier-idtool";
    this.cli = options.cliPath ?? "/usr/sbin/zerotier-cli";
    this.systemctl = options.systemctlPath ?? "/usr/bin/systemctl";
    this.env = options.envPath ?? "/usr/bin/env";
    this.unit = options.unit ?? "zerotier-one.service";
    this.native = options.native ?? new SensitiveZeroTierNative();
    this.expectedUid = options.expectedUid ?? (process.getuid?.() ?? 0);
    this.clientWaitMs = options.clientWaitMs ?? 10_000;
    this.clientPollMs = options.clientPollMs ?? 250;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    if (!Number.isSafeInteger(this.clientWaitMs) || this.clientWaitMs < 0 || this.clientWaitMs > 60_000
      || !Number.isSafeInteger(this.clientPollMs) || this.clientPollMs < 1 || this.clientPollMs > 5_000) {
      throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
    for (const path of [this.directory, this.scratch, this.idtool, this.cli, this.systemctl, this.env]) {
      if (!path.startsWith("/") || path.includes("\0")) throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
  }

  /** Capture a clean identity and every supported membership while the writer is stopped. */
  async capture(options: { generateIfMissing?: boolean } = {}): Promise<ZeroTierState | null> {
    if (!existsSync(this.idtool)) return this.absentStateIsReallyAbsent();
    const service = await this.serviceState();
    let result: ZeroTierState | null;
    let bodyError: unknown;
    try {
      const observed = service.active ? await this.listMemberships() : null;
      if (service.active) await this.stopAndVerify();
      result = await this.readStopped();
      if (result === null && options.generateIfMissing === true) result = await this.generate();
      if (observed !== null && JSON.stringify(observed) !== JSON.stringify(result?.memberships ?? [])) {
        throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
      }
    } catch (error) {
      bodyError = error;
      throw error;
    } finally {
      try { await this.restoreService(service); }
      catch {
        // A capture that cannot put the service back is never reported as a
        // usable backup, even when the original read also failed.
        void bodyError;
        throw new ZeroTierRecoveryError("ZEROTIER_SERVICE_FAILED");
      }
    }
    return result!;
  }

  async validate(state: ZeroTierState): Promise<ZeroTierState> {
    const canonical = validateCanonicalZeroTierState(state);
    const temporary = this.temporary("zt-validate-");
    try {
      const secret = join(temporary, "identity.secret");
      const publicPath = join(temporary, "identity.public");
      writeFileDurable(secret, canonical.identitySecret, 0o600);
      writeFileDurable(publicPath, canonical.identityPublic, 0o600);
      await this.native.run(this.idtool, ["validate", secret]);
      await this.native.run(this.idtool, ["validate", publicPath]);
      const derived = outputText(await this.native.run(this.idtool, ["getpublic", secret]));
      if (derived !== canonical.identityPublic) throw new ZeroTierRecoveryError("ZEROTIER_IDENTITY_INVALID");
      return canonical;
    } catch (error) {
      if (error instanceof ZeroTierRecoveryError) throw error;
      throw new ZeroTierRecoveryError("ZEROTIER_IDENTITY_INVALID");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  async apply(input: { operationId: string; previous: DurableState; next: DurableState;
    context: StateProjectionContext }): Promise<void> {
    if (!UUID.test(input.operationId)) throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    const next = input.next.zeroTier;
    if (next === null) {
      // Null exists only for clients without ZeroTier and conservative legacy
      // migration. It must never erase a valid live identity.
      await this.assertNullIsNonDestructive();
      return;
    }
    if (JSON.stringify(input.previous.zeroTier) === JSON.stringify(next)) {
      try { await this.verify({ operationId: input.operationId, expected: input.next }); return; }
      catch { /* Cold boot or damaged volatile projection is recreated below. */ }
    }
    await this.project(await this.validate(next), input.context);
  }

  async verify(input: { operationId: string; expected: DurableState }): Promise<void> {
    if (!UUID.test(input.operationId)) throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    const expected = input.expected.zeroTier;
    if (expected === null) { await this.assertNullIsNonDestructive(); return; }
    const canonical = await this.validate(expected);
    const service = await this.serviceState();
    const wanted = canonical.memberships.length > 0;
    if (service.active !== wanted || service.unitFileState !== (wanted ? "enabled" : "disabled")) {
      throw new ZeroTierRecoveryError("ZEROTIER_SERVICE_FAILED");
    }
    const live = await this.readFiles();
    if (live === null || JSON.stringify(live) !== JSON.stringify(canonical)) {
      throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
    if (wanted) {
      const expected = canonical.memberships;
      let actual: { networkId: string }[] | undefined;
      for (let waited = 0;; waited += this.clientPollMs) {
        try { actual = await this.listMemberships(); } catch { actual = undefined; }
        if (actual && JSON.stringify(actual) === JSON.stringify(expected)) break;
        if (waited >= this.clientWaitMs) throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
        await this.sleep(Math.min(this.clientPollMs, this.clientWaitMs - waited));
      }
    }
  }

  private absentStateIsReallyAbsent(): null {
    const secret = existsSync(join(this.directory, "identity.secret"));
    const publicIdentity = existsSync(join(this.directory, "identity.public"));
    if (secret || publicIdentity || this.hasMembershipFiles()) throw new ZeroTierRecoveryError("ZEROTIER_UNAVAILABLE");
    return null;
  }

  private async assertNullIsNonDestructive(): Promise<void> {
    if (!existsSync(this.idtool)) { this.absentStateIsReallyAbsent(); return; }
    const live = await this.readFiles();
    if (live !== null) await this.validate(live);
  }

  private async project(target: ZeroTierState, context: StateProjectionContext): Promise<void> {
    const service = await this.serviceState();
    let previous: ZeroTierState | null = null;
    let mutationStarted = false;
    try {
      if (service.active) await this.stopAndVerify();
      if (context === "recovery") this.assertOwnedRepairableProjection();
      else previous = await this.readStopped();
      // From this point a failed write may have removed or replaced part of
      // the live state, so the validated snapshot above is authoritative for
      // rollback. Before this point, leave unreadable files byte-for-byte
      // untouched; null must never mean "safe to erase" after a read error.
      mutationStarted = true;
      this.writeState(target);
      await this.setDesiredService(target.memberships.length > 0);
      await this.verify({ operationId: randomUUID(), expected: { config: {} as never, secrets: {}, linuxOwner: null, zeroTier: target } });
    } catch (error) {
      try {
        if (mutationStarted && context !== "recovery") {
          if ((await this.serviceState()).active) await this.stopAndVerify();
          if (previous !== null) this.writeState(previous); else this.clearState();
        }
        if (context === "recovery" && mutationStarted) {
          if ((await this.serviceState()).active) await this.stopAndVerify();
          let complete = false;
          try {
            const observed = await this.readStopped();
            complete = observed !== null && JSON.stringify(observed) === JSON.stringify(target);
          } catch { /* A partial authoritative projection must remain stopped. */ }
          await this.restoreService({ ...service, active: complete ? service.active : false });
        } else await this.restoreService(service);
      } catch { throw new ZeroTierRecoveryError("ZEROTIER_SERVICE_FAILED"); }
      if (error instanceof ZeroTierRecoveryError) throw error;
      throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
  }

  private async readStopped(): Promise<ZeroTierState | null> {
    if ((await this.serviceState()).active) throw new ZeroTierRecoveryError("ZEROTIER_SERVICE_FAILED");
    const state = await this.readFiles();
    return state === null ? null : this.validate(state);
  }

  /**
   * Recovery replays a complete selected journal generation. It may replace
   * partial files created by an interrupted earlier projection, but only when
   * every existing managed path still has the fixed root-owned shape.
   */
  private assertOwnedRepairableProjection(): void {
    if (!this.lstatOptional(this.directory)) return;
    this.safeDirectory(this.directory);
    const secret = join(this.directory, "identity.secret"), publicPath = join(this.directory, "identity.public");
    if (this.lstatOptional(secret)) this.safeOwnedProjectionFile(secret, 0o600, false);
    if (this.lstatOptional(publicPath)) this.safeOwnedProjectionFile(publicPath, 0o644, false);
    const networks = join(this.directory, "networks.d");
    if (!this.lstatOptional(networks)) return;
    this.safeDirectory(networks);
    for (const name of readdirSync(networks)) {
      if (MANAGED_NETWORK_FILE.test(name)) this.safeOwnedProjectionFile(join(networks, name), undefined, true);
    }
  }

  private lstatOptional(path: string): ReturnType<typeof lstatSync> | undefined {
    try { return lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
  }

  private safeOwnedProjectionFile(path: string, mode: number | undefined, allowEmpty: boolean): void {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== this.expectedUid
      || (mode === undefined ? Boolean(info.mode & 0o022) : (info.mode & 0o777) !== mode)
      || (!allowEmpty && info.size < 1) || info.size > 64 * 1024) {
      throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
  }

  private async readFiles(): Promise<ZeroTierState | null> {
    const secretPath = join(this.directory, "identity.secret");
    const publicPath = join(this.directory, "identity.public");
    const secretExists = existsSync(secretPath), publicExists = existsSync(publicPath);
    if (secretExists !== publicExists) throw new ZeroTierRecoveryError("ZEROTIER_IDENTITY_INVALID");
    if (!secretExists) {
      if (this.hasMembershipFiles()) throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
      return null;
    }
    const secret = this.privateFile(secretPath, 0o600);
    const publicIdentity = this.privateFile(publicPath, 0o644);
    const networksDirectory = join(this.directory, "networks.d");
    let memberships: { networkId: string }[] = [];
    if (existsSync(networksDirectory)) {
      this.safeDirectory(networksDirectory);
      memberships = readdirSync(networksDirectory).flatMap(name => {
        const match = MEMBERSHIP_FILE.exec(name);
        if (!match) return [];
        this.safeManagedFile(join(networksDirectory, name));
        return [{ networkId: match[1]! }];
      }).sort((left, right) => left.networkId.localeCompare(right.networkId));
    }
    return { identitySecret: secret, identityPublic: publicIdentity, memberships };
  }

  private async generate(): Promise<ZeroTierState> {
    const temporary = this.temporary("zt-generate-");
    try {
      const secret = join(temporary, "identity.secret"), publicPath = join(temporary, "identity.public");
      await this.native.run(this.idtool, ["generate", secret, publicPath]);
      chmodSync(secret, 0o600); chmodSync(publicPath, 0o600);
      return this.validate({ identitySecret: readFileSync(secret, "utf8").trim(),
        identityPublic: readFileSync(publicPath, "utf8").trim(), memberships: [] });
    } catch (error) {
      if (error instanceof ZeroTierRecoveryError) throw error;
      throw new ZeroTierRecoveryError("ZEROTIER_IDENTITY_INVALID");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }

  private writeState(state: ZeroTierState): void {
    this.ensureDirectory(this.directory, 0o700);
    const networks = join(this.directory, "networks.d");
    this.ensureDirectory(networks, 0o700);
    for (const name of readdirSync(networks)) {
      if (!MANAGED_NETWORK_FILE.test(name)) continue;
      this.safeManagedFile(join(networks, name));
      unlinkDurable(join(networks, name));
    }
    writeFileDurable(join(this.directory, "identity.secret"), state.identitySecret, 0o600);
    writeFileDurable(join(this.directory, "identity.public"), state.identityPublic, 0o644);
    for (const { networkId } of state.memberships) writeFileDurable(join(networks, `${networkId}.conf`), "", 0o600);
  }

  private clearState(): void {
    for (const name of ["identity.secret", "identity.public"]) unlinkDurable(join(this.directory, name));
    const networks = join(this.directory, "networks.d");
    if (!existsSync(networks)) return;
    for (const name of readdirSync(networks)) {
      if (!MANAGED_NETWORK_FILE.test(name)) continue;
      this.safeManagedFile(join(networks, name));
      unlinkDurable(join(networks, name));
    }
  }

  private privateFile(path: string, mode: number): string {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== this.expectedUid
      || (info.mode & 0o777) !== mode || info.size < 1 || info.size > 64 * 1024) {
      throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
    const value = readFileSync(path, "utf8");
    if (Buffer.byteLength(value) !== info.size || /[\r\n\0]/.test(value)) throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    return value;
  }

  private safeDirectory(path: string): void {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== this.expectedUid || (info.mode & 0o022)) {
      throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
  }

  private safeManagedFile(path: string): void {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== this.expectedUid || (info.mode & 0o022)) {
      throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
    }
  }

  private hasMembershipFiles(): boolean {
    const path = join(this.directory, "networks.d");
    if (!existsSync(path)) return false;
    this.safeDirectory(path);
    return readdirSync(path).some(name => MEMBERSHIP_FILE.test(name));
  }

  private ensureDirectory(path: string, mode: number): void {
    if (!existsSync(path)) { mkdirSync(path, { mode, recursive: false }); fsyncDir(dirname(path)); }
    this.safeDirectory(path);
    chmodSync(path, mode);
  }

  private temporary(prefix: string): string {
    if (!existsSync(this.scratch)) { mkdirSync(this.scratch, { mode: 0o700 }); fsyncDir(dirname(this.scratch)); }
    this.safeDirectory(this.scratch);
    const path = mkdtempSync(join(this.scratch, prefix));
    chmodSync(path, 0o700);
    return path;
  }

  private async serviceState(): Promise<ServiceState> {
    try {
      const active = outputText(await this.runSystemctl(["show", this.unit, "--property=ActiveState", "--value"]));
      const unitFileState = outputText(await this.runSystemctl(["show", this.unit, "--property=UnitFileState", "--value"]));
      if (!(["active", "inactive"] as string[]).includes(active)
        || !(["enabled", "disabled", "masked"] as string[]).includes(unitFileState)) throw new Error("unstable");
      return { active: active === "active", unitFileState: unitFileState as ServiceState["unitFileState"] };
    } catch { throw new ZeroTierRecoveryError("ZEROTIER_SERVICE_FAILED"); }
  }

  private async listMemberships(): Promise<{ networkId: string }[]> {
    try {
      const networks = JSON.parse(outputText(await this.native.run(this.cli, ["-j", "listnetworks"]))) as unknown;
      if (!Array.isArray(networks)) throw new Error("invalid");
      const ids = networks.map(item => (item as { nwid?: unknown }).nwid);
      if (ids.some(id => typeof id !== "string" || !NETWORK.test(id)) || new Set(ids).size !== ids.length) throw new Error("invalid");
      return (ids as string[]).sort().map(networkId => ({ networkId }));
    } catch { throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID"); }
  }

  private async stopAndVerify(): Promise<void> {
    try {
      await this.runSystemctl(["stop", this.unit]);
      if ((await this.serviceState()).active) throw new Error("active");
    } catch { throw new ZeroTierRecoveryError("ZEROTIER_SERVICE_FAILED"); }
  }

  private async setDesiredService(wanted: boolean): Promise<void> {
    try {
      await this.runSystemctl(["unmask", this.unit]);
      await this.runSystemctl([wanted ? "enable" : "disable", this.unit]);
      await this.runSystemctl([wanted ? "start" : "stop", this.unit]);
      const observed = await this.serviceState();
      if (observed.active !== wanted || observed.unitFileState !== (wanted ? "enabled" : "disabled")) throw new Error("mismatch");
    } catch { throw new ZeroTierRecoveryError("ZEROTIER_SERVICE_FAILED"); }
  }

  private async restoreService(state: ServiceState): Promise<void> {
    try {
      let observed = await this.serviceState();
      if (observed.unitFileState !== state.unitFileState) {
        if (state.unitFileState === "masked") await this.runSystemctl(["mask", this.unit]);
        else {
          if (observed.unitFileState === "masked") await this.runSystemctl(["unmask", this.unit]);
          await this.runSystemctl([state.unitFileState === "enabled" ? "enable" : "disable", this.unit]);
        }
      }
      observed = await this.serviceState();
      if (observed.active !== state.active) await this.runSystemctl([state.active ? "start" : "stop", this.unit]);
      observed = await this.serviceState();
      if (observed.active !== state.active || observed.unitFileState !== state.unitFileState) throw new Error("mismatch");
    } catch { throw new ZeroTierRecoveryError("ZEROTIER_SERVICE_FAILED"); }
  }

  private runSystemctl(args: readonly string[]): Promise<Buffer> {
    // The installed package also ships a SysV script. The root helper controls
    // only the native systemd unit and must not make client-side rc?.d writes.
    return this.native.run(this.env, ["SYSTEMCTL_SKIP_SYSV=1", this.systemctl, ...args]);
  }
}

/** Materialize the configured membership without losing other restored networks. */
export function zeroTierStateForConfig(state: DurableState, previous: DurableState): DurableState {
  if (state.zeroTier === null) {
    const wanted = state.config.remote.zerotier.enabled && state.config.remote.zerotier.network_id !== null;
    if (wanted) throw new ZeroTierRecoveryError("ZEROTIER_UNAVAILABLE");
    return state;
  }
  const ids = new Set(state.zeroTier.memberships.map(item => item.networkId));
  const old = previous.config.remote.zerotier;
  const next = state.config.remote.zerotier;
  const oldId = old.enabled ? old.network_id : null;
  const nextId = next.enabled ? next.network_id : null;
  if (oldId && oldId !== nextId) ids.delete(oldId);
  if (nextId) ids.add(nextId);
  return { ...state, zeroTier: { ...state.zeroTier,
    memberships: [...ids].sort().map(networkId => ({ networkId })) } };
}

/** Wrap the coordinator's conventional bootstrap closure before any generation is published. */
export function bootstrapWithZeroTier(
  bootstrap: () => Promise<DurableState>,
  adapter: Pick<ZeroTierStateAdapter, "capture">,
): () => Promise<DurableState> {
  return async () => {
    const state = await bootstrap();
    const withCapture = { ...state, zeroTier: await adapter.capture({ generateIfMissing: true }) };
    return zeroTierStateForConfig(withCapture, state);
  };
}

/** Upgrade a previously created null WIP generation without exposing a write race. */
export async function reconcileZeroTierBootstrap(
  coordinator: StateCoordinator,
  adapter: Pick<ZeroTierStateAdapter, "capture">,
): Promise<{ changed: boolean; generation: string }> {
  const active = await coordinator.readActiveState();
  if (active.state.zeroTier !== null) return { changed: false, generation: active.generation };
  // Maintenance deliberately keeps the global operation guard across reboot.
  // A null legacy generation is safe because the null projector never erases
  // live identity; the next ordinary boot performs this migration.
  if ((await coordinator.status()).operation !== null) return { changed: false, generation: active.generation };
  return captureZeroTierState(coordinator, adapter, active.generation);
}

/** Reconcile a current clean capture immediately before an explicit export. */
export async function refreshZeroTierState(
  coordinator: StateCoordinator,
  adapter: Pick<ZeroTierStateAdapter, "capture">,
): Promise<{ changed: boolean; generation: string }> {
  const active = await coordinator.readActiveState();
  return captureZeroTierState(coordinator, adapter, active.generation);
}

async function captureZeroTierState(
  coordinator: StateCoordinator,
  adapter: Pick<ZeroTierStateAdapter, "capture">,
  expectedActiveGeneration: string,
): Promise<{ changed: boolean; generation: string }> {
  const transaction = await coordinator.begin({ id: randomUUID(), kind: "bootstrap", expectedActiveGeneration });
  let commitAttempted = false;
  let stagedGeneration: string | undefined;
  try {
    const captured = zeroTierStateForConfig({ ...transaction.previous.state,
      zeroTier: await adapter.capture({ generateIfMissing: true }) }, transaction.previous.state).zeroTier;
    if (JSON.stringify(captured) === JSON.stringify(transaction.previous.state.zeroTier)) {
      let result;
      try { result = await transaction.rollback("mesh-already-current"); }
      catch { result = await transaction.rollback("mesh-already-current"); }
      return { changed: false, generation: result.generation };
    }
    stagedGeneration = (await transaction.stage({ ...transaction.previous.state, zeroTier: captured })).generation;
    await transaction.activate();
    commitAttempted = true;
    try {
      const result = await transaction.commit();
      return { changed: true, generation: result.generation };
    } catch {
      try {
        const result = await transaction.commit();
        return { changed: true, generation: result.generation };
      } catch {
        const recovered = await coordinator.recover();
        if (recovered.selectedGeneration === stagedGeneration) {
          return { changed: true, generation: recovered.selectedGeneration };
        }
        throw new ZeroTierRecoveryError("ZEROTIER_STATE_INVALID");
      }
    }
  } catch (error) {
    if (!commitAttempted) {
      try { await transaction.rollback("mesh-bootstrap-failed"); }
      catch {
        try { await transaction.rollback("mesh-bootstrap-failed"); }
        catch { /* Durable journal recovery retains authority and blocks later writes. */ }
      }
    }
    throw error;
  }
}
