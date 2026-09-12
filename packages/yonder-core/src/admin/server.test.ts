// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { DurableStateCoordinator, type CoordinatorBoundary } from "../state/coordinator.js";
import type { DurableState, OwnerAccessRecord, StateProjector } from "../state/types.js";
import type { OwnerNativeBackend } from "../owner-access/service.js";
import { AdminClient } from "./client.js";
import { createAdminServer } from "./server.js";

let root: string;
let socketPath: string;
let coordinator: DurableStateCoordinator;
let server: ReturnType<typeof createAdminServer> | undefined;
const clients: AdminClient[] = [];
let projectedOwner: OwnerAccessRecord | null;

const OWNER_HASH = `$y$j9T$${"a".repeat(22)}$${"b".repeat(43)}`;
const CHANGED_OWNER_HASH = `$y$j9T$${"a".repeat(22)}$${"c".repeat(43)}`;
const ownerProjector: StateProjector = {
  name: "linux-owner",
  sections: ["linuxOwner"],
  async apply({ next }) { projectedOwner = structuredClone(next.linuxOwner); },
  async verify({ expected }) { expect(projectedOwner).toEqual(expected.linuxOwner); },
};

function ownerBackend(overrides: Partial<OwnerNativeBackend> = {}): OwnerNativeBackend {
  return {
    async preflightCreate() {},
    async hashPassword() { return OWNER_HASH; },
    ...overrides,
  };
}

function initial(): DurableState {
  return { config: structuredClone(DEFAULT_CONFIG), secrets: { ap_psk: "test-passphrase" }, linuxOwner: null, zeroTier: null };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "yonder-admin-"));
  socketPath = join(root, "control.sock");
  const etc = join(root, "etc");
  mkdirSync(etc);
  projectedOwner = null;
  coordinator = new DurableStateCoordinator({
    root: join(root, "state", "transactions"),
    configPath: join(etc, "config.yaml"),
    secretsPath: join(etc, "secrets.yaml"),
    bootstrap: async () => initial(),
    projectors: [ownerProjector],
  });
  await coordinator.recover();
  server = createAdminServer({ coordinator, socketPath });
  if (!server.listening) await once(server, "listening");
  await new Promise<void>((resolve) => setImmediate(resolve));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function client(): AdminClient {
  const value = new AdminClient(socketPath);
  clients.push(value);
  return value;
}

