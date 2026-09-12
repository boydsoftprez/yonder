// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { DurableStateCoordinator } from "../state/coordinator.js";
import type { DurableState, StateCoordinator } from "../state/types.js";
import {
  bootstrapWithZeroTier,
  validateCanonicalZeroTierState,
  ZeroTierRecoveryError,
  ZeroTierStateAdapter,
  zeroTierStateForConfig,
  reconcileZeroTierBootstrap,
  type ZeroTierNative,
  type ZeroTierState,
} from "./zerotier.js";

const OPERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NET_A = "aaaaaaaaaaaaaaaa", NET_B = "bbbbbbbbbbbbbbbb";

function durable(zeroTier: ZeroTierState | null): DurableState {
  return { config: structuredClone(DEFAULT_CONFIG), secrets: {}, linuxOwner: null, zeroTier };
}

function fixture(input: { active?: boolean; enabled?: boolean; state?: ZeroTierState | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "yonder-zt-test-"));
  const stateDirectory = join(root, "state"), scratchDirectory = join(root, "scratch"), bin = join(root, "bin");
  mkdirSync(stateDirectory, { mode: 0o700 }); mkdirSync(scratchDirectory, { mode: 0o700 }); mkdirSync(bin, { mode: 0o700 });
  for (const name of ["idtool", "cli", "systemctl", "env"]) writeFileSync(join(bin, name), "fixture", { mode: 0o700 });
  let active = input.active ?? false, enabled = input.enabled ?? false, failList = false;
  const calls: string[] = [];
  const write = (state: ZeroTierState) => {
    writeFileSync(join(stateDirectory, "identity.secret"), state.identitySecret, { mode: 0o600 });
    chmodSync(join(stateDirectory, "identity.secret"), 0o600);
    writeFileSync(join(stateDirectory, "identity.public"), state.identityPublic, { mode: 0o644 });
    chmodSync(join(stateDirectory, "identity.public"), 0o644);
    const networks = join(stateDirectory, "networks.d");
    if (!readdirSync(stateDirectory).includes("networks.d")) mkdirSync(networks, { mode: 0o700 });
    for (const item of state.memberships) writeFileSync(join(networks, `${item.networkId}.conf`), "", { mode: 0o600 });
  };
  if (input.state) write(input.state);
  const native: ZeroTierNative = { async run(rawCommand, rawArgs) {
    let command = rawCommand, args = rawArgs;
    if (command.endsWith("env")) { command = args[1]!; args = args.slice(2); }
    calls.push(`${command.split("/").at(-1)} ${args.join(" ")}`);
    if (command.endsWith("systemctl")) {
      if (args[0] === "show") return Buffer.from(args.includes("--property=ActiveState") ? (active ? "active\n" : "inactive\n") : (enabled ? "enabled\n" : "disabled\n"));
      if (args[0] === "stop") active = false;
      if (args[0] === "start") active = true;
      if (args[0] === "enable") enabled = true;
      if (args[0] === "disable") enabled = false;
      return Buffer.alloc(0);
    }
    if (command.endsWith("idtool")) {
      if (args[0] === "generate") {
        writeFileSync(args[1]!, "secret-generated", { mode: 0o600 });
        writeFileSync(args[2]!, "public-generated", { mode: 0o600 });
      }
      if (args[0] === "getpublic") {
        const value = readFileSync(args[1]!, "utf8");
        return Buffer.from(value.replace("secret", "public"));
      }
      return Buffer.alloc(0);
    }
    if (command.endsWith("cli")) {
      if (failList) throw new Error("private native output: secret-a");
      const networks = join(stateDirectory, "networks.d");
      const list = (readdirSync(stateDirectory).includes("networks.d") ? readdirSync(networks) : [])
        .filter(name => /^[0-9a-f]{16}\.conf$/.test(name))
        .map(name => ({ nwid: name.slice(0, 16) }));
      return Buffer.from(JSON.stringify(list));
    }
    throw new Error("unexpected command");
  } };
  const adapter = new ZeroTierStateAdapter({ stateDirectory, scratchDirectory,
    idtoolPath: join(bin, "idtool"), cliPath: join(bin, "cli"), systemctlPath: join(bin, "systemctl"),
    envPath: join(bin, "env"), native, clientWaitMs: 0 });
  return { root, stateDirectory, adapter, calls, service: () => ({ active, enabled }), failList() { failList = true; } };
}

