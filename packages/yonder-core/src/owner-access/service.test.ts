// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { DurableStateCoordinator } from "../state/coordinator.js";
import type { OwnerAccessRecord, StateProjector } from "../state/types.js";
import { OwnerAccessService } from "./service.js";

let dir: string;
const nativeHash = (letter: string) => `$y$j9T$${"a".repeat(22)}$${letter.repeat(43)}`;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-owner-service-")); mkdirSync(join(dir, "etc")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  let projected: OwnerAccessRecord | null = null;
  let failProjection = false;
  let failAvailability = false;
  let hashCalls = 0;
  let failHash = false;
  const projector: StateProjector = {
    name: "linux-owner", sections: ["linuxOwner"],
    async apply({ next }) {
      projected = structuredClone(next.linuxOwner);
      if (failProjection) { failProjection = false; throw new Error("private native error"); }
    },
    async verify({ expected }) { expect(projected).toEqual(expected.linuxOwner); },
  };
  const options = {
    root: join(dir, "state"), configPath: join(dir, "etc/config.yaml"), secretsPath: join(dir, "etc/secrets.yaml"),
    bootstrap: async () => ({ config: structuredClone(DEFAULT_CONFIG), secrets: { admin_password: "console-hash-unchanged" }, linuxOwner: null, zeroTier: null }),
    projectors: [projector],
  };
  const coordinator = new DurableStateCoordinator(options);
  await coordinator.recover();
  const native = {
    async preflightCreate() { if (failAvailability) throw new Error("account collision"); },
    async hashPassword() { if (failHash) { failHash = false; throw new Error("native hashing unavailable"); } hashCalls++; return nativeHash(hashCalls === 1 ? "b" : "c"); },
  };
  return { coordinator, service: new OwnerAccessService(coordinator, native),
    get projected() { return projected; }, get hashCalls() { return hashCalls; },
    failHash() { failHash = true; }, failProjection() { failProjection = true; }, failAvailability() { failAvailability = true; },
    restarted() { return new DurableStateCoordinator(options); },
  };
}
const create = { username: "pilot", newPassword: "independent-password", confirmPassword: "independent-password" };

describe("owner service with the real durable coordinator", () => {
  it("creates one owner with SSH off, preserves console credentials and exposes no shadow hash", async () => {
    const f = await fixture();
    const result = await f.service.create(create);
    expect(result).toEqual({ configured: true, username: "pilot", sshEnabled: false, sshPasswordAuthentication: false, authorizedKeyFingerprints: [] });
    const lease = await f.coordinator.beginSnapshot({ id: randomUUID() });
    expect(lease.snapshot.state.secrets.admin_password).toBe("console-hash-unchanged");
    expect(lease.snapshot.state.linuxOwner?.passwordHash).toBe(nativeHash("b"));
    await lease.release();
    const restarted = f.restarted(); await restarted.recover();
    expect(f.projected?.username).toBe("pilot");
    expect(JSON.stringify(result)).not.toContain("passwordHash");
  });
  it("serializes simultaneous local/web create attempts and never replaces the winner", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.service.create(create), f.service.create({ ...create, username: "otherpilot" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(f.hashCalls).toBe(1);
    await expect(f.service.create(create)).rejects.toMatchObject({ code: "ALREADY_CONFIGURED" });
    expect(f.hashCalls).toBe(1);
    expect((await f.coordinator.status()).operation).toBeNull();
  });
  it("rolls back a failed native projection to the prior owner password and frees the guard", async () => {
    const f = await fixture(); await f.service.create(create);
    f.failProjection();
    await expect(f.service.changePassword({ newPassword: "replacement-password", confirmPassword: "replacement-password" }))
      .rejects.toMatchObject({ code: "PROJECTION_FAILED" });
    expect(f.projected?.passwordHash).toBe(nativeHash("b"));
    expect((await f.coordinator.status()).operation).toBeNull();
    await f.service.changePassword({ newPassword: "replacement-password", confirmPassword: "replacement-password" });
    expect(f.projected?.passwordHash).toBe(nativeHash("c"));
  });
  it("releases the guard after hashing fails before a generation is staged", async () => {
    const f = await fixture(); await f.service.create(create);
    f.failHash();
    await expect(f.service.changePassword({ newPassword: "replacement-password", confirmPassword: "replacement-password" }))
      .rejects.toThrow("native hashing unavailable");
    expect(f.projected?.passwordHash).toBe(nativeHash("b"));
    expect((await f.coordinator.status()).operation).toBeNull();
    await f.service.changePassword({ newPassword: "replacement-password", confirmPassword: "replacement-password" });
    expect(f.projected?.passwordHash).toBe(nativeHash("c"));
  });
  it("rejects destination collisions and password mismatches without creating an owner", async () => {
    const f = await fixture(); f.failAvailability();
    await expect(f.service.create(create)).rejects.toThrow("account collision");
    expect(f.hashCalls).toBe(0);
    expect(f.projected).toBeNull();
    expect((await f.coordinator.status()).operation).toBeNull();
    await expect(f.service.create({ ...create, confirmPassword: "different" })).rejects.toMatchObject({ code: "PASSWORD_MISMATCH" });
  });
  it("preserves stored keys when policy-only changes omit them, and clears only an explicit empty set", async () => {
    const f = await fixture(); await f.service.create(create);
    const jwk = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    const type = Buffer.from("ssh-ed25519"), key = Buffer.from(jwk.x!, "base64url");
    const field = (value: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]); };
    const line = "ssh-ed25519 " + Buffer.concat([field(type), field(key)]).toString("base64");
    await f.service.configureSsh({ enabled: true, passwordAuthentication: false, authorizedKeys: [line] });
    await f.service.configureSsh({ enabled: false, passwordAuthentication: true });
    expect(f.projected?.authorizedKeys).toEqual([line]);
    await f.service.configureSsh({ enabled: true, passwordAuthentication: true, authorizedKeys: [] });
    expect(f.projected?.authorizedKeys).toEqual([]);
  });
  it("permits owner-selected password SSH and rejects a policy with no login method", async () => {
    const f = await fixture(); await f.service.create(create);
    const result = await f.service.configureSsh({ enabled: true, passwordAuthentication: true, authorizedKeys: [] });
    expect(result.sshPasswordAuthentication).toBe(true);
    await expect(f.service.configureSsh({ enabled: true, passwordAuthentication: false, authorizedKeys: [] })).rejects.toMatchObject({ code: "RECORD" });
    expect(f.projected?.sshPasswordAuthentication).toBe(true);
    expect((await f.coordinator.status()).operation).toBeNull();
  });
});
