// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { DEFAULT_CONFIG, type Config } from "../schema/config.js";
import {
  DurableStateCoordinator,
  StateCoordinatorError,
  type CoordinatorBoundary,
} from "./coordinator.js";
import type { DurableState, StateProjectionContext, StateProjector } from "./types.js";
import { MaintenanceTokenStore } from "../storage/maintenance.js";

let dir: string;
let transactionsRoot: string;
let configPath: string;
let secretsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-state-"));
  transactionsRoot = join(dir, "state", "transactions");
  configPath = join(dir, "etc", "config.yaml");
  secretsPath = join(dir, "etc", "secrets.yaml");
  mkdirSync(join(dir, "etc"), { recursive: true });
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function state(label = "old"): DurableState {
  const config = structuredClone(DEFAULT_CONFIG);
  config.system.hostname = `yonder-${label}`;
  return {
    config,
    secrets: { ap_psk: `${label}-access-point-passphrase` },
    linuxOwner: null,
    zeroTier: null,
  };
}

function changed(previous: DurableState, label = "new"): DurableState {
  const next = structuredClone(previous);
  next.config.system.hostname = `yonder-${label}`;
  next.secrets = { ...next.secrets, admin_password: `${label}-password-hash` };
  return next;
}

function coordinator(input: {
  initial?: DurableState;
  onBoundary?: (boundary: CoordinatorBoundary) => void;
  projectors?: StateProjector[];
  snapshotLeaseMs?: number;
  storageMode?: "protected" | "maintenance";
  assertStorage?: () => void;
} = {}): DurableStateCoordinator {
  const initial = input.initial ?? state();
  return new DurableStateCoordinator({
    root: transactionsRoot,
    configPath,
    secretsPath,
    bootstrap: async () => structuredClone(initial),
    onBoundary: input.onBoundary,
    projectors: input.projectors,
    snapshotLeaseMs: input.snapshotLeaseMs,
    maintenanceRoot: join(dir, "state", "maintenance"),
    observeStorageMode: () => input.storageMode ?? "protected",
    assertStorage: input.assertStorage,
  });
}

function projected(): { config: Config; secrets: Record<string, string> } {
  return {
    config: parse(readFileSync(configPath, "utf8")) as Config,
    secrets: parse(readFileSync(secretsPath, "utf8")) as Record<string, string>,
  };
}

describe("DurableStateCoordinator bootstrap", () => {
  it("publishes a complete private initial tree before applying fixed projections", async () => {
    let projectionSawPublishedTree = false;
    const probe: StateProjector = {
      name: "probe",
      sections: [],
      async apply() {
        projectionSawPublishedTree = existsSync(join(transactionsRoot, "ownership.json"))
          && existsSync(join(transactionsRoot, "active.json"));
      },
      async verify() {},
    };
    const c = coordinator({ projectors: [probe] });
    const recovered = await c.recover();

    expect(recovered.action).toBe("none");
    expect(projectionSawPublishedTree).toBe(true);
    expect((await c.status()).activeGeneration).toMatch(/^[0-9a-f-]{36}$/);
    expect(projected()).toEqual({ config: state().config, secrets: state().secrets });
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);
    expect((readFileSync(join(transactionsRoot, "ownership.json"), "utf8"))).not.toContain("passphrase");
  });

  it.each(["bootstrap.tree", "bootstrap.published"] as CoordinatorBoundary[])(
    "recovers a cut at %s without treating an abandoned bootstrap as owned corruption",
    async (boundary) => {
      let fired = false;
      const broken = coordinator({ onBoundary: (at) => {
        if (!fired && at === boundary) { fired = true; throw new Error("power cut"); }
      } });
      await expect(broken.recover()).rejects.toThrow("power cut");

      const restarted = coordinator();
      await expect(restarted.recover()).resolves.toMatchObject({ action: "none" });
      expect(projected()).toEqual({ config: state().config, secrets: state().secrets });
      expect(readdirSync(join(dir, "state")).filter((name) => name.startsWith(".transactions-bootstrap-"))).toEqual([]);
    },
  );

  it("distinguishes unreadable owned state from a fresh empty directory", async () => {
    mkdirSync(transactionsRoot, { recursive: true });
    writeFileSync(join(transactionsRoot, "ownership.json"), "not-json", { mode: 0o600 });
    const c = coordinator();
    await expect(c.recover()).rejects.toMatchObject({ code: "STATE_UNAVAILABLE" });
    expect(existsSync(configPath)).toBe(false);
  });

  it("permits a genuinely empty pre-created transaction directory to bootstrap", async () => {
    mkdirSync(transactionsRoot, { recursive: true });
    await expect(coordinator().recover()).resolves.toMatchObject({ action: "none" });
    expect(projected().config.system.hostname).toBe("yonder-old");
  });
});