describe("ZeroTier durable-state adapter", () => {
  const stateA: ZeroTierState = { identitySecret: "secret-a", identityPublic: "public-a", memberships: [{ networkId: NET_A }] };

  it("stops the live writer for capture and restores enabled and active independently", async () => {
    const f = fixture({ state: stateA, active: true, enabled: false });
    expect(await f.adapter.capture()).toEqual(stateA);
    expect(f.service()).toEqual({ active: true, enabled: false });
    expect(f.calls).toContain("systemctl stop zerotier-one.service");
    expect(f.calls).toContain("systemctl start zerotier-one.service");
  });

  it("restores the service after an invalid or partial identity", async () => {
    const f = fixture({ active: true, enabled: true });
    writeFileSync(join(f.stateDirectory, "identity.secret"), "secret-a", { mode: 0o600 });
    await expect(f.adapter.capture()).rejects.toMatchObject({ code: "ZEROTIER_IDENTITY_INVALID" });
    expect(f.service()).toEqual({ active: true, enabled: true });
  });

  it("refuses a membership set that has no identity without deleting it", async () => {
    const f = fixture({ active: false, enabled: false });
    const networks = join(f.stateDirectory, "networks.d");
    mkdirSync(networks, { mode: 0o700 });
    writeFileSync(join(networks, `${NET_A}.conf`), "", { mode: 0o600 });
    await expect(f.adapter.capture()).rejects.toMatchObject({ code: "ZEROTIER_STATE_INVALID" });
    expect(readdirSync(networks)).toEqual([`${NET_A}.conf`]);
  });

  it("does not erase an unreadable live identity when projection cannot capture rollback state", async () => {
    const f = fixture({ active: true, enabled: true });
    writeFileSync(join(f.stateDirectory, "identity.secret"), "secret-unrecoverable", { mode: 0o600 });
    const next = { identitySecret: "secret-b", identityPublic: "public-b", memberships: [{ networkId: NET_B }] };
    await expect(f.adapter.apply({ operationId: OPERATION, previous: durable(null), next: durable(next), context: "activation" }))
      .rejects.toMatchObject({ code: "ZEROTIER_IDENTITY_INVALID" });
    expect(readFileSync(join(f.stateDirectory, "identity.secret"), "utf8")).toBe("secret-unrecoverable");
    expect(f.service()).toEqual({ active: true, enabled: true });
  });

  it.each([
    ["identity secret", false, []],
    ["identity pair", true, []],
    ["first membership", true, [NET_A]],
  ])("repairs an owned projection cut after the %s during authoritative recovery", async (_boundary, publicWritten, memberships) => {
    const f = fixture({ active: false, enabled: false });
    const target = { identitySecret: "secret-a", identityPublic: "public-a",
      memberships: [{ networkId: NET_A }, { networkId: NET_B }] };
    writeFileSync(join(f.stateDirectory, "identity.secret"), target.identitySecret, { mode: 0o600 });
    chmodSync(join(f.stateDirectory, "identity.secret"), 0o600);
    if (publicWritten) {
      writeFileSync(join(f.stateDirectory, "identity.public"), target.identityPublic, { mode: 0o644 });
      chmodSync(join(f.stateDirectory, "identity.public"), 0o644);
    }
    if (memberships.length > 0) {
      const networks = join(f.stateDirectory, "networks.d"); mkdirSync(networks, { mode: 0o700 });
      for (const networkId of memberships) writeFileSync(join(networks, `${networkId}.conf`), "", { mode: 0o600 });
    }
    await f.adapter.apply({ operationId: OPERATION, previous: durable(target), next: durable(target), context: "recovery" });
    expect(readFileSync(join(f.stateDirectory, "identity.secret"), "utf8")).toBe(target.identitySecret);
    expect(readFileSync(join(f.stateDirectory, "identity.public"), "utf8")).toBe(target.identityPublic);
    expect(readdirSync(join(f.stateDirectory, "networks.d")).filter(name => name.endsWith(".conf")).sort())
      .toEqual([`${NET_A}.conf`, `${NET_B}.conf`]);
    expect(f.service()).toEqual({ active: true, enabled: true });
  });

  it("refuses to treat an unrelated broken symlink as an owned partial projection", async () => {
    const f = fixture({ active: false, enabled: false });
    const target = { identitySecret: "secret-a", identityPublic: "public-a", memberships: [{ networkId: NET_A }] };
    symlinkSync("/not-a-real-yonder-identity", join(f.stateDirectory, "identity.secret"));
    await expect(f.adapter.apply({ operationId: OPERATION, previous: durable(target), next: durable(target), context: "recovery" }))
      .rejects.toMatchObject({ code: "ZEROTIER_STATE_INVALID" });
    expect(lstatSync(join(f.stateDirectory, "identity.secret")).isSymbolicLink()).toBe(true);
    expect(f.service()).toEqual({ active: false, enabled: false });
  });

  it("restores the old identity, memberships, enabled state and active state when verification fails", async () => {
    const f = fixture({ state: stateA, active: true, enabled: false });
    const stateB = { identitySecret: "secret-b", identityPublic: "public-b", memberships: [{ networkId: NET_B }] };
    f.failList();
    let failure: unknown;
    try { await f.adapter.apply({ operationId: OPERATION, previous: durable(stateA), next: durable(stateB), context: "activation" }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ZeroTierRecoveryError);
    expect(String(failure)).not.toContain("private native output");
    expect(String(failure)).not.toContain("secret-a");
    expect(f.service()).toEqual({ active: true, enabled: false });
    expect(readFileSync(join(f.stateDirectory, "identity.secret"), "utf8")).toBe("secret-a");
    expect(readdirSync(join(f.stateDirectory, "networks.d")).filter(name => name.endsWith(".conf"))).toEqual([`${NET_A}.conf`]);
    expect(JSON.stringify(f.calls)).not.toContain("private native output");
  });

  it("treats null as a conservative non-destructive migration state", async () => {
    const f = fixture({ state: stateA });
    await f.adapter.apply({ operationId: OPERATION, previous: durable(null), next: durable(null), context: "activation" });
    expect(readFileSync(join(f.stateDirectory, "identity.secret"), "utf8")).toBe("secret-a");
  });

  it("generates an offline identity for an empty fresh install without starting the service", async () => {
    const f = fixture({ active: false, enabled: false });
    const result = await bootstrapWithZeroTier(async () => durable(null), f.adapter)();
    expect(result.zeroTier).toEqual({ identitySecret: "secret-generated", identityPublic: "public-generated", memberships: [] });
    expect(f.service()).toEqual({ active: false, enabled: false });
  });

  it("adds the configured membership to a freshly generated bootstrap identity", async () => {
    const f = fixture();
    const initial = durable(null);
    initial.config.remote.zerotier = { enabled: true, network_id: NET_A };
    const result = await bootstrapWithZeroTier(async () => initial, f.adapter)();
    expect(result.zeroTier?.memberships).toEqual([{ networkId: NET_A }]);
    expect(f.service()).toEqual({ active: false, enabled: false });
  });

  it("migrates an already-published null generation before the admin socket is exposed", async () => {
    const f = fixture({ state: stateA });
    const configPath = join(f.root, "config.yaml"), secretsPath = join(f.root, "secrets.yaml");
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG)); writeFileSync(secretsPath, "{}", { mode: 0o600 });
    const projector = { name: "fixture-zerotier", sections: ["zeroTier"] as const,
      async apply() {}, async verify() {} };
    const coordinator = new DurableStateCoordinator({ root: join(f.root, "transactions"), configPath, secretsPath,
      bootstrap: async () => durable(null), projectors: [projector] });
    await coordinator.recover();
    const result = await reconcileZeroTierBootstrap(coordinator, f.adapter);
    expect(result.changed).toBe(true);
    const lease = await coordinator.beginSnapshot({ id: crypto.randomUUID() });
    expect(lease.snapshot.state.zeroTier).toEqual(stateA);
    await lease.release();
  });

  it("does not quiesce or reserve state again after the one-time migration", async () => {
    const f = fixture({ state: stateA });
    const configPath = join(f.root, "config2.yaml"), secretsPath = join(f.root, "secrets2.yaml");
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG)); writeFileSync(secretsPath, "{}", { mode: 0o600 });
    const coordinator = new DurableStateCoordinator({ root: join(f.root, "transactions2"), configPath, secretsPath,
      bootstrap: async () => durable(stateA), projectors: [{ name: "zt", sections: ["zeroTier"], async apply() {}, async verify() {} }] });
    await coordinator.recover();
    let captures = 0;
    const result = await reconcileZeroTierBootstrap(coordinator, { async capture() { captures++; return stateA; } });
    expect(result.changed).toBe(false);
    expect(captures).toBe(0);
    expect((await coordinator.status()).operation).toBeNull();
  });

  it("leaves a null legacy state untouched while maintenance owns the operation guard", async () => {
    let began = false, captured = false;
    const coordinator = {
      async readActiveState() { return { generation: "generation", state: durable(null) }; },
      async status() { return { activeGeneration: "generation", operation: {
        id: OPERATION, kind: "maintenance" as const, phase: "awaiting-maintenance-reboot" as never,
      } }; },
      async begin() { began = true; throw new Error("must not begin"); },
    } as unknown as StateCoordinator;
    expect(await reconcileZeroTierBootstrap(coordinator, { async capture() { captured = true; return stateA; } }))
      .toEqual({ changed: false, generation: "generation" });
    expect({ began, captured }).toEqual({ began: false, captured: false });
  });

  it("preserves all memberships while changing only the config-owned membership", () => {
    const previous = durable({ ...stateA, memberships: [{ networkId: NET_A }, { networkId: NET_B }] });
    previous.config.remote.zerotier = { enabled: true, network_id: NET_A };
    const next = structuredClone(previous); next.config.remote.zerotier = { enabled: false, network_id: null };
    expect(zeroTierStateForConfig(next, previous).zeroTier?.memberships).toEqual([{ networkId: NET_B }]);
    expect(() => validateCanonicalZeroTierState({ ...stateA, memberships: [{ networkId: NET_B }, { networkId: NET_A }] }))
      .toThrow("safely read or projected");
  });
});
