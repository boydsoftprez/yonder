// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { DurableStateCoordinator } from "../state/coordinator.js";
import type { DurableState } from "../state/types.js";
import { exportRecoveryArchive } from "./export.js";
import { RecoveryImportError, RecoveryImportStore } from "./import.js";
import { encodeRecoveryArchive } from "./schema.js";
import { RecoveryService } from "./service.js";
import type { ZeroTierState } from "./zerotier.js";

const source = { version: "2026.9.0", board: "radxa-zero3w" as const, configSchemaVersion: 1 as const };
const session = "session_owner_123456";
const runtime = "11111111-1111-4111-8111-111111111111";
const restartedRuntime = "22222222-2222-4222-8222-222222222222";

function state(): DurableState {
  return { config: structuredClone(DEFAULT_CONFIG), secrets: { admin_password: "private-admin-fixture" },
    linuxOwner: null, zeroTier: null };
}

async function fixture(now = () => 1_000) {
  const root = mkdtempSync(join(tmpdir(), "yonder-recovery-test-"));
  const config = join(root, "config.yaml"), secrets = join(root, "secrets.yaml"), imports = join(root, "imports");
  writeFileSync(config, stringify(DEFAULT_CONFIG), { mode: 0o644 });
  writeFileSync(secrets, stringify({ admin_password: "private-admin-fixture" }), { mode: 0o600 });
  mkdirSync(imports, { mode: 0o700 }); chmodSync(imports, 0o700);
  const coordinator = new DurableStateCoordinator({ root: join(root, "transactions"), configPath: config,
    secretsPath: secrets, bootstrap: async () => state() });
  await coordinator.recover();
  const zeroTier = { capture: async () => null, validate: async (value: ZeroTierState) => value };
  const store = new RecoveryImportStore(imports, now, 10 * 60_000);
  const reconcileDestination = async ({ incoming }: { incoming: DurableState }) => ({
    state: incoming,
    compatibility: { unavailableCameras: 0, unavailableUarts: 0,
      unavailableNetworkInterfaces: 0, apFallbackReachable: true as const },
  });
  return { root, coordinator, zeroTier, store,
    reconcileDestination,
    service: new RecoveryService({ coordinator, zeroTier, imports: store, source,
      currentVersion: source.version, now, reconcileDestination }) };
}

