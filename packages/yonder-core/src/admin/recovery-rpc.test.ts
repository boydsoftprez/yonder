// SPDX-License-Identifier: GPL-3.0-or-later
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { RecoveryImportStore } from "../recovery/import.js";
import { RecoveryService } from "../recovery/service.js";
import { encodeRecoveryArchive } from "../recovery/schema.js";
import { DurableStateCoordinator } from "../state/coordinator.js";
import type { DurableState } from "../state/types.js";
import { AdminClient } from "./client.js";
import { createAdminServer, type RecoveryBackendFactory } from "./server.js";

const source = { version: "2026.9.0", board: "radxa-zero3w" as const, configSchemaVersion: 1 as const };
const session = "session_owner_123456";
const runtime = "11111111-1111-4111-8111-111111111111";
const restartedRuntime = "22222222-2222-4222-8222-222222222222";
const clients: AdminClient[] = [];
let root: string;
let socketPath: string;
let coordinator: DurableStateCoordinator;
let server: ReturnType<typeof createAdminServer>;

function initial(): DurableState {
  return { config: structuredClone(DEFAULT_CONFIG), secrets: { admin_password: "private-current" },
    linuxOwner: null, zeroTier: null };
}

function client(): AdminClient {
  const value = new AdminClient(socketPath, 2_000);
  clients.push(value);
  return value;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise(done => { resolve = done; }), resolve };
}

async function start(recoveryBackend?: RecoveryBackendFactory): Promise<void> {
  server = createAdminServer({ coordinator, socketPath, recoveryBackend });
  if (!server.listening) await once(server, "listening");
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "yonder-recovery-rpc-"));
  socketPath = join(root, "control.sock");
  const etc = join(root, "etc");
  mkdirSync(etc);
  writeFileSync(join(etc, "config.yaml"), stringify(DEFAULT_CONFIG));
  writeFileSync(join(etc, "secrets.yaml"), "{}", { mode: 0o600 });
  coordinator = new DurableStateCoordinator({ root: join(root, "state", "transactions"),
    configPath: join(etc, "config.yaml"), secretsPath: join(etc, "secrets.yaml"), bootstrap: async () => initial() });
  await coordinator.recover();
});

afterEach(async () => {
  for (const value of clients.splice(0)) value.close();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

function actualFactory(overrides: { capture?: () => Promise<null>; validate?: (value: never) => Promise<never> } = {}): RecoveryBackendFactory {
  const importsRoot = join(root, "imports");
  mkdirSync(importsRoot, { mode: 0o700 });
  const imports = new RecoveryImportStore(importsRoot);
  return bound => new RecoveryService({ coordinator: bound, imports, source, currentVersion: source.version,
    zeroTier: {
      capture: overrides.capture ?? (async () => null),
      validate: overrides.validate ?? (async value => value),
    },
    reconcileDestination: async ({ incoming }) => ({ state: incoming,
      compatibility: { unavailableCameras: 0, unavailableUarts: 0,
        unavailableNetworkInterfaces: 0, apFallbackReachable: true } }),
  });
}

describe("recovery admin RPC", () => {
  it("fails closed when no recovery service is registered", async () => {
    await start();
    await expect(client().exportRecovery()).rejects.toMatchObject({
      code: "RECOVERY_UNAVAILABLE", message: "Device recovery is unavailable",
    });
  });

  it("round trips binary archives through strict base64 and keeps secrets out of previews", async () => {
    await start(actualFactory());
    const remote = client();
    expect((await remote.exportRecovery()).byteLength).toBeGreaterThan(0);
    const incoming = initial();
    incoming.config.system.hostname = "restored-host";
    incoming.secrets = { admin_password: "private-restored" };
    const preview = await remote.previewRecovery({ bytes: encodeRecoveryArchive(incoming, source), sessionId: session });
    expect(JSON.stringify(preview)).not.toContain("private-restored");
    await expect(remote.commitRecovery({ restoreId: preview.restoreId, sessionId: "different_session_12",
      destinationGeneration: preview.destinationGeneration, runtimeGeneration: runtime, confirm: true }))
      .rejects.toMatchObject({ code: "RESTORE_SESSION_MISMATCH", message: "The restore preview belongs to another session" });
    await expect(remote.commitRecovery({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, runtimeGeneration: runtime, confirm: true })).resolves.toMatchObject({ generation: expect.any(String) });
    expect((await coordinator.readActiveState()).state).toEqual(incoming);
    const operation = (await remote.status()).operation!;
    await remote.acknowledgeRuntimeHandoff({ operationId: operation.id,
      generation: (await remote.readActiveState()).generation, runtimeGeneration: restartedRuntime });
    expect((await remote.status()).operation).toBeNull();
  });

  it("binds recovery transactions to their connection and recovers a disconnect", async () => {
    const entered = deferred(), release = deferred();
    await start(actualFactory({ capture: async () => { entered.resolve(); await release.promise; return null; } }));
    const abandoned = client();
    const pending = abandoned.exportRecovery();
    const rejected = expect(pending).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    await entered.promise;
    await expect(client().begin({ id: crypto.randomUUID(), kind: "restore" })).rejects.toMatchObject({ code: "STATE_BUSY" });
    abandoned.close();
    release.resolve();
    await rejected;
    const observer = client();
    for (let attempt = 0; attempt < 50 && (await observer.status()).operation !== null; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect((await observer.status()).operation).toBeNull();
  });
});