describe("durable generations and recovery", () => {
  it("stages, activates, verifies and commits one complete generation", async () => {
    const c = coordinator();
    await c.recover();
    const before = await c.beginSnapshot({ id: crypto.randomUUID() });
    const oldGeneration = before.snapshot.generation;
    await before.release();
    const tx = await c.begin({ id: crypto.randomUUID(), kind: "config-apply", expectedActiveGeneration: oldGeneration });
    const wanted = changed(tx.previous.state);

    const staged = await tx.stage(wanted);
    expect(staged.generation).not.toBe(oldGeneration);
    await expect(tx.activate()).resolves.toEqual({ generation: staged.generation });
    expect(projected()).toEqual({ config: wanted.config, secrets: wanted.secrets });
    await expect(tx.commit()).resolves.toEqual({ generation: staged.generation });
    expect((await c.status()).operation).toBeNull();

    const restarted = coordinator({ initial: state("wrong-bootstrap") });
    await expect(restarted.recover()).resolves.toEqual({ selectedGeneration: staged.generation, action: "none" });
    expect(projected()).toEqual({ config: wanted.config, secrets: wanted.secrets });
  });

  it("rolls an activated but uncommitted generation back with matching secrets", async () => {
    const c = coordinator();
    await c.recover();
    const tx = await c.begin({ id: crypto.randomUUID(), kind: "config-apply" });
    const wanted = changed(tx.previous.state);
    await tx.stage(wanted);
    await tx.activate();
    await tx.holdForConfirmation();
    expect(projected().secrets).toEqual(wanted.secrets);

    const result = await tx.rollback("confirmation-expired");
    expect(result.generation).toBe(tx.previous.generation);
    expect(projected()).toEqual({ config: tx.previous.state.config, secrets: tx.previous.state.secrets });
  });

  const boundaries: { at: CoordinatorBoundary; outcome: "old" | "new" }[] = [
    { at: "operation.begin", outcome: "old" },
    { at: "generation.published", outcome: "old" },
    { at: "operation.staged", outcome: "old" },
    { at: "operation.activating", outcome: "old" },
    { at: "selection.activated", outcome: "old" },
    { at: "projection.config", outcome: "old" },
    { at: "projection.secrets", outcome: "old" },
    { at: "operation.committing", outcome: "old" },
    { at: "operation.committed", outcome: "new" },
    { at: "receipt.committed", outcome: "new" },
    { at: "operation.cleared", outcome: "new" },
  ];

  it.each(boundaries)("a restart at $at deterministically selects $outcome state", async ({ at, outcome }) => {
    let enabled = false;
    let fired = false;
    const c = coordinator({ onBoundary: (boundary) => {
      if (enabled && !fired && boundary === at) { fired = true; throw new Error("process killed"); }
    } });
    await c.recover();
    enabled = true;
    const old = state();
    let tx: Awaited<ReturnType<DurableStateCoordinator["begin"]>> | undefined;
    const wanted = changed(old);
    let interrupted = false;
    try {
      tx = await c.begin({ id: crypto.randomUUID(), kind: "config-apply" });
      await tx.stage(wanted);
      await tx.activate();
      await tx.commit();
    } catch {
      interrupted = true;
    }
    expect(interrupted).toBe(true);
    expect(fired).toBe(true);

    const restarted = coordinator();
    await restarted.recover();
    expect(projected()).toEqual(outcome === "new"
      ? { config: wanted.config, secrets: wanted.secrets }
      : { config: old.config, secrets: old.secrets });
  });

  it("regenerates a missing response-loss receipt from the committed decision", async () => {
    let failReceipt = true;
    const c = coordinator({ onBoundary: (boundary) => {
      if (failReceipt && boundary === "receipt.committed") throw new Error("receipt disk failed");
    } });
    await c.recover();
    const operationId = crypto.randomUUID();
    const tx = await c.begin({ id: operationId, kind: "config-apply" });
    const wanted = changed(tx.previous.state);
    const staged = await tx.stage(wanted);
    await tx.activate();
    await expect(tx.commit()).rejects.toThrow("receipt disk failed");

    failReceipt = false;
    const restarted = coordinator();
    await expect(restarted.recover()).resolves.toEqual({
      selectedGeneration: staged.generation,
      action: "kept-committed",
    });
    await expect(restarted.resolveOperation(operationId, "committed")).resolves.toEqual({ generation: staged.generation });
  });

  it("finalizes projector ownership only after the durable commit decision", async () => {
    const events: string[] = [];
    const projector: StateProjector = {
      name: "commit-probe",
      sections: [],
      async apply({ context }) { events.push(`apply:${context}`); },
      async verify() { events.push("verify"); },
      async finalizeCommit({ operationId, previous, next }) {
        expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(previous.config.system.hostname).toBe("yonder-old");
        expect(next.config.system.hostname).toBe("yonder-new");
        events.push("finalize");
      },
    };
    const c = coordinator({ projectors: [projector], onBoundary: boundary => events.push(boundary) });
    await c.recover();
    events.length = 0;
    const transaction = await c.begin({ id: crypto.randomUUID(), kind: "config-apply" });
    await transaction.stage(changed(transaction.previous.state));
    await transaction.activate();
    expect(events).not.toContain("finalize");
    await transaction.commit();

    expect(events.indexOf("operation.committed")).toBeLessThan(events.indexOf("finalize"));
    expect(events.indexOf("finalize")).toBeLessThan(events.indexOf("receipt.committed"));
  });

  it("retries a failed projector commit finalizer without reopening rollback", async () => {
    let attempts = 0;
    const projector: StateProjector = {
      name: "commit-probe",
      sections: [],
      async apply() {},
      async verify() {},
      async finalizeCommit() {
        attempts += 1;
        if (attempts === 1) throw new Error("finalizer interrupted");
      },
    };
    const c = coordinator({ projectors: [projector] });
    await c.recover();
    const transaction = await c.begin({ id: crypto.randomUUID(), kind: "config-apply" });
    const staged = await transaction.stage(changed(transaction.previous.state));
    await transaction.activate();
    await expect(transaction.commit()).rejects.toMatchObject({ code: "PROJECTION_FAILED" });
    await expect(transaction.rollback("too-late")).rejects.toMatchObject({ code: "OPERATION_OUTCOME" });
    await expect(transaction.commit()).resolves.toEqual({ generation: staged.generation });
    expect(attempts).toBe(2);
  });

  it("runs a pending projector commit finalizer during committed recovery", async () => {
    let fail = true;
    const finalized: string[] = [];
    const projector: StateProjector = {
      name: "commit-probe",
      sections: [],
      async apply() {},
      async verify() {},
      async finalizeCommit({ operationId }) {
        finalized.push(operationId);
        if (fail) throw new Error("process stopped in finalizer");
      },
    };
    const first = coordinator({ projectors: [projector] });
    await first.recover();
    const transaction = await first.begin({ id: crypto.randomUUID(), kind: "config-apply" });
    const staged = await transaction.stage(changed(transaction.previous.state));
    await transaction.activate();
    await expect(transaction.commit()).rejects.toMatchObject({ code: "PROJECTION_FAILED" });

    fail = false;
    const restarted = coordinator({ projectors: [projector] });
    await expect(restarted.recover()).resolves.toEqual({
      selectedGeneration: staged.generation,
      action: "kept-committed",
    });
    expect(finalized).toEqual([transaction.id, transaction.id]);
  });

  it("finalizes projector ownership before publishing a restart commit receipt", async () => {
    let finalized = false;
    const projector: StateProjector = {
      name: "restart-commit-probe",
      sections: [],
      async apply() {},
      async verify() {},
      async finalizeCommit() { finalized = true; },
    };
    let receiptSawFinalized = false;
    const c = coordinator({
      projectors: [projector],
      onBoundary(boundary) {
        if (boundary === "receipt.committed") receiptSawFinalized = finalized;
      },
    });
    await c.recover();
    const transaction = await c.begin({ id: crypto.randomUUID(), kind: "restore" });
    await transaction.stage(changed(transaction.previous.state));
    await transaction.activate();
    await transaction.commitForRestart(crypto.randomUUID());

    expect(receiptSawFinalized).toBe(true);
  });

  it.each(["receipt.committed", "operation.cleared"] as CoordinatorBoundary[])(
    "finishes committed housekeeping when the original owner retries after %s failed",
    async (at) => {
      let fail = false;
      let fired = false;
      const c = coordinator({ onBoundary: (boundary) => {
        if (fail && !fired && boundary === at) { fired = true; throw new Error("response lost"); }
      } });
      await c.recover();
      const transaction = await c.begin({ id: crypto.randomUUID(), kind: "restore" });
      const staged = await transaction.stage(changed(transaction.previous.state));
      await transaction.activate();
      fail = true;
      await expect(transaction.commit()).rejects.toThrow();
      await expect(transaction.commit()).resolves.toEqual({ generation: staged.generation });
      expect((await c.status()).operation).toBeNull();
      const next = await c.begin({ id: crypto.randomUUID(), kind: "restore" });
      await next.rollback("test-finished");
    },
  );

  it("holds a committed restore until a different runtime acknowledges the selected generation", async () => {
    const first = coordinator();
    await first.recover();
    const operationId = crypto.randomUUID();
    const initiatingRuntimeGeneration = crypto.randomUUID();
    const transaction = await first.begin({ id: operationId, kind: "restore" });
    const staged = await transaction.stage(changed(transaction.previous.state));
    await transaction.activate();

    await expect(transaction.commitForRestart(initiatingRuntimeGeneration))
      .resolves.toEqual({ generation: staged.generation });
    await expect(first.recover()).resolves.toEqual({
      selectedGeneration: staged.generation,
      action: "kept-committed",
    });
    expect((await first.status()).operation).toEqual({
      id: operationId,
      kind: "restore",
      phase: "committed-awaiting-runtime-handoff",
    });
    await expect(first.begin({ id: crypto.randomUUID(), kind: "config-apply" }))
      .rejects.toMatchObject({ code: "STATE_BUSY" });
    await expect(first.acknowledgeRuntimeHandoff({
      operationId,
      generation: staged.generation,
      runtimeGeneration: initiatingRuntimeGeneration,
    })).rejects.toMatchObject({ code: "INVALID_OPERATION" });

    const restarted = coordinator();
    await expect(restarted.recover()).resolves.toEqual({
      selectedGeneration: staged.generation,
      action: "kept-committed",
    });
    expect((await restarted.status()).operation?.phase).toBe("committed-awaiting-runtime-handoff");
    const acknowledgingRuntimeGeneration = crypto.randomUUID();
    await expect(restarted.acknowledgeRuntimeHandoff({
      operationId,
      generation: staged.generation,
      runtimeGeneration: acknowledgingRuntimeGeneration,
    })).resolves.toEqual({ generation: staged.generation });
    expect((await restarted.status()).operation).toBeNull();
    await expect(restarted.acknowledgeRuntimeHandoff({
      operationId,
      generation: staged.generation,
      runtimeGeneration: acknowledgingRuntimeGeneration,
    })).resolves.toEqual({ generation: staged.generation });
  });

  it.each(["operation.committed", "receipt.committed"] as CoordinatorBoundary[])(
    "retains a restore handoff across a process cut at %s",
    async (at) => {
      let enabled = false;
      let fired = false;
      const first = coordinator({ onBoundary: (boundary) => {
        if (enabled && !fired && boundary === at) { fired = true; throw new Error("process killed"); }
      } });
      await first.recover();
      const operationId = crypto.randomUUID();
      const transaction = await first.begin({ id: operationId, kind: "restore" });
      const staged = await transaction.stage(changed(transaction.previous.state));
      await transaction.activate();
      enabled = true;
      await expect(transaction.commitForRestart(crypto.randomUUID())).rejects.toThrow("process killed");

      const restarted = coordinator();
      await expect(restarted.recover()).resolves.toEqual({
        selectedGeneration: staged.generation,
        action: "kept-committed",
      });
      expect((await restarted.status()).operation?.phase).toBe("committed-awaiting-runtime-handoff");
      await restarted.acknowledgeRuntimeHandoff({
        operationId,
        generation: staged.generation,
        runtimeGeneration: crypto.randomUUID(),
      });
      expect((await restarted.status()).operation).toBeNull();
    },
  );

  it("durably records an acknowledgement before releasing the handoff guard", async () => {
    let failAcknowledgement = false;
    const first = coordinator({ onBoundary: (boundary) => {
      if (failAcknowledgement && boundary === "receipt.runtime-handoff-acknowledged") {
        throw new Error("acknowledgement response lost");
      }
    } });
    await first.recover();
    const operationId = crypto.randomUUID();
    const transaction = await first.begin({ id: operationId, kind: "restore" });
    const staged = await transaction.stage(changed(transaction.previous.state));
    await transaction.activate();
    await transaction.commitForRestart(crypto.randomUUID());
    const acknowledgingRuntimeGeneration = crypto.randomUUID();
    failAcknowledgement = true;
    await expect(first.acknowledgeRuntimeHandoff({
      operationId,
      generation: staged.generation,
      runtimeGeneration: acknowledgingRuntimeGeneration,
    })).rejects.toThrow("acknowledgement response lost");

    const restarted = coordinator();
    await expect(restarted.recover()).resolves.toEqual({
      selectedGeneration: staged.generation,
      action: "kept-committed",
    });
    expect((await restarted.status()).operation).toBeNull();
    await expect(restarted.acknowledgeRuntimeHandoff({
      operationId,
      generation: staged.generation,
      runtimeGeneration: acknowledgingRuntimeGeneration,
    })).resolves.toEqual({ generation: staged.generation });
    await expect(restarted.acknowledgeRuntimeHandoff({
      operationId,
      generation: staged.generation,
      runtimeGeneration: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "OPERATION_OUTCOME" });
  });

  it("limits restart commits to activated restores and rejects mismatched acknowledgements", async () => {
    const first = coordinator();
    await first.recover();
    const ordinary = await first.begin({ id: crypto.randomUUID(), kind: "config-apply" });
    const ordinaryStaged = await ordinary.stage(changed(ordinary.previous.state));
    await ordinary.activate();
    await expect(ordinary.commitForRestart(crypto.randomUUID()))
      .rejects.toMatchObject({ code: "INVALID_PHASE" });
    await ordinary.rollback("test-finished");

    const operationId = crypto.randomUUID();
    const restore = await first.begin({ id: operationId, kind: "restore" });
    const staged = await restore.stage(changed(restore.previous.state, "restored"));
    await restore.activate();
    await restore.commitForRestart(crypto.randomUUID());
    await expect(first.acknowledgeRuntimeHandoff({
      operationId,
      generation: ordinaryStaged.generation,
      runtimeGeneration: crypto.randomUUID(),
    })).rejects.toMatchObject({ code: "OPERATION_OUTCOME" });
  });

  it.skipIf(process.platform === "win32")("recovers the old generation after an actual killed writer process", async () => {
    const initialized = coordinator();
    await initialized.recover();
    const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
    const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const source = pathToFileURL(join(packageRoot, "src/state/coordinator.ts")).href;
    const defaults = pathToFileURL(join(packageRoot, "src/schema/config.ts")).href;
    const script = join(dir, "killed-writer.ts");
    writeFileSync(script, `
      import { randomUUID } from "node:crypto";
      import { DurableStateCoordinator } from ${JSON.stringify(source)};
      import { DEFAULT_CONFIG } from ${JSON.stringify(defaults)};
      const coordinator = new DurableStateCoordinator({
        root: ${JSON.stringify(transactionsRoot)},
        configPath: ${JSON.stringify(configPath)},
        secretsPath: ${JSON.stringify(secretsPath)},
        bootstrap: async () => ({ config: DEFAULT_CONFIG, secrets: {}, linuxOwner: null, zeroTier: null }),
        onBoundary: (boundary) => {
          if (boundary === "selection.activated") process.kill(process.pid, "SIGKILL");
        },
      });
      await coordinator.recover();
      const transaction = await coordinator.begin({ id: randomUUID(), kind: "config-apply" });
      const next = structuredClone(transaction.previous.state);
      next.config.system.hostname = "yonder-killed-child";
      await transaction.stage(next);
      await transaction.activate();
    `);
    const result = spawnSync(join(repositoryRoot, "node_modules/.bin/vite-node"), [script], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (result.signal !== "SIGKILL") {
      throw new Error(JSON.stringify({ signal: result.signal, status: result.status, stderr: result.stderr, error: result.error?.message }));
    }

    const restarted = coordinator();
    await expect(restarted.recover()).resolves.toMatchObject({ action: "rolled-back" });
    expect(projected()).toEqual({ config: state().config, secrets: state().secrets });
  });

  it("never includes secret values in coordinator errors", async () => {
    const secret = "operator-secret-that-must-not-travel";
    const failing: StateProjector = {
      name: "failure",
      sections: [],
      async apply() { throw new Error(secret); },
      async verify() {},
    };
    const c = coordinator({ projectors: [failing] });
    await expect(c.recover()).rejects.not.toThrow(secret);
    await expect(c.recover()).rejects.toMatchObject({ code: "PROJECTION_FAILED" });
  });
});

describe("one-shot maintenance coordination", () => {
  it("asserts managed storage before publishing or reading a boot token", async () => {
    let storageAvailable = true;
    const assertStorage = () => {
      if (!storageAvailable) throw new Error("managed storage marker rejected");
    };
    const first = coordinator({ assertStorage });
    await first.recover();
    storageAvailable = false;
    await expect(first.requestMaintenance({ id: crypto.randomUUID() }))
      .rejects.toThrow("managed storage marker rejected");
    expect(existsSync(join(transactionsRoot, "operation.json"))).toBe(false);
    expect(existsSync(join(dir, "state", "maintenance"))).toBe(false);

    storageAvailable = true;
    const request = await first.requestMaintenance({ id: crypto.randomUUID() });
    await expect(first.recover()).resolves.toEqual({
      selectedGeneration: request.generation,
      action: "none",
    });
    storageAvailable = false;
    const unavailable = coordinator({ assertStorage });
    await expect(unavailable.recover()).rejects.toThrow("managed storage marker rejected");
    expect(new MaintenanceTokenStore(join(dir, "state", "maintenance")).read())
      .toEqual({ state: "pending", operationId: request.id });
  });
  it("arms the boot token under the writer lock without creating a generation", async () => {
    const c = coordinator();
    await c.recover();
    const before = readdirSync(join(transactionsRoot, "generations"));
    const request = await c.requestMaintenance({ id: crypto.randomUUID() });
    expect(readdirSync(join(transactionsRoot, "generations"))).toEqual(before);
    expect(await c.status()).toMatchObject({
      activeGeneration: request.generation,
      operation: { id: request.id, kind: "maintenance", phase: "awaiting-maintenance-reboot" },
    });
    expect(JSON.parse(readFileSync(join(dir, "state", "maintenance", "pending.json"), "utf8")))
      .toMatchObject({ operationId: request.id });
    await expect(c.begin({ id: crypto.randomUUID(), kind: "maintenance" }))
      .rejects.toMatchObject({ code: "INVALID_OPERATION" });
  });

  it("retains an armed request across an ordinary helper restart and blocks mutators", async () => {
    const first = coordinator();
    await first.recover();
    const request = await first.requestMaintenance({ id: crypto.randomUUID() });
    const restarted = coordinator({ initial: state("must-not-bootstrap") });
    await restarted.recover();
    expect((await restarted.status()).operation).toEqual({
      id: request.id, kind: "maintenance", phase: "awaiting-maintenance-reboot",
    });
    await expect(restarted.begin({ id: crypto.randomUUID(), kind: "owner-access" }))
      .rejects.toMatchObject({ code: "STATE_BUSY" });
    const visible = await restarted.readActiveState();
    visible.state.config.system.hostname = "caller-mutation";
    expect((await restarted.readActiveState()).state.config.system.hostname).toBe("yonder-old");
  });

  it("rolls back an unarmed request whose token publish was cut before rename", async () => {
    const first = coordinator();
    await first.recover();
    const request = await first.requestMaintenance({ id: crypto.randomUUID() });
    const pending = join(dir, "state", "maintenance", "pending.json");
    const temporary = `${pending}.tmp`;
    renameSync(pending, temporary);

    const restarted = coordinator();
    await expect(restarted.recover()).resolves.toEqual({
      selectedGeneration: request.generation,
      action: "rolled-back",
    });
    expect(existsSync(temporary)).toBe(false);
    expect((await restarted.status()).operation).toBeNull();
  });

  it("holds the lock during the consumed writable boot and clears it only on the next protected boot", async () => {
    const first = coordinator();
    await first.recover();
    const request = await first.requestMaintenance({ id: crypto.randomUUID() });
    new MaintenanceTokenStore(join(dir, "state", "maintenance")).consume(request.id);

    const writableBoot = coordinator({ storageMode: "maintenance" });
    await writableBoot.recover();
    expect((await writableBoot.status()).operation).toEqual({
      id: request.id, kind: "maintenance", phase: "entered-maintenance",
    });
    expect(readdirSync(join(transactionsRoot, "generations"))).toHaveLength(1);

    const protectedBoot = coordinator({ storageMode: "protected" });
    await protectedBoot.recover();
    expect((await protectedBoot.status()).operation).toBeNull();
    expect(existsSync(join(dir, "state", "maintenance", "consumed.json"))).toBe(false);
    expect(readdirSync(join(transactionsRoot, "generations"))).toHaveLength(1);
  });
});

describe("serialization, projectors and snapshots", () => {
  it("labels forward activation, explicit rollback and restart projection contexts", async () => {
    const contexts: StateProjectionContext[] = [];
    const projector: StateProjector = {
      name: "context-probe",
      sections: [],
      async apply({ context }) { contexts.push(context); },
      async verify() {},
    };
    const c = coordinator({ projectors: [projector] });
    await c.recover();
    const transaction = await c.begin({ id: crypto.randomUUID(), kind: "config-apply" });
    await transaction.stage(changed(transaction.previous.state));
    await transaction.activate();
    await transaction.rollback("test-finished");

    expect(contexts).toEqual(["recovery", "activation", "rollback"]);
  });

  it("allows one writer and returns a safe busy error to a concurrent writer", async () => {
    const c = coordinator();
    await c.recover();
    const first = await c.begin({ id: crypto.randomUUID(), kind: "owner-access" });
    await expect(c.begin({ id: crypto.randomUUID(), kind: "restore" }))
      .rejects.toMatchObject({ code: "STATE_BUSY" });
    await first.rollback("test-finished");
  });

  it("blocks writers while a snapshot lease is held and releases on expiry", async () => {
    const c = coordinator({ snapshotLeaseMs: 20 });
    await c.recover();
    await c.beginSnapshot({ id: crypto.randomUUID() });
    await expect(c.begin({ id: crypto.randomUUID(), kind: "restore" }))
      .rejects.toMatchObject({ code: "STATE_BUSY" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const tx = await c.begin({ id: crypto.randomUUID(), kind: "restore" });
    await tx.rollback("test-finished");
  });

  it("refuses external recovery while a snapshot lease is live", async () => {
    const c = coordinator();
    await c.recover();
    const lease = await c.beginSnapshot({ id: crypto.randomUUID() });
    await expect(c.recover()).rejects.toMatchObject({ code: "STATE_BUSY" });
    await lease.release();
    await expect(c.recover()).resolves.toMatchObject({ action: "none" });
  });

  it("serializes async projection against commit and external recovery", async () => {
    let projectionStarted!: () => void;
    let releaseProjection!: () => void;
    const started = new Promise<void>((resolve) => { projectionStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseProjection = resolve; });
    let delay = false;
    const projector: StateProjector = {
      name: "delayed",
      sections: [],
      async apply() {
        if (!delay) return;
        projectionStarted();
        await release;
      },
      async verify() {},
    };
    const c = coordinator({ projectors: [projector] });
    await c.recover();
    const transaction = await c.begin({ id: crypto.randomUUID(), kind: "restore" });
    await transaction.stage(changed(transaction.previous.state));
    delay = true;
    const activating = transaction.activate();
    await started;
    await expect(transaction.commit()).rejects.toMatchObject({ code: "STATE_BUSY" });
    await expect(c.recover()).rejects.toMatchObject({ code: "STATE_BUSY" });
    releaseProjection();
    await activating;
    await transaction.rollback("test-finished");
  });

  it("requires a statically registered owner projector before owner state can be staged", async () => {
    const c = coordinator();
    await c.recover();
    const tx = await c.begin({ id: crypto.randomUUID(), kind: "owner-access" });
    const wanted = structuredClone(tx.previous.state);
    wanted.linuxOwner = {
      username: "pilot",
      passwordHash: "$y$j9T$fixture",
      authorizedKeys: [],
      sshEnabled: true,
      sshPasswordAuthentication: false,
      sudo: true,
    };
    await expect(tx.stage(wanted)).rejects.toMatchObject({ code: "PROJECTOR_UNAVAILABLE" });
    await tx.rollback("unsupported");
  });

  it("uses a statically registered owner projector and never accepts one from staged data", async () => {
    let projectedOwner: DurableState["linuxOwner"] = null;
    const owner: StateProjector = {
      name: "linux-owner",
      sections: ["linuxOwner"],
      async apply({ next }) { projectedOwner = next.linuxOwner; },
      async verify({ expected }) {
        if (JSON.stringify(projectedOwner) !== JSON.stringify(expected.linuxOwner)) throw new Error("owner mismatch");
      },
    };
    const c = coordinator({ projectors: [owner] });
    await c.recover();
    const tx = await c.begin({ id: crypto.randomUUID(), kind: "owner-access" });
    const wanted = structuredClone(tx.previous.state);
    wanted.linuxOwner = {
      username: "pilot",
      passwordHash: "$y$j9T$fixture",
      authorizedKeys: ["ssh-ed25519 AAAA fixture"],
      sshEnabled: true,
      sshPasswordAuthentication: false,
      sudo: true,
    };
    await tx.stage(wanted);
    await tx.activate();
    await tx.commit();
    expect(projectedOwner?.username).toBe("pilot");
  });

  it("rejects a staged state above 4 MiB before creating a generation", async () => {
    const c = coordinator();
    await c.recover();
    const tx = await c.begin({ id: crypto.randomUUID(), kind: "restore" });
    const tooLarge = structuredClone(tx.previous.state);
    tooLarge.secrets = { huge: "x".repeat(4 * 1024 * 1024) };
    const before = readdirSync(join(transactionsRoot, "generations"));
    await expect(tx.stage(tooLarge)).rejects.toMatchObject({ code: "STATE_TOO_LARGE" });
    expect(readdirSync(join(transactionsRoot, "generations"))).toEqual(before);
    await tx.rollback("oversize");
  });
});