describe("recovery export and transactional import", () => {
  it("exports exactly one leased generation and refuses stale external mesh state", async () => {
    const f = await fixture();
    const bytes = await f.service.export();
    expect(bytes.toString()).not.toContain("undefined");
    await expect(exportRecoveryArchive({ coordinator: f.coordinator, source,
      zeroTier: { capture: async () => ({ identitySecret: "private", identityPublic: "public", memberships: [] }) } }))
      .rejects.toThrow();
  });

  it("binds a ten-minute preview to its session and destination generation", async () => {
    let now = 10_000;
    const f = await fixture(() => now);
    const incoming = state(); incoming.config.system.hostname = "restored-host";
    incoming.secrets = { admin_password: "restored-private-secret" };
    const preview = await f.service.preview({ bytes: encodeRecoveryArchive(incoming, source), sessionId: session });
    expect(preview.expiresAt).toBe(now + 10 * 60_000);
    expect(preview.remainingMs).toBe(10 * 60_000);
    expect(JSON.stringify(preview)).not.toContain("restored-private-secret");
    expect(preview.summary).toMatchObject({ replacesDeviceCredentials: true, membershipCount: 0 });
    expect(() => f.store.claim({ restoreId: preview.restoreId, sessionId: "another_session_1234",
      destinationGeneration: preview.destinationGeneration, currentVersion: source.version }))
      .toThrow("another session");
    expect(f.store.claim({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, currentVersion: source.version }).archive.payload.config.system.hostname)
      .toBe("restored-host");
    now = preview.expiresAt;
    expect(() => f.store.claim({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, currentVersion: source.version }))
      .toThrow("expired");
  });

  it("commits a reviewed state, consumes the preview, and holds for runtime restart", async () => {
    const f = await fixture();
    const incoming = state(); incoming.config.system.hostname = "restored-host";
    incoming.secrets = { admin_password: "restored-private-secret" };
    const service = new RecoveryService({ coordinator: f.coordinator, zeroTier: f.zeroTier, imports: f.store,
      source, currentVersion: source.version, reconcileDestination: f.reconcileDestination,
    });
    const preview = await service.preview({ bytes: encodeRecoveryArchive(incoming, source), sessionId: session });
    await expect(service.commit({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, runtimeGeneration: runtime, confirm: false })).rejects.toThrow("confirmation");
    const result = await service.commit({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, runtimeGeneration: runtime, confirm: true });
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await f.coordinator.readActiveState()).state).toEqual(incoming);
    expect((await f.coordinator.status()).operation).toMatchObject({ id: result.operationId,
      phase: "committed-awaiting-runtime-handoff" });
    await f.coordinator.acknowledgeRuntimeHandoff({ operationId: result.operationId,
      generation: result.generation, runtimeGeneration: restartedRuntime });
    expect(() => f.store.claim({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, currentVersion: source.version })).toThrow("unavailable");
  });

  it("invalidates and removes a preview if destination state changes", async () => {
    const f = await fixture();
    const incoming = state(); incoming.config.system.hostname = "restored-host";
    const preview = await f.service.preview({ bytes: encodeRecoveryArchive(incoming, source), sessionId: session });
    const tx = await f.coordinator.begin({ id: crypto.randomUUID(), kind: "config-apply" });
    const changed = structuredClone(tx.previous.state); changed.config.system.hostname = "changed-after-preview";
    await tx.stage(changed); await tx.activate(); await tx.commit();
    await expect(f.service.commit({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, runtimeGeneration: runtime, confirm: true }))
      .rejects.toMatchObject<Partial<RecoveryImportError>>({ code: "RESTORE_STALE" });
    expect(() => readFileSync(join(f.root, "imports", `restore-${preview.restoreId}.json`))).toThrow();
  });

  it("requires a trusted destination reconciler even for the same board", async () => {
    const f = await fixture();
    const service = new RecoveryService({ coordinator: f.coordinator, zeroTier: f.zeroTier,
      imports: f.store, source, currentVersion: source.version });
    await expect(service.preview({ bytes: encodeRecoveryArchive(state(), source), sessionId: session }))
      .rejects.toMatchObject({ code: "RECOVERY_UNAVAILABLE" });
  });

  it("reconciles cross-board hardware at preview and repeats the exact result under the commit guard", async () => {
    const f = await fixture();
    const other = { ...source, board: "rpi" as const };
    let calls = 0;
    const service = new RecoveryService({ coordinator: f.coordinator, zeroTier: f.zeroTier,
      imports: f.store, source, currentVersion: source.version,
      reconcileDestination: async ({ incoming, source: observed }) => {
        calls += 1;
        expect(observed.board).toBe("rpi");
        const prepared = structuredClone(incoming);
        prepared.config.cameras = [];
        return { state: prepared, compatibility: { unavailableCameras: 1, unavailableUarts: 0,
          unavailableNetworkInterfaces: 0, apFallbackReachable: true } };
      },
    });
    const incoming = state();
    const preview = await service.preview({ bytes: encodeRecoveryArchive(incoming, other), sessionId: session });
    expect(preview.summary.compatibility).toEqual({ adjusted: false, crossBoard: true,
      unavailableCameras: 1, unavailableUarts: 0, unavailableNetworkInterfaces: 0, apFallbackReachable: true });
    expect(preview.summary.warnings).toContain(
      "Setup AP and fallback remain enabled; unavailable hardware will not start automatically.",
    );
    const result = await service.commit({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, runtimeGeneration: runtime, confirm: true });
    expect(calls).toBe(2);
    await f.coordinator.acknowledgeRuntimeHandoff({ operationId: result.operationId,
      generation: result.generation, runtimeGeneration: restartedRuntime });
  });

  it("invalidates preview when repeated destination reconciliation changes", async () => {
    const f = await fixture();
    let calls = 0;
    const service = new RecoveryService({ coordinator: f.coordinator, zeroTier: f.zeroTier,
      imports: f.store, source, currentVersion: source.version,
      reconcileDestination: async ({ incoming }) => {
        const prepared = structuredClone(incoming);
        if (++calls > 1) prepared.config.system.hostname = "hardware-changed";
        return { state: prepared, compatibility: { unavailableCameras: 0, unavailableUarts: 0,
          unavailableNetworkInterfaces: 0, apFallbackReachable: true } };
      },
    });
    const preview = await service.preview({ bytes: encodeRecoveryArchive(state(), source), sessionId: session });
    await expect(service.commit({ restoreId: preview.restoreId, sessionId: session,
      destinationGeneration: preview.destinationGeneration, runtimeGeneration: runtime, confirm: true }))
      .rejects.toMatchObject({ code: "RESTORE_STALE" });
    expect((await f.coordinator.status()).operation).toBeNull();
  });
});