async function restartServerWithOwner(
  backend: OwnerNativeBackend,
  onBoundary?: (boundary: CoordinatorBoundary) => void,
): Promise<void> {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  if (onBoundary) {
    coordinator = new DurableStateCoordinator({
      root: join(root, "state", "transactions"),
      configPath: join(root, "etc", "config.yaml"),
      secretsPath: join(root, "etc", "secrets.yaml"),
      bootstrap: async () => initial(),
      projectors: [ownerProjector],
      onBoundary,
    });
    await coordinator.recover();
  }
  server = createAdminServer({ coordinator, socketPath, ownerBackend: backend });
  if (!server.listening) await once(server, "listening");
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe("root admin socket", () => {
  it("fails closed with a fixed error when no owner backend is registered", async () => {
    const remote = client();
    await expect(remote.ownerState()).rejects.toMatchObject({
      code: "OWNER_UNAVAILABLE",
      message: "Linux owner access is unavailable",
    });
  });

  it("returns only the public owner projection and preserves unrelated secrets", async () => {
    let hashCalls = 0;
    await restartServerWithOwner(ownerBackend({
      async hashPassword() { hashCalls += 1; return hashCalls === 1 ? OWNER_HASH : CHANGED_OWNER_HASH; },
    }));
    const password = "owner-password-private";
    const remote = client();
    const created = await remote.createOwner({ username: "pilot", newPassword: password, confirmPassword: password });
    expect(created).toEqual({
      configured: true,
      username: "pilot",
      sshEnabled: false,
      sshPasswordAuthentication: false,
      authorizedKeyFingerprints: [],
    });
    await expect(remote.configureOwnerSsh({
      enabled: true,
      passwordAuthentication: true,
      authorizedKeys: [],
    })).resolves.toMatchObject({ sshEnabled: true, sshPasswordAuthentication: true });
    await expect(remote.changeOwnerPassword({
      newPassword: "replacement-password-private",
      confirmPassword: "replacement-password-private",
    })).resolves.toMatchObject({ configured: true, username: "pilot" });
    const publicJson = JSON.stringify(await remote.ownerState());
    expect(publicJson).not.toContain(password);
    expect(publicJson).not.toContain(OWNER_HASH);
    expect(publicJson).not.toContain("test-passphrase");
    const lease = await coordinator.beginSnapshot({ id: randomUUID() });
    expect(lease.snapshot.state.secrets).toEqual({ ap_psk: "test-passphrase" });
    expect(lease.snapshot.state.linuxOwner?.passwordHash).toBe(CHANGED_OWNER_HASH);
    await lease.release();
  });

  it("registers an owner transaction before native work so another client sees busy", async () => {
    const started = deferred();
    const release = deferred();
    await restartServerWithOwner(ownerBackend({
      async hashPassword() { started.resolve(); await release.promise; return OWNER_HASH; },
    }));
    const password = "owner-password-private";
    const first = client().createOwner({ username: "pilot", newPassword: password, confirmPassword: password });
    await started.promise;
    await expect(client().createOwner({ username: "copilot", newPassword: password, confirmPassword: password }))
      .rejects.toMatchObject({ code: "STATE_BUSY" });
    release.resolve();
    await expect(first).resolves.toMatchObject({ configured: true, username: "pilot" });
  });

  it("rolls back an owner transaction when its connection closes during native work", async () => {
    const started = deferred();
    const release = deferred();
    let hashes = 0;
    await restartServerWithOwner(ownerBackend({
      async hashPassword() {
        hashes += 1;
        if (hashes === 1) { started.resolve(); await release.promise; }
        return OWNER_HASH;
      },
    }));
    const password = "owner-password-private";
    const abandoned = client();
    const pending = abandoned.createOwner({ username: "pilot", newPassword: password, confirmPassword: password });
    const rejected = expect(pending).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    await started.promise;
    abandoned.close();
    // Let the peer-close event reach the server while native work is still
    // blocked; completing first would be a successful operation with a lost
    // reply, not a disconnect during the operation.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release.resolve();
    await rejected;

    const observer = client();
    for (let attempt = 0; attempt < 50 && (await observer.status()).operation !== null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await observer.status()).operation).toBeNull();
    expect(await observer.ownerState()).toMatchObject({ configured: false });
    await expect(observer.createOwner({ username: "copilot", newPassword: password, confirmPassword: password }))
      .resolves.toMatchObject({ configured: true, username: "copilot" });
  });

  it("recovers a durable unknown outcome and returns only its operation id", async () => {
    let receiptFailures = 2;
    await restartServerWithOwner(ownerBackend(), (boundary) => {
      if (boundary === "receipt.committed" && receiptFailures-- > 0) throw new Error("private receipt failure");
    });
    const password = "owner-password-private";
    let failure: unknown;
    try {
      await client().createOwner({ username: "pilot", newPassword: password, confirmPassword: password });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "OWNER_OUTCOME_UNKNOWN", operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(JSON.stringify(failure)).not.toContain(password);
    expect(JSON.stringify(failure)).not.toContain(OWNER_HASH);
    expect((await client().status()).operation).toBeNull();
    expect(await client().ownerState()).toMatchObject({ configured: true, username: "pilot" });
  });

  it("redacts arbitrary native diagnostics", async () => {
    const password = "owner-password-private";
    await restartServerWithOwner(ownerBackend({
      async hashPassword(value) { throw new Error(`hash failed for ${value} with ${OWNER_HASH}`); },
    }));
    let failure: unknown;
    try {
      await client().createOwner({ username: "pilot", newPassword: password, confirmPassword: password });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "INTERNAL", message: "admin operation failed" });
    expect(JSON.stringify(failure)).not.toContain(password);
    expect(JSON.stringify(failure)).not.toContain(OWNER_HASH);
    expect((await client().status()).operation).toBeNull();
  });

  it("creates a private socket and completes a state transaction through typed RPC", async () => {
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const remote = client();
    const before = await remote.status();
    const transaction = await remote.begin({ id: randomUUID(), kind: "config-apply", expectedActiveGeneration: before.activeGeneration });
    const next = structuredClone(transaction.previous.state);
    next.config.system.hostname = "yonder-admin-test";
    next.secrets = { ...next.secrets, admin_password: "stored-password-hash" };
    const staged = await transaction.stage(next);
    await transaction.activate();
    await transaction.commit();
    expect((await remote.status()).activeGeneration).toBe(staged.generation);
    expect(parse(readFileSync(join(root, "etc", "config.yaml"), "utf8")).system.hostname)
      .toBe("yonder-admin-test");
  });

  it("serializes writers across independent processes represented by clients", async () => {
    const first = client();
    const second = client();
    const transaction = await first.begin({ id: randomUUID(), kind: "restore" });
    await expect(second.begin({ id: randomUUID(), kind: "owner-access" }))
      .rejects.toMatchObject({ code: "STATE_BUSY" });
    const leakedId = (await second.status()).operation?.id;
    expect(leakedId).toBe(transaction.id);
    await expect(second.call("state.activate", { id: leakedId }))
      .rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
    await expect(second.recover()).rejects.toMatchObject({ code: "STATE_BUSY" });
    await transaction.rollback("test-finished");
  });

  it("recovers an abandoned writer after its connection closes", async () => {
    const abandoned = client();
    const transaction = await abandoned.begin({ id: randomUUID(), kind: "config-apply" });
    const next = structuredClone(transaction.previous.state);
    next.config.system.hostname = "yonder-must-rollback";
    await transaction.stage(next);
    await transaction.activate();
    abandoned.close();

    const observer = client();
    let status;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        status = await observer.status();
        if (status.operation === null) break;
      } catch { /* recovery owns the mutex briefly */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(status?.operation).toBeNull();
    expect(parse(readFileSync(join(root, "etc", "config.yaml"), "utf8")).system.hostname)
      .toBe(initial().config.system.hostname);
  });

  it("releases snapshot leases on disconnect", async () => {
    const snapshotClient = client();
    await snapshotClient.beginSnapshot({ id: randomUUID() });
    snapshotClient.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const writer = client();
    const transaction = await writer.begin({ id: randomUUID(), kind: "restore" });
    await transaction.rollback("test-finished");
  });

  it("resolves a lost commit reply by operation id without repeating the mutation", async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    let dropReply = false;
    let losingClient: AdminClient | undefined;
    coordinator = new DurableStateCoordinator({
      root: join(root, "state", "transactions"),
      configPath: join(root, "etc", "config.yaml"),
      secretsPath: join(root, "etc", "secrets.yaml"),
      bootstrap: async () => initial(),
      onBoundary: (boundary) => {
        if (dropReply && boundary === "operation.committed") losingClient?.close();
      },
    });
    await coordinator.recover();
    server = createAdminServer({ coordinator, socketPath });
    if (!server.listening) await once(server, "listening");
    await new Promise<void>((resolve) => setImmediate(resolve));

    losingClient = client();
    const operationId = randomUUID();
    const transaction = await losingClient.begin({ id: operationId, kind: "restore" });
    const next = structuredClone(transaction.previous.state);
    next.config.system.hostname = "yonder-response-lost";
    const staged = await transaction.stage(next);
    await transaction.activate();
    dropReply = true;
    await expect(transaction.commit()).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });

    const retry = client();
    await expect(retry.call("state.commit", { id: operationId })).resolves.toEqual({ generation: staged.generation });
    expect((await retry.status()).activeGeneration).toBe(staged.generation);
  });

  it.skipIf(process.platform !== "linux" || process.geteuid?.() !== 0)(
    "denies an unprivileged Linux process at the filesystem boundary",
    async () => {
      const script = `const net=require('node:net');const s=net.createConnection(${JSON.stringify(socketPath)});s.on('connect',()=>process.exit(2));s.on('error',()=>process.exit(0));`;
      const child = spawn(process.execPath, ["-e", script], { uid: 65534, gid: 65534, stdio: "ignore" });
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
    },
  );
});
