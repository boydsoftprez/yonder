// SPDX-License-Identifier: GPL-3.0-or-later
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { runSensitiveProcess } from "../admin/sensitive-process.js";
import { fsyncDir, unlinkDurable, writeFileDurable } from "../fs/durable.js";
import type { DurableState, OwnerAccessRecord, StateProjector } from "../state/types.js";
import { validateOwnerPublicKey, validateOwnerRecord, validateOwnerUsername } from "./model.js";
import { hashLinuxPassword } from "./password.js";
import type { OwnerNativeBackend } from "./service.js";

const TAG = /^Yonder managed owner [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_DIRECTORY = "/etc/ssh/yonder_authorized_keys";
const SSH_POLICY = "/etc/ssh/sshd_config.d/00-yonder-owner.conf";
const SUDO_POLICY = "/etc/sudoers.d/yonder-owner";
const HOST_KEY = "/etc/ssh/ssh_host_ed25519_key";
const OWNER_POLICY_MARKER = "/var/lib/yonder-state/owner-access-managed";
const OWNER_POLICY_MARKER_CONTENTS = "managed\n";
const OWNER_POLICY_STAGING = "/var/lib/yonder-state/owner-access-staging";

export class LinuxOwnerError extends Error {
  constructor(readonly code: "DESTINATION_CONFLICT" | "NATIVE_STATE_INVALID" | "POLICY_MISMATCH") {
    super(code === "DESTINATION_CONFLICT" ? "The Linux account name or home is already in use"
      : code === "POLICY_MISMATCH" ? "Linux login policy could not be verified" : "Linux account state could not be verified");
    this.name = "LinuxOwnerError";
  }
}

interface PasswdEntry { name: string; uid: number; gid: number; comment: string; home: string; shell: string }
interface GroupEntry { name: string; gid: number; members: string[] }
type UnitFileState = "enabled" | "disabled" | "masked";
interface UnitState { active: boolean; unitFileState: UnitFileState }
interface SshServiceState { service: UnitState; socket: UnitState }
interface SshServiceControl {
  snapshot(): Promise<SshServiceState>;
  setEnabled(enabled: boolean): Promise<void>;
  restore(state: SshServiceState): Promise<void>;
}
interface FirstOwnerStagingRecord {
  schemaVersion: 1;
  operationId: string;
  username: string;
  rootPasswordHash: string;
  ssh: SshServiceState;
}

interface LinuxOwnerProjectorOptions {
  serviceControl?: SshServiceControl;
  /** Factory images must secure an ownerless state; conventional upgrades retain OS SSH until first ownership. */
  enforceUnowned?: boolean;
}

export function ownerSshPolicy(owner: OwnerAccessRecord | null): string {
  if (owner) validateOwnerRecord(owner);
  return "# Managed by Yonder; derived from the durable owner record.\n"
    + "PermitRootLogin no\nPermitEmptyPasswords no\nKbdInteractiveAuthentication no\n"
    + `PasswordAuthentication ${owner?.sshPasswordAuthentication ? "yes" : "no"}\n`
    + "PubkeyAuthentication yes\nAuthenticationMethods any\nUsePAM yes\n"
    + `HostKey ${HOST_KEY}\nAuthorizedKeysFile ${KEY_DIRECTORY}/%u\n`
    + (owner ? `AllowUsers ${owner.username}\n` : "DenyUsers *\n");
}

function regularRootFile(path: string): boolean {
  const info = lstatSync(path);
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.uid === 0 && !(info.mode & 0o022);
}

/** Only instantiated by the root helper, or inside a disposable Linux integration container. */
export class LinuxOwnerProjector implements StateProjector, OwnerNativeBackend {
  readonly name = "linux-owner";
  readonly sections = ["linuxOwner"] as const;
  private readonly serviceControl: SshServiceControl;
  private readonly enforceUnowned: boolean;

  constructor(options: LinuxOwnerProjectorOptions = {}) {
    this.enforceUnowned = options.enforceUnowned ?? true;
    this.serviceControl = options.serviceControl ?? {
      snapshot: () => this.sshServiceState(),
      setEnabled: enabled => this.setSshEnabled(enabled),
      restore: state => this.restoreSshServiceState(state),
    };
    if (process.platform !== "linux" || process.getuid?.() !== 0) {
      throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    }
  }

  hashPassword(password: string): Promise<string> { return hashLinuxPassword(password); }

  async preflightCreate(username: string): Promise<void> {
    validateOwnerUsername(username);
    const [users, groups] = await Promise.all([this.users(), this.groups()]);
    if (users.some(user => user.name === username) || groups.some(group => group.name === username)
      || existsSync(`/home/${username}`)) throw new LinuxOwnerError("DESTINATION_CONFLICT");
  }

  async preflightRestore(owner: OwnerAccessRecord | null, current: OwnerAccessRecord | null): Promise<void> {
    if (!owner) return;
    validateOwnerRecord(owner);
    await this.verifyPublicKeys(owner.authorizedKeys);
    if (owner.username !== current?.username) await this.preflightCreate(owner.username);
    else await this.assertCompatibleAccount(owner);
  }

  async apply(input: { operationId: string; previous: DurableState; next: DurableState;
    context?: "activation" | "rollback" | "recovery" }): Promise<void> {
    const previous = input.previous.linuxOwner && validateOwnerRecord(input.previous.linuxOwner);
    const next = input.next.linuxOwner && validateOwnerRecord(input.next.linuxOwner);
    if (!/^[0-9a-f-]{36}$/.test(input.operationId)) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    await this.verifyPublicKeys(next?.authorizedKeys ?? []);
    if (next) await this.assertCompatibleAccount(next);
    let ownsPolicy = this.ownsOwnerPolicy();
    if (!previous && !next && !ownsPolicy) return;
    if (previous && !next && !ownsPolicy) {
      if (existsSync(OWNER_POLICY_STAGING)) {
        await this.rollbackUnmanagedFirstOwner(input.operationId, previous);
        return;
      }
      // Recovery of a merely staged first owner has no native record to undo.
      // Activation from a durable existing owner is a pre-marker migration.
      if (input.context !== "activation") return;
      await this.adoptCommittedOwner(input.operationId, input.previous);
      ownsPolicy = true;
    } else if (previous && !ownsPolicy && !existsSync(OWNER_POLICY_STAGING)) {
      await this.adoptCommittedOwner(input.operationId, input.previous);
      ownsPolicy = true;
    }
    const initialConventionalOwner = !ownsPolicy && !previous && next !== null;
    if (initialConventionalOwner) await this.beginUnmanagedFirstOwner(input.operationId, next);
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      try {
        await this.verify({ operationId: input.operationId, expected: input.next });
        await this.serviceControl.setEnabled(next?.sshEnabled ?? false);
        return;
      } catch { /* Cold boot may need to recreate the owner in volatile /etc. */ }
    }
    // A conventional installation can have an OS-managed SSH listener before
    // its first Yonder owner. Keep it running until the Yonder policy itself
    // has verified; the staged marker lets rollback remove only files this
    // projection created if an account or policy step fails first.
    if (!initialConventionalOwner) await this.serviceControl.setEnabled(false);
    if (next) await this.projectAccount(next, input.operationId);
    if (previous && (!next || previous.username !== next.username))
      await this.removeManaged(previous.username, input.context === "rollback" || input.context === "recovery");
    this.directory("/etc/ssh/sshd_config.d", 0o755);
    this.directory(KEY_DIRECTORY, 0o755);
    this.directory("/etc/sudoers.d", 0o750);
    this.directory("/run/sshd", 0o755);
    if (previous && (!next || previous.username !== next.username)) {
      unlinkDurable(join(KEY_DIRECTORY, previous.username));
    }
    writeFileDurable(SSH_POLICY, ownerSshPolicy(next), 0o644);
    if (next) {
      writeFileDurable(join(KEY_DIRECTORY, next.username), next.authorizedKeys.join("\n") + "\n", 0o644);
      writeFileDurable(SUDO_POLICY, `${next.username} ALL=(ALL:ALL) ALL\n`, 0o440);
    } else { unlinkDurable(SUDO_POLICY); }
    await this.ensureHostKey();
    await this.verifyPolicies(next);
    await runSensitiveProcess({ command: "/usr/bin/passwd", args: ["--lock", "root"] });
    await this.serviceControl.setEnabled(next?.sshEnabled ?? false);
  }

  async finalizeCommit(input: { operationId: string; previous: DurableState; next: DurableState }): Promise<void> {
    if (this.enforceUnowned || !existsSync(OWNER_POLICY_STAGING)) return;
    const next = input.next.linuxOwner && validateOwnerRecord(input.next.linuxOwner);
    if (!next) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    this.claimOwnerPolicy(input.operationId, next.username);
  }

  async verify(input: { operationId: string; expected: DurableState }): Promise<void> {
    const owner = input.expected.linuxOwner && validateOwnerRecord(input.expected.linuxOwner);
    if (!owner && !this.ownsOwnerPolicy()) return;
    if (owner) {
      const user = (await this.users()).find(entry => entry.name === owner.username);
      if (!user || !this.managed(user)) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
      const shadow = await this.output("/usr/bin/getent", ["shadow", owner.username]);
      if (shadow.split(":")[1] !== owner.passwordHash) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
      const sudo = (await this.groups()).find(group => group.name === "sudo");
      if (!sudo?.members.includes(owner.username)) throw new LinuxOwnerError("POLICY_MISMATCH");
      const keyFile = join(KEY_DIRECTORY, owner.username);
      if (!regularRootFile(keyFile) || !regularRootFile(SUDO_POLICY)
        || (lstatSync(SUDO_POLICY).mode & 0o777) !== 0o440
        || readFileSync(SUDO_POLICY, "utf8") !== `${owner.username} ALL=(ALL:ALL) ALL\n`
        || readFileSync(keyFile, "utf8") !== owner.authorizedKeys.join("\n") + "\n") {
        throw new LinuxOwnerError("POLICY_MISMATCH");
      }
    } else if (existsSync(SUDO_POLICY)) throw new LinuxOwnerError("POLICY_MISMATCH");
    const root = await this.output("/usr/bin/getent", ["shadow", "root"]);
    if (!/^[!*]/.test(root.split(":")[1] ?? "")) throw new LinuxOwnerError("POLICY_MISMATCH");
    await this.verifyPolicies(owner);
  }

  private async projectAccount(owner: OwnerAccessRecord, operationId: string): Promise<void> {
    const users = await this.users();
    let user = users.find(entry => entry.name === owner.username);
    if (!user) {
      if ((await this.groups()).some(group => group.name === owner.username)) throw new LinuxOwnerError("DESTINATION_CONFLICT");
      // Replaying a prior owner may encounter its preserved, nonempty home.
      // Reuse that unclaimed UID rather than assigning another user's identity
      // or recursively changing ownership of arbitrary home contents.
      const uidArgs: string[] = [];
      if (existsSync(`/home/${owner.username}`)) {
        const home = lstatSync(`/home/${owner.username}`);
        if (home.uid !== 0) {
          if (home.uid < 1000 || home.uid >= 60000 || users.some(entry => entry.uid === home.uid))
            throw new LinuxOwnerError("DESTINATION_CONFLICT");
          uidArgs.push("--uid", String(home.uid));
        }
      }
      await runSensitiveProcess({ command: "/usr/sbin/useradd", args: ["--no-log-init", "--no-create-home", "--user-group",
        ...uidArgs, "--home-dir", `/home/${owner.username}`, "--shell", "/bin/bash", "--comment", `Yonder managed owner ${operationId}`, owner.username] });
      user = (await this.users()).find(entry => entry.name === owner.username);
    }
    if (!user || !this.managed(user)) throw new LinuxOwnerError("DESTINATION_CONFLICT");
    this.home(user);
    const passwordInput = Buffer.from(`${owner.username}:${owner.passwordHash}\n`);
    try { await runSensitiveProcess({ command: "/usr/sbin/chpasswd", args: ["--encrypted"], stdin: passwordInput }); }
    finally { passwordInput.fill(0); }
    await runSensitiveProcess({ command: "/usr/sbin/usermod", args: ["--append", "--groups", "sudo", owner.username] });
  }

  /** A durable Yonder marker, never an arbitrary sshd fragment, says policy ownership began. */
  private ownsOwnerPolicy(): boolean {
    if (this.enforceUnowned) return true;
    if (!existsSync(OWNER_POLICY_MARKER)) return false;
    if (!regularRootFile(OWNER_POLICY_MARKER)
      || (lstatSync(OWNER_POLICY_MARKER).mode & 0o777) !== 0o600
      || readFileSync(OWNER_POLICY_MARKER, "utf8") !== OWNER_POLICY_MARKER_CONTENTS) {
      throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    }
    return true;
  }

  /** Record that an initially conventional host has passed validation and native mutation can begin. */
  private async beginUnmanagedFirstOwner(operationId: string, owner: OwnerAccessRecord): Promise<void> {
    if (existsSync(OWNER_POLICY_STAGING)) {
      this.readStagedOwnerPolicy(operationId, owner.username);
      return;
    }
    // These exact files become ours only after this record is promoted. An
    // unmarked conventional host carrying one is ambiguous, so refuse it
    // rather than overwrite or later remove somebody else's policy.
    if (existsSync(SSH_POLICY) || existsSync(SUDO_POLICY)
      || existsSync(join(KEY_DIRECTORY, owner.username))) {
      throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    }
    this.directory("/var/lib/yonder-state", 0o700);
    const record: FirstOwnerStagingRecord = {
      schemaVersion: 1,
      operationId,
      username: owner.username,
      rootPasswordHash: await this.rootPasswordHash(),
      ssh: await this.serviceControl.snapshot(),
    };
    writeFileDurable(OWNER_POLICY_STAGING, `${JSON.stringify(record)}\n`, 0o600);
    this.readStagedOwnerPolicy(operationId, owner.username);
  }

  /** Promote a verified native policy from the first-owner staging record. */
  private claimOwnerPolicy(stagedOperation?: string, username?: string): void {
    if (stagedOperation !== undefined) this.readStagedOwnerPolicy(stagedOperation, username);
    if (!existsSync(OWNER_POLICY_MARKER)) {
      writeFileDurable(OWNER_POLICY_MARKER, OWNER_POLICY_MARKER_CONTENTS, 0o600);
    }
    if (!regularRootFile(OWNER_POLICY_MARKER)
      || (lstatSync(OWNER_POLICY_MARKER).mode & 0o777) !== 0o600
      || readFileSync(OWNER_POLICY_MARKER, "utf8") !== OWNER_POLICY_MARKER_CONTENTS) {
      throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    }
    if (stagedOperation !== undefined) {
      unlinkDurable(OWNER_POLICY_STAGING);
    }
  }

  /** Undo only a conventionally staged first owner; a committed policy marker never takes this path. */
  private async rollbackUnmanagedFirstOwner(operationId: string, owner: OwnerAccessRecord): Promise<void> {
    if (!existsSync(OWNER_POLICY_STAGING)) return;
    const staged = this.readStagedOwnerPolicy(operationId, owner.username);
    await this.removeManaged(owner.username, true);
    unlinkDurable(join(KEY_DIRECTORY, owner.username));
    unlinkDurable(SUDO_POLICY);
    unlinkDurable(SSH_POLICY);
    await this.restoreRootPassword(staged.rootPasswordHash);
    await this.serviceControl.restore(staged.ssh);
    unlinkDurable(OWNER_POLICY_STAGING);
  }

  private readStagedOwnerPolicy(operationId: string, username?: string): FirstOwnerStagingRecord {
    if (!regularRootFile(OWNER_POLICY_STAGING)
      || (lstatSync(OWNER_POLICY_STAGING).mode & 0o777) !== 0o600) {
      throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    }
    try {
      const value = JSON.parse(readFileSync(OWNER_POLICY_STAGING, "utf8")) as Partial<FirstOwnerStagingRecord>;
      const validUnit = (unit: unknown): unit is UnitState => {
        const candidate = unit as Partial<UnitState> | null;
        return candidate !== null && typeof candidate === "object" && typeof candidate.active === "boolean"
          && (["enabled", "disabled", "masked"] as unknown[]).includes(candidate.unitFileState)
          && !(candidate.active && candidate.unitFileState === "masked")
          && Object.keys(candidate).length === 2;
      };
      if (value.schemaVersion !== 1 || value.operationId !== operationId
        || typeof value.username !== "string" || (username !== undefined && value.username !== username)
        || typeof value.rootPasswordHash !== "string" || value.rootPasswordHash.length > 4096
        || /[:\r\n\0]/.test(value.rootPasswordHash)
        || !value.ssh || !validUnit(value.ssh.service) || !validUnit(value.ssh.socket)
        || Object.keys(value.ssh).length !== 2 || Object.keys(value).length !== 5) {
        throw new Error("invalid");
      }
      return value as FirstOwnerStagingRecord;
    } catch { throw new LinuxOwnerError("NATIVE_STATE_INVALID"); }
  }

  private async adoptCommittedOwner(operationId: string, expected: DurableState): Promise<void> {
    await this.verify({ operationId, expected });
    this.claimOwnerPolicy();
  }

  private async rootPasswordHash(): Promise<string> {
    const fields = (await this.output("/usr/bin/getent", ["shadow", "root"])).trimEnd().split(":");
    const hash = fields[1];
    if (fields.length !== 9 || hash === undefined || hash.length > 4096 || /[\r\n\0]/.test(hash)) {
      throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    }
    return hash;
  }

  private async restoreRootPassword(hash: string): Promise<void> {
    const passwordInput = Buffer.from(`root:${hash}\n`);
    try {
      await runSensitiveProcess({ command: "/usr/sbin/chpasswd", args: ["--encrypted"], stdin: passwordInput });
    } finally { passwordInput.fill(0); }
    if (await this.rootPasswordHash() !== hash) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
  }

  private async sshServiceState(): Promise<SshServiceState> {
    const unit = async (name: "ssh.service" | "ssh.socket"): Promise<UnitState> => {
      const active = (await this.output("/usr/bin/systemctl", ["show", name, "--property=ActiveState", "--value"])).trim();
      const unitFileState = (await this.output("/usr/bin/systemctl", ["show", name, "--property=UnitFileState", "--value"])).trim();
      if (!(active === "active" || active === "inactive")
        || !(unitFileState === "enabled" || unitFileState === "disabled" || unitFileState === "masked")
        || (active === "active" && unitFileState === "masked")) {
        throw new LinuxOwnerError("NATIVE_STATE_INVALID");
      }
      return { active: active === "active", unitFileState };
    };
    return { service: await unit("ssh.service"), socket: await unit("ssh.socket") };
  }

  private async setSshEnabled(enabled: boolean): Promise<void> {
    // Socket activation must not reopen SSH after the owner disables it.
    await runSensitiveProcess({ command: "/usr/bin/systemctl",
      args: ["mask", "--now", "ssh.socket"], timeoutMs: 30_000 });
    await runSensitiveProcess({ command: "/usr/bin/systemctl",
      args: [enabled ? "enable" : "disable", "--now", "ssh.service"], timeoutMs: 30_000 });
    const observed = await this.sshServiceState();
    if (observed.socket.active || observed.socket.unitFileState !== "masked"
      || observed.service.active !== enabled
      || observed.service.unitFileState !== (enabled ? "enabled" : "disabled")) {
      throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    }
  }

  private async restoreSshServiceState(state: SshServiceState): Promise<void> {
    const restore = async (name: "ssh.service" | "ssh.socket", wanted: UnitState): Promise<void> => {
      if (wanted.unitFileState === "masked") {
        await runSensitiveProcess({ command: "/usr/bin/systemctl", args: ["mask", "--now", name], timeoutMs: 30_000 });
      } else {
        await runSensitiveProcess({ command: "/usr/bin/systemctl", args: ["unmask", name], timeoutMs: 30_000 });
        await runSensitiveProcess({ command: "/usr/bin/systemctl",
          args: [wanted.unitFileState === "enabled" ? "enable" : "disable", name], timeoutMs: 30_000 });
        await runSensitiveProcess({ command: "/usr/bin/systemctl",
          args: [wanted.active ? "start" : "stop", name], timeoutMs: 30_000 });
      }
    };
    await restore("ssh.service", state.service);
    await restore("ssh.socket", state.socket);
    const observed = await this.sshServiceState();
    if (JSON.stringify(observed) !== JSON.stringify(state)) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
  }

  private async assertCompatibleAccount(owner: OwnerAccessRecord): Promise<void> {
    const user = (await this.users()).find(entry => entry.name === owner.username);
    if (user && !this.managed(user)) throw new LinuxOwnerError("DESTINATION_CONFLICT");
    if (!user && (await this.groups()).some(group => group.name === owner.username))
      throw new LinuxOwnerError("DESTINATION_CONFLICT");
    if (existsSync(`/home/${owner.username}`)) {
      const home = lstatSync(`/home/${owner.username}`);
      if (!home.isDirectory() || home.isSymbolicLink() || (user && home.uid !== 0 && home.uid !== user.uid))
        throw new LinuxOwnerError("DESTINATION_CONFLICT");
    }
  }

  private async removeManaged(username: string, recovering = false): Promise<void> {
    const user = (await this.users()).find(entry => entry.name === username);
    if (!user) return;
    if (!this.managed(user)) {
      // A rejected staged restore may name an unrelated account that was
      // never touched. Rollback must leave it alone and restore the real owner.
      if (recovering) return;
      throw new LinuxOwnerError("DESTINATION_CONFLICT");
    }
    // No --remove: rollback must not recursively delete files an owner created.
    await runSensitiveProcess({ command: "/usr/sbin/userdel", args: [username] });
    try {
      const home = lstatSync(user.home);
      if (home.isDirectory() && !home.isSymbolicLink() && home.uid === user.uid) {
        rmdirSync(user.home); // Empty failed-setup homes only; never recursive.
        fsyncDir("/home");
      }
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    const group = (await this.groups()).find(entry => entry.name === username);
    if (group && group.gid === user.gid && group.members.length === 0 && !(await this.users()).some(entry => entry.gid === user.gid)) {
      await runSensitiveProcess({ command: "/usr/sbin/groupdel", args: [username] });
    }
  }

  private managed(user: PasswdEntry): boolean {
    return TAG.test(user.comment) && user.uid >= 1000 && user.uid < 60000 && user.gid >= 1000
      && user.home === `/home/${user.name}` && user.shell === "/bin/bash";
  }

  private home(user: PasswdEntry): void {
    if (!existsSync(user.home)) { mkdirSync(user.home, { mode: 0o750 }); fsyncDir("/home"); }
    const info = lstatSync(user.home);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.uid !== 0 && info.uid !== user.uid)) throw new LinuxOwnerError("DESTINATION_CONFLICT");
    chownSync(user.home, user.uid, user.gid);
    chmodSync(user.home, 0o750);
    fsyncDir(user.home);
  }

  private directory(path: string, mode: number): void {
    if (!existsSync(path)) mkdirSync(path, { mode });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    chmodSync(path, mode);
  }

  private async ensureHostKey(): Promise<void> {
    if (!existsSync(HOST_KEY)) {
      const temporary = this.temporary("host-key-"); chmodSync(temporary, 0o700);
      try {
        const path = join(temporary, "host");
        await runSensitiveProcess({ command: "/usr/bin/ssh-keygen", args: ["-q", "-t", "ed25519", "-N", "", "-f", path] });
        writeFileDurable(HOST_KEY, readFileSync(path, "utf8"), 0o600);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    if (!regularRootFile(HOST_KEY) || (lstatSync(HOST_KEY).mode & 0o777) !== 0o600) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
    const pub = await this.output("/usr/bin/ssh-keygen", ["-y", "-f", HOST_KEY]);
    writeFileDurable(`${HOST_KEY}.pub`, pub.trim() + "\n", 0o644);
  }

  private async verifyPublicKeys(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const directory = this.temporary("public-keys-"); chmodSync(directory, 0o700);
    try {
      const path = join(directory, "key.pub");
      for (const key of keys) {
        const expected = validateOwnerPublicKey(key);
        writeFileDurable(path, expected.line + "\n", 0o600);
        const actual = await this.output("/usr/bin/ssh-keygen", ["-l", "-E", "sha256", "-f", path]);
        if (actual.trim().split(/\s+/)[1] !== expected.fingerprint) throw new LinuxOwnerError("POLICY_MISMATCH");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  private async verifyPolicies(owner: OwnerAccessRecord | null): Promise<void> {
    if (!regularRootFile(SSH_POLICY) || readFileSync(SSH_POLICY, "utf8") !== ownerSshPolicy(owner)) {
      throw new LinuxOwnerError("POLICY_MISMATCH");
    }
    await runSensitiveProcess({ command: "/usr/sbin/visudo", args: ["--check", "--strict", "--file", "/etc/sudoers"] });
    await runSensitiveProcess({ command: "/usr/sbin/sshd", args: ["-t"] });
    const policy = await this.output("/usr/sbin/sshd", ["-T", "-C", `user=${owner?.username ?? "root"},host=localhost,addr=127.0.0.1`]);
    const lines = new Set(policy.trim().split("\n"));
    for (const expected of ["permitrootlogin no", "permitemptypasswords no", "kbdinteractiveauthentication no", "pubkeyauthentication yes",
      `passwordauthentication ${owner?.sshPasswordAuthentication ? "yes" : "no"}`, `authorizedkeysfile ${KEY_DIRECTORY}/%u`]) {
      if (!lines.has(expected)) throw new LinuxOwnerError("POLICY_MISMATCH");
    }
    if (!lines.has(owner ? `allowusers ${owner.username}` : "denyusers *")) throw new LinuxOwnerError("POLICY_MISMATCH");
    if (owner) {
      const sudo = await this.output("/usr/bin/sudo", ["--list", "--other-user", owner.username]);
      if (sudo.includes("NOPASSWD:") || !sudo.includes("(ALL : ALL) ALL")) throw new LinuxOwnerError("POLICY_MISMATCH");
    }
  }

  private async users(): Promise<PasswdEntry[]> {
    return (await this.output("/usr/bin/getent", ["passwd"])).trim().split("\n").map(line => {
      const fields = line.split(":");
      if (fields.length !== 7 || !/^\d+$/.test(fields[2]!) || !/^\d+$/.test(fields[3]!)) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
      return { name: fields[0]!, uid: Number(fields[2]), gid: Number(fields[3]), comment: fields[4]!, home: fields[5]!, shell: fields[6]! };
    });
  }

  private async groups(): Promise<GroupEntry[]> {
    return (await this.output("/usr/bin/getent", ["group"])).trim().split("\n").map(line => {
      const fields = line.split(":");
      if (fields.length !== 4 || !/^\d+$/.test(fields[2]!)) throw new LinuxOwnerError("NATIVE_STATE_INVALID");
      return { name: fields[0]!, gid: Number(fields[2]), members: fields[3] ? fields[3].split(",") : [] };
    });
  }

  private temporary(prefix: string): string {
    this.directory("/run/yonder-admin", 0o700);
    return mkdtempSync(`/run/yonder-admin/${prefix}`);
  }

  private async output(command: string, args: string[]): Promise<string> {
    const result = await runSensitiveProcess({ command, args, maxOutputBytes: 256 * 1024 });
    try { return result.stdout.toString("utf8"); } finally { result.stdout.fill(0); }
  }
}
