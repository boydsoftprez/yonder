// SPDX-License-Identifier: GPL-3.0-or-later
import { lstatSync, readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { writeFileDurable } from "../fs/durable.js";
import { MaintenanceTokenError, MaintenanceTokenStore } from "../storage/maintenance.js";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/load.js";
import {
  type BoundaryHook,
  type CoordinatorBoundary,
  type OperationReceipt,
  type OperationRecord,
  StateDiskError,
  StateJournal,
} from "./journal.js";
import {
  DurableStateSchema,
  MAX_DURABLE_STATE_BYTES,
  StateKindSchema,
  type DurableState,
  type ProjectedStateSection,
  type StateCoordinator,
  type StateKind,
  type StateOperationPhase,
  type StateProjectionContext,
  type StateProjector,
  type StateSnapshot,
  type StateTransaction,
} from "./types.js";

export type { CoordinatorBoundary } from "./journal.js";

export type StateCoordinatorErrorCode =
  | "STATE_BUSY"
  | "STATE_UNAVAILABLE"
  | "STATE_TOO_LARGE"
  | "INVALID_OPERATION"
  | "GENERATION_CHANGED"
  | "INVALID_PHASE"
  | "PROJECTOR_UNAVAILABLE"
  | "PROJECTION_FAILED"
  | "OPERATION_UNKNOWN"
  | "OPERATION_OUTCOME";

export class StateCoordinatorError extends Error {
  constructor(readonly code: StateCoordinatorErrorCode, message: string) {
    super(message);
    this.name = "StateCoordinatorError";
  }
}

interface CoordinatorOptions {
  root: string;
  configPath: string;
  secretsPath: string;
  bootstrap: () => Promise<DurableState>;
  projectors?: readonly StateProjector[];
  onBoundary?: BoundaryHook;
  snapshotLeaseMs?: number;
  now?: () => number;
  assertStorage?: () => void;
  maintenanceRoot?: string;
  observeStorageMode?: () => "protected" | "maintenance";
}

interface ActiveOperation {
  record: OperationRecord;
  previous: StateSnapshot;
  next?: StateSnapshot;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SecretBagSchema = z.record(z.string().max(256), z.string().max(256 * 1024));

function coordinatorError(error: unknown): never {
  if (error instanceof StateCoordinatorError) throw error;
  if (error instanceof StateDiskError) throw new StateCoordinatorError(error.code, error.message);
  throw error;
}

function cloneState(state: DurableState): DurableState {
  return structuredClone(state);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertProjectedFile(path: string, mode: number): void {
  const info = lstatSync(path);
  const uid = process.geteuid?.() ?? info.uid;
  const gid = process.getegid?.() ?? info.gid;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
    || info.uid !== uid || info.gid !== gid || (info.mode & 0o777) !== mode) {
    throw new Error("projection ownership mismatch");
  }
}

/** Always-present projection from a generation to the two legacy application files. */
class ConfigSecretsProjector {
  readonly name = "config-secrets";
  readonly sections: readonly ProjectedStateSection[] = [];

  constructor(
    private readonly configPath: string,
    private readonly secretsPath: string,
    private readonly boundary: (name: CoordinatorBoundary) => void,
  ) {}

  async apply(input: {
    operationId: string;
    previous: DurableState;
    next: DurableState;
    context: StateProjectionContext;
  }): Promise<void> {
    writeFileDurable(this.configPath, stringify(input.next.config), 0o644);
    this.boundary("projection.config");
    writeFileDurable(this.secretsPath, stringify(input.next.secrets), 0o600);
    this.boundary("projection.secrets");
  }

  async verify(input: { operationId: string; expected: DurableState }): Promise<void> {
    assertProjectedFile(this.configPath, 0o644);
    assertProjectedFile(this.secretsPath, 0o600);
    const config = loadConfig(this.configPath);
    const secrets = SecretBagSchema.parse(parse(readFileSync(this.secretsPath, "utf8")) ?? {});
    if (!same(config, input.expected.config) || !same(secrets, input.expected.secrets)) {
      throw new Error("projection mismatch");
    }
  }
}

class Transaction implements StateTransaction {
  readonly id: string;
  readonly previous: StateSnapshot;

  constructor(private readonly coordinator: DurableStateCoordinator, active: ActiveOperation) {
    this.id = active.record.id;
    this.previous = { generation: active.previous.generation, state: cloneState(active.previous.state) };
  }

  stage(next: DurableState): Promise<{ generation: string }> {
    return this.coordinator.stage(this.id, next);
  }

  activate(): Promise<{ generation: string }> {
    return this.coordinator.activate(this.id);
  }

  holdForConfirmation(): Promise<void> {
    return this.coordinator.hold(this.id);
  }

  commit(): Promise<{ generation: string }> {
    return this.coordinator.commit(this.id);
  }

  commitForRestart(currentRuntimeGeneration: string): Promise<{ generation: string }> {
    return this.coordinator.commitForRestart(this.id, currentRuntimeGeneration);
  }

  rollback(reasonCode: string): Promise<{ generation: string }> {
    return this.coordinator.rollback(this.id, reasonCode);
  }
}

export class DurableStateCoordinator implements StateCoordinator {
  private readonly journal: StateJournal;
  private readonly bootstrap: () => Promise<DurableState>;
  private readonly projectors: readonly StateProjector[];
  private readonly projectionSections: ReadonlySet<ProjectedStateSection>;
  private readonly fixedProjector: ConfigSecretsProjector;
  private readonly snapshotLeaseMs: number;
  private readonly now: () => number;
  private readonly assertStorage: () => void;
  private readonly maintenanceTokens: MaintenanceTokenStore;
  private readonly observeStorageMode: () => "protected" | "maintenance";

  private activeGeneration?: string;
  private operation?: ActiveOperation;
  private snapshot?: { id: string; timer: NodeJS.Timeout };
  private recovering = false;
  private transitioning = false;

  constructor(options: CoordinatorOptions) {
    this.journal = new StateJournal(options.root, options.onBoundary);
    this.bootstrap = options.bootstrap;
    this.projectors = Object.freeze([...(options.projectors ?? [])]);
    this.snapshotLeaseMs = options.snapshotLeaseMs ?? 60_000;
    if (!Number.isSafeInteger(this.snapshotLeaseMs) || this.snapshotLeaseMs < 1 || this.snapshotLeaseMs > 5 * 60_000) {
      throw new StateCoordinatorError("INVALID_OPERATION", "snapshot lease duration is invalid");
    }
    this.now = options.now ?? Date.now;
    this.assertStorage = options.assertStorage ?? (() => {});
    this.maintenanceTokens = new MaintenanceTokenStore(
      options.maintenanceRoot ?? join(dirname(options.root), "maintenance"),
    );
    this.observeStorageMode = options.observeStorageMode ?? (() => "protected");
    const names = new Set<string>();
    const sections = new Set<ProjectedStateSection>();
    for (const projector of this.projectors) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(projector.name) || names.has(projector.name)) {
        throw new StateCoordinatorError("PROJECTOR_UNAVAILABLE", "projector registration is invalid");
      }
      names.add(projector.name);
      for (const section of projector.sections) {
        if (!(["linuxOwner", "zeroTier"] as const).includes(section) || sections.has(section)) {
          throw new StateCoordinatorError("PROJECTOR_UNAVAILABLE", "projector section registration is invalid");
        }
        sections.add(section);
      }
    }
    this.projectionSections = sections;
    this.fixedProjector = new ConfigSecretsProjector(
      options.configPath,
      options.secretsPath,
      (boundary) => this.journal.boundary(boundary),
    );
  }

  async status(): Promise<{
    activeGeneration: string;
    operation: null | { id: string; kind: StateKind; phase: StateOperationPhase };
  }> {
    this.ready();
    return {
      activeGeneration: this.activeGeneration as string,
      operation: this.recovering && this.operation
        ? { id: this.operation.record.id, kind: this.operation.record.kind, phase: "recovering" }
        : this.operation
          ? {
            id: this.operation.record.id,
            kind: this.operation.record.kind,
            phase: this.operation.record.phase,
          }
          : null,
    };
  }

  async readActiveState(): Promise<StateSnapshot> {
    this.ready();
    const generation = this.activeGeneration as string;
    return { generation, state: cloneState(this.journal.readGeneration(generation)) };
  }

  async begin(input: {
    id: string;
    kind: StateKind;
    expectedActiveGeneration?: string;
  }): Promise<StateTransaction> {
    this.ready();
    if (input.kind === "maintenance") {
      throw new StateCoordinatorError("INVALID_OPERATION", "maintenance requires the dedicated one-shot request");
    }
    if (this.operation || this.snapshot || this.recovering || this.transitioning) {
      throw new StateCoordinatorError("STATE_BUSY", "another durable state operation is in progress");
    }
    if (!UUID_RE.test(input.id) || !StateKindSchema.safeParse(input.kind).success) {
      throw new StateCoordinatorError("INVALID_OPERATION", "state operation identity or kind is invalid");
    }
    if (input.expectedActiveGeneration !== undefined && input.expectedActiveGeneration !== this.activeGeneration) {
      throw new StateCoordinatorError("GENERATION_CHANGED", "durable state changed before the operation began");
    }
    if (this.journal.readReceipt(input.id)) {
      throw new StateCoordinatorError("OPERATION_OUTCOME", "this durable state operation already completed");
    }
    if (this.journal.readOperation()) {
      throw new StateCoordinatorError("STATE_UNAVAILABLE", "durable state recovery is required before another write");
    }
    const generation = this.activeGeneration as string;
    const previous = { generation, state: this.journal.readGeneration(generation) };
    const record: OperationRecord = {
      schemaVersion: 1,
      id: input.id,
      kind: input.kind,
      phase: "staging",
      previousGeneration: generation,
      startedAt: this.now(),
    };
    this.journal.writeOperation(record);
    this.operation = { record, previous };
    this.journal.boundary("operation.begin");
    return new Transaction(this, this.operation);
  }

  requestMaintenance(input: {
    id: string;
    expectedActiveGeneration?: string;
  }): Promise<{ id: string; generation: string }> {
    return this.exclusive(async () => {
      this.ready();
      if (this.operation || this.snapshot) {
        throw new StateCoordinatorError("STATE_BUSY", "another durable state operation is in progress");
      }
      if (!UUID_RE.test(input.id)) throw new StateCoordinatorError("INVALID_OPERATION", "state operation identity is invalid");
      if (input.expectedActiveGeneration !== undefined && input.expectedActiveGeneration !== this.activeGeneration) {
        throw new StateCoordinatorError("GENERATION_CHANGED", "durable state changed before maintenance was requested");
      }
      if (this.journal.readReceipt(input.id) || this.journal.readOperation()) {
        throw new StateCoordinatorError("STATE_BUSY", "another durable state operation is in progress");
      }
      const generation = this.activeGeneration as string;
      const record: OperationRecord = {
        schemaVersion: 1,
        id: input.id,
        kind: "maintenance",
        phase: "awaiting-maintenance-reboot",
        previousGeneration: generation,
        maintenance: { schemaVersion: 1, mode: "writable-next-boot" },
        startedAt: this.now(),
      };
      this.journal.writeOperation(record);
      this.journal.boundary("operation.begin");
      try {
        this.publishMaintenanceToken(input.id);
      } catch (error) {
        if (error instanceof MaintenanceTokenError) {
          throw new StateCoordinatorError("STATE_UNAVAILABLE", error.message);
        }
        throw error;
      }
      this.operation = {
        record,
        previous: { generation, state: this.journal.readGeneration(generation) },
      };
      return { id: input.id, generation };
    });
  }

  async beginSnapshot(input: { id: string }): Promise<{
    snapshot: StateSnapshot;
    release(): Promise<void>;
  }> {
    this.ready();
    if (!UUID_RE.test(input.id)) throw new StateCoordinatorError("INVALID_OPERATION", "snapshot identity is invalid");
    if (this.operation || this.snapshot || this.recovering || this.transitioning) {
      throw new StateCoordinatorError("STATE_BUSY", "another durable state operation is in progress");
    }
    const generation = this.activeGeneration as string;
    const snapshot = { generation, state: this.journal.readGeneration(generation) };
    const timer = setTimeout(() => { this.releaseSnapshot(input.id); }, this.snapshotLeaseMs);
    timer.unref();
    this.snapshot = { id: input.id, timer };
    let released = false;
    return {
      snapshot: { generation, state: cloneState(snapshot.state) },
      release: async () => {
        if (released) return;
        released = true;
        this.releaseSnapshot(input.id);
      },
    };
  }

  async recover(): Promise<{
    selectedGeneration: string;
    action: "none" | "discarded-staged" | "rolled-back" | "kept-committed";
  }> {
    const attachable = this.operation?.record.kind === "maintenance"
      || this.operation?.record.phase === "committed-awaiting-runtime-handoff";
    if ((this.operation && !attachable) || this.snapshot || this.transitioning) {
      throw new StateCoordinatorError("STATE_BUSY", "another durable state operation is in progress");
    }
    return this.recoverInternal();
  }

  private async recoverInternal(): Promise<{
    selectedGeneration: string;
    action: "none" | "discarded-staged" | "rolled-back" | "kept-committed";
  }> {
    if (this.recovering) throw new StateCoordinatorError("STATE_BUSY", "durable state recovery is already in progress");
    this.recovering = true;
    try {
      this.assertStorage();
      const initialize = this.journal.needsInitialization();
      const initialized = initialize
        ? this.journal.ensureInitialized(await this.bootstrap())
        : { generation: this.journal.readActiveGeneration(), created: false };
      let record = this.journal.readOperation();
      if (record === null) {
        const active = initialized.generation;
        const state = this.journal.readGeneration(active);
        this.requireProjectors(state, state);
        await this.project(active, state, state, "recovery");
        await this.verify(active, state);
        this.activeGeneration = active;
        this.operation = undefined;
        this.journal.cleanupGenerations(new Set([active]));
        return { selectedGeneration: active, action: "none" };
      }

      if (record.kind === "maintenance") {
        const selected = this.journal.readActiveGeneration();
        if (selected !== record.previousGeneration) {
          throw new StateCoordinatorError("STATE_UNAVAILABLE", "maintenance operation generation changed unexpectedly");
        }
        const current = this.journal.readGeneration(selected);
        this.requireProjectors(current, current);
        await this.project(record.id, current, current, "recovery");
        await this.verify(record.id, current);
        let token;
        try {
          token = this.readMaintenanceToken();
        } catch (error) {
          if (error instanceof MaintenanceTokenError) throw new StateCoordinatorError("STATE_UNAVAILABLE", error.message);
          throw error;
        }
        if (!token) {
          const receipt = this.receipt(record, "rolled-back", selected, "maintenance-unarmed");
          this.journal.writeReceipt(receipt);
          this.journal.clearOperation();
          this.activeGeneration = selected;
          this.operation = undefined;
          return { selectedGeneration: selected, action: "rolled-back" };
        }
        if (token.operationId !== record.id) {
          throw new StateCoordinatorError("STATE_UNAVAILABLE", "maintenance token does not match its journal operation");
        }
        const mode = this.observeStorageMode();
        if (token.state === "pending") {
          if (mode !== "protected") throw new StateCoordinatorError("STATE_UNAVAILABLE", "unconsumed maintenance token reached writable storage");
          this.activeGeneration = selected;
          this.operation = { record, previous: { generation: selected, state: current } };
          return { selectedGeneration: selected, action: "none" };
        }
        if (mode === "maintenance") {
          if (record.phase !== "entered-maintenance") {
            record = { ...record, phase: "entered-maintenance" };
            this.journal.writeOperation(record);
          }
          this.activeGeneration = selected;
          this.operation = { record, previous: { generation: selected, state: current } };
          return { selectedGeneration: selected, action: "none" };
        }
        const receipt = this.receipt(record, "committed", selected);
        this.journal.writeReceipt(receipt);
        this.clearMaintenanceToken(record.id);
        this.journal.clearOperation();
        this.activeGeneration = selected;
        this.operation = undefined;
        return { selectedGeneration: selected, action: "none" };
      }

      const previous = this.journal.readGeneration(record.previousGeneration);
      const next = record.nextGeneration === undefined
        ? undefined
        : this.readGenerationIfComplete(record.nextGeneration);
      this.operation = {
        record: { ...record, phase: "recovering" },
        previous: { generation: record.previousGeneration, state: previous },
        ...(next ? { next: { generation: record.nextGeneration as string, state: next } } : {}),
      };
      if (record.decision === "commit") {
        if (!record.nextGeneration || !next) {
          throw new StateCoordinatorError("STATE_UNAVAILABLE", "committed durable state is unavailable; reflash is required");
        }
        this.requireProjectors(previous, next);
        this.journal.writeActiveGeneration(record.nextGeneration);
        await this.project(record.id, previous, next, "recovery");
        await this.verify(record.id, next);
        if (record.runtimeHandoff) {
          const existingReceipt = this.journal.readReceipt(record.id);
          if (existingReceipt && (existingReceipt.outcome !== "committed"
            || existingReceipt.generation !== record.nextGeneration
            || existingReceipt.previousGeneration !== record.previousGeneration
            || existingReceipt.runtimeHandoff?.initiatingRuntimeGeneration
              !== record.runtimeHandoff.initiatingRuntimeGeneration)) {
            throw new StateCoordinatorError("STATE_UNAVAILABLE", "runtime handoff receipt does not match its operation");
          }
          if (existingReceipt?.runtimeHandoff?.acknowledgedRuntimeGeneration) {
            this.journal.clearOperation();
            this.journal.boundary("operation.cleared");
            this.activeGeneration = record.nextGeneration;
            this.operation = undefined;
            this.journal.cleanupGenerations(new Set([record.nextGeneration]));
            return { selectedGeneration: record.nextGeneration, action: "kept-committed" };
          }
          const receipt = this.receipt(record, "committed", record.nextGeneration);
          this.journal.writeReceipt(receipt);
          this.journal.boundary("receipt.committed");
          this.activeGeneration = record.nextGeneration;
          this.operation = {
            record,
            previous: { generation: record.previousGeneration, state: previous },
            next: { generation: record.nextGeneration, state: next },
          };
          this.journal.cleanupGenerations(new Set([record.previousGeneration, record.nextGeneration]));
          return { selectedGeneration: record.nextGeneration, action: "kept-committed" };
        }
        const receipt = this.receipt(record, "committed", record.nextGeneration);
        this.journal.writeReceipt(receipt);
        this.journal.boundary("receipt.committed");
        this.journal.clearOperation();
        this.journal.boundary("operation.cleared");
        this.activeGeneration = record.nextGeneration;
        this.operation = undefined;
        this.journal.cleanupGenerations(new Set([record.previousGeneration, record.nextGeneration]));
        return { selectedGeneration: record.nextGeneration, action: "kept-committed" };
      }

      this.requireProjectors(next ?? previous, previous);
      this.journal.writeActiveGeneration(record.previousGeneration);
      await this.project(record.id, next ?? previous, previous, "recovery");
      await this.verify(record.id, previous);
      const receipt = this.receipt(record, "rolled-back", record.previousGeneration, "recovered");
      this.journal.writeReceipt(receipt);
      this.journal.boundary("receipt.rolled-back");
      this.journal.clearOperation();
      this.journal.boundary("operation.cleared");
      this.activeGeneration = record.previousGeneration;
      this.operation = undefined;
      this.journal.cleanupGenerations(new Set([record.previousGeneration]));
      return {
        selectedGeneration: record.previousGeneration,
        action: record.phase === "staging" ? "discarded-staged" : "rolled-back",
      };
    } catch (error) {
      coordinatorError(error);
    } finally {
      this.recovering = false;
    }
  }

  async resolveOperation(id: string, expected: OperationReceipt["outcome"]): Promise<{ generation: string }> {
    this.ready();
    if (!UUID_RE.test(id)) throw new StateCoordinatorError("INVALID_OPERATION", "state operation identity is invalid");
    const receipt = this.journal.readReceipt(id);
    if (!receipt) throw new StateCoordinatorError("OPERATION_UNKNOWN", "no terminal result exists for this operation");
    if (receipt.outcome !== expected) {
      throw new StateCoordinatorError("OPERATION_OUTCOME", "the operation completed with a different outcome");
    }
    return { generation: receipt.generation };
  }

  async recoverDisconnected(id: string): Promise<void> {
    if (!this.operation || this.operation.record.id !== id) return;
    if (this.transitioning || this.recovering) {
      throw new StateCoordinatorError("STATE_BUSY", "durable state recovery cannot overlap a transition");
    }
    await this.recoverInternal();
  }

  stage(id: string, input: DurableState): Promise<{ generation: string }> {
    return this.exclusive(() => this.stageUnlocked(id, input));
  }

  private async stageUnlocked(id: string, input: DurableState): Promise<{ generation: string }> {
    const active = this.requireOperation(id, ["staging"]);
    if (active.next) throw new StateCoordinatorError("INVALID_PHASE", "durable state was already staged");
    let rawBytes: number;
    try {
      rawBytes = Buffer.byteLength(`${JSON.stringify(input)}\n`);
    } catch {
      throw new StateCoordinatorError("STATE_UNAVAILABLE", "staged durable state is not valid");
    }
    if (rawBytes > MAX_DURABLE_STATE_BYTES) {
      throw new StateCoordinatorError("STATE_TOO_LARGE", "durable state exceeds the 4 MiB limit");
    }
    const parsed = DurableStateSchema.safeParse(input);
    if (!parsed.success) throw new StateCoordinatorError("STATE_UNAVAILABLE", "staged durable state is not valid");
    if (Buffer.byteLength(`${JSON.stringify(parsed.data)}\n`) > MAX_DURABLE_STATE_BYTES) {
      throw new StateCoordinatorError("STATE_TOO_LARGE", "durable state exceeds the 4 MiB limit");
    }
    this.requireProjectors(active.previous.state, parsed.data);
    try {
      const generation = this.journal.newGeneration(parsed.data);
      const record = { ...active.record, nextGeneration: generation };
      this.journal.writeOperation(record);
      active.record = record;
      active.next = { generation, state: parsed.data };
      this.journal.boundary("operation.staged");
      return { generation };
    } catch (error) {
      coordinatorError(error);
    }
  }

  activate(id: string): Promise<{ generation: string }> {
    return this.exclusive(() => this.activateUnlocked(id));
  }

  private async activateUnlocked(id: string): Promise<{ generation: string }> {
    const active = this.requireOperation(id, ["staging"]);
    if (!active.next) throw new StateCoordinatorError("INVALID_PHASE", "no complete durable state is staged");
    const record = { ...active.record, phase: "activating" as const };
    this.journal.writeOperation(record);
    active.record = record;
    this.journal.boundary("operation.activating");
    this.journal.writeActiveGeneration(active.next.generation);
    this.activeGeneration = active.next.generation;
    this.journal.boundary("selection.activated");
    await this.project(id, active.previous.state, active.next.state, "activation");
    return { generation: active.next.generation };
  }

  hold(id: string): Promise<void> {
    return this.exclusive(() => this.holdUnlocked(id));
  }

  private async holdUnlocked(id: string): Promise<void> {
    const active = this.requireOperation(id, ["activating"]);
    const record = { ...active.record, phase: "awaiting-confirmation" as const };
    this.journal.writeOperation(record);
    active.record = record;
    this.journal.boundary("operation.awaiting-confirmation");
  }

  commit(id: string): Promise<{ generation: string }> {
    return this.exclusive(() => this.commitUnlocked(id));
  }

  commitForRestart(id: string, currentRuntimeGeneration: string): Promise<{ generation: string }> {
    return this.exclusive(() => this.commitForRestartUnlocked(id, currentRuntimeGeneration));
  }

  private async commitForRestartUnlocked(
    id: string,
    currentRuntimeGeneration: string,
  ): Promise<{ generation: string }> {
    if (!UUID_RE.test(currentRuntimeGeneration)) {
      throw new StateCoordinatorError("INVALID_OPERATION", "runtime generation is invalid");
    }
    const receipt = this.journal.readReceipt(id);
    if (receipt) {
      if (receipt.outcome !== "committed") {
        throw new StateCoordinatorError("OPERATION_OUTCOME", "the operation was rolled back");
      }
      if (!receipt.runtimeHandoff
        || receipt.runtimeHandoff.initiatingRuntimeGeneration !== currentRuntimeGeneration) {
        throw new StateCoordinatorError("OPERATION_OUTCOME", "the committed operation is not this runtime handoff");
      }
      return { generation: receipt.generation };
    }
    const active = this.requireOperation(id, [
      "activating",
      "awaiting-confirmation",
      "committing",
      "committed-awaiting-runtime-handoff",
    ]);
    if (active.record.kind !== "restore" || !active.next) {
      throw new StateCoordinatorError("INVALID_PHASE", "only an activated restore can await runtime handoff");
    }
    if (active.record.runtimeHandoff
      && active.record.runtimeHandoff.initiatingRuntimeGeneration !== currentRuntimeGeneration) {
      throw new StateCoordinatorError("OPERATION_OUTCOME", "runtime handoff belongs to another process generation");
    }
    let record = active.record;
    if (record.decision !== "commit") {
      record = { ...record, phase: "committing" as const };
      this.journal.writeOperation(record);
      active.record = record;
      this.journal.boundary("operation.committing");
      await this.verify(id, active.next.state);
      if (this.journal.readActiveGeneration() !== active.next.generation) {
        throw new StateCoordinatorError("STATE_UNAVAILABLE", "the active durable generation changed during commit");
      }
    }
    record = {
      ...record,
      phase: "committed-awaiting-runtime-handoff" as const,
      decision: "commit" as const,
      runtimeHandoff: { schemaVersion: 1 as const, initiatingRuntimeGeneration: currentRuntimeGeneration },
    };
    this.journal.writeOperation(record);
    active.record = record;
    this.journal.boundary("operation.committed");
    const receiptValue = this.receipt(record, "committed", active.next.generation);
    this.journal.writeReceipt(receiptValue);
    this.journal.boundary("receipt.committed");
    this.activeGeneration = active.next.generation;
    this.journal.cleanupGenerations(new Set([active.previous.generation, active.next.generation]));
    return { generation: active.next.generation };
  }

  acknowledgeRuntimeHandoff(input: {
    operationId: string;
    generation: string;
    runtimeGeneration: string;
  }): Promise<{ generation: string }> {
    return this.exclusive(async () => {
      this.ready();
      if (!UUID_RE.test(input.operationId) || !UUID_RE.test(input.generation)
        || !UUID_RE.test(input.runtimeGeneration)) {
        throw new StateCoordinatorError("INVALID_OPERATION", "runtime handoff identity is invalid");
      }
      const receipt = this.journal.readReceipt(input.operationId);
      if (!receipt) throw new StateCoordinatorError("OPERATION_UNKNOWN", "runtime handoff operation is unknown");
      if (receipt.outcome !== "committed" || receipt.generation !== input.generation
        || !receipt.runtimeHandoff) {
        throw new StateCoordinatorError("OPERATION_OUTCOME", "runtime handoff does not match its committed generation");
      }
      if (!this.operation) {
        if (receipt.runtimeHandoff.acknowledgedRuntimeGeneration !== input.runtimeGeneration) {
          throw new StateCoordinatorError("OPERATION_OUTCOME", "runtime handoff was acknowledged by another process generation");
        }
        return { generation: receipt.generation };
      }
      const record = this.operation.record;
      if (record.id !== input.operationId || record.phase !== "committed-awaiting-runtime-handoff"
        || record.nextGeneration !== input.generation || !record.runtimeHandoff) {
        throw new StateCoordinatorError("OPERATION_OUTCOME", "another durable state operation owns the handoff guard");
      }
      if (receipt.runtimeHandoff.initiatingRuntimeGeneration
        !== record.runtimeHandoff.initiatingRuntimeGeneration) {
        throw new StateCoordinatorError("STATE_UNAVAILABLE", "runtime handoff receipt does not match its operation");
      }
      if (record.runtimeHandoff.initiatingRuntimeGeneration === input.runtimeGeneration) {
        throw new StateCoordinatorError("INVALID_OPERATION", "the initiating runtime cannot acknowledge its own handoff");
      }
      if (this.journal.readActiveGeneration() !== input.generation) {
        throw new StateCoordinatorError("STATE_UNAVAILABLE", "runtime handoff generation is no longer selected");
      }
      if (receipt.runtimeHandoff.acknowledgedRuntimeGeneration
        && receipt.runtimeHandoff.acknowledgedRuntimeGeneration !== input.runtimeGeneration) {
        throw new StateCoordinatorError("OPERATION_OUTCOME", "runtime handoff was acknowledged by another process generation");
      }
      if (!receipt.runtimeHandoff.acknowledgedRuntimeGeneration) {
        this.journal.writeReceipt({
          ...receipt,
          runtimeHandoff: {
            ...receipt.runtimeHandoff,
            acknowledgedRuntimeGeneration: input.runtimeGeneration,
          },
        });
        this.journal.boundary("receipt.runtime-handoff-acknowledged");
      }
      this.journal.clearOperation();
      this.journal.boundary("operation.cleared");
      this.operation = undefined;
      this.journal.cleanupGenerations(new Set([input.generation]));
      return { generation: input.generation };
    });
  }

  private async commitUnlocked(id: string): Promise<{ generation: string }> {
    const receipt = this.journal.readReceipt(id);
    if (receipt) {
      if (receipt.outcome !== "committed") {
        throw new StateCoordinatorError("OPERATION_OUTCOME", "the operation was rolled back");
      }
      if (this.operation?.record.id === id) await this.recoverInternal();
      return { generation: receipt.generation };
    }
    const active = this.requireOperation(id, ["activating", "awaiting-confirmation", "committing"]);
    if (!active.next) throw new StateCoordinatorError("INVALID_PHASE", "no activated durable state can be committed");
    let record = active.record;
    if (record.decision !== "commit") {
      record = { ...record, phase: "committing" as const };
      this.journal.writeOperation(record);
      active.record = record;
      this.journal.boundary("operation.committing");
      await this.verify(id, active.next.state);
      if (this.journal.readActiveGeneration() !== active.next.generation) {
        throw new StateCoordinatorError("STATE_UNAVAILABLE", "the active durable generation changed during commit");
      }
      record = { ...record, decision: "commit" as const };
      this.journal.writeOperation(record);
      active.record = record;
      this.journal.boundary("operation.committed");
    }
    const receiptValue = this.receipt(record, "committed", active.next.generation);
    this.journal.writeReceipt(receiptValue);
    this.journal.boundary("receipt.committed");
    this.journal.clearOperation();
    this.journal.boundary("operation.cleared");
    this.activeGeneration = active.next.generation;
    this.operation = undefined;
    this.journal.cleanupGenerations(new Set([active.previous.generation, active.next.generation]));
    return { generation: active.next.generation };
  }

  rollback(id: string, reasonCode: string): Promise<{ generation: string }> {
    return this.exclusive(() => this.rollbackUnlocked(id, reasonCode));
  }

  private async rollbackUnlocked(id: string, reasonCode: string): Promise<{ generation: string }> {
    const receipt = this.journal.readReceipt(id);
    if (receipt) {
      if (receipt.outcome !== "rolled-back") {
        throw new StateCoordinatorError("OPERATION_OUTCOME", "the operation was committed");
      }
      if (this.operation?.record.id === id) await this.recoverInternal();
      return { generation: receipt.generation };
    }
    if (!REASON_RE.test(reasonCode)) {
      throw new StateCoordinatorError("INVALID_OPERATION", "rollback reason code is invalid");
    }
    const active = this.requireOperation(id, ["staging", "activating", "awaiting-confirmation", "committing", "rolling-back"]);
    if (active.record.decision === "commit") {
      throw new StateCoordinatorError("OPERATION_OUTCOME", "the operation was already committed");
    }
    const record = { ...active.record, phase: "rolling-back" as const };
    this.journal.writeOperation(record);
    active.record = record;
    this.journal.boundary("operation.rolling-back");
    this.journal.writeActiveGeneration(active.previous.generation);
    this.activeGeneration = active.previous.generation;
    this.journal.boundary("selection.rolled-back");
    await this.project(id, active.next?.state ?? active.previous.state, active.previous.state, "rollback");
    await this.verify(id, active.previous.state);
    const receiptValue = this.receipt(record, "rolled-back", active.previous.generation, reasonCode);
    this.journal.writeReceipt(receiptValue);
    this.journal.boundary("receipt.rolled-back");
    this.journal.clearOperation();
    this.journal.boundary("operation.cleared");
    this.operation = undefined;
    this.journal.cleanupGenerations(new Set([active.previous.generation]));
    return { generation: active.previous.generation };
  }

  private ready(): void {
    this.assertStorage();
    if (!this.activeGeneration) {
      throw new StateCoordinatorError("STATE_UNAVAILABLE", "durable state recovery has not completed");
    }
  }

  private publishMaintenanceToken(operationId: string): void {
    this.assertStorage();
    this.maintenanceTokens.publish(operationId);
  }

  private readMaintenanceToken(): ReturnType<MaintenanceTokenStore["read"]> {
    this.assertStorage();
    return this.maintenanceTokens.read();
  }

  private clearMaintenanceToken(operationId: string): void {
    this.assertStorage();
    this.maintenanceTokens.clear(operationId);
  }

  private requireOperation(id: string, phases: StateOperationPhase[]): ActiveOperation {
    this.ready();
    if (!UUID_RE.test(id) || !this.operation || this.operation.record.id !== id) {
      throw new StateCoordinatorError("OPERATION_UNKNOWN", "this state operation is not active");
    }
    if (!phases.includes(this.operation.record.phase)) {
      throw new StateCoordinatorError("INVALID_PHASE", "the state operation is not in the required phase");
    }
    return this.operation;
  }

  private requireProjectors(previous: DurableState, next: DurableState): void {
    if ((previous.linuxOwner !== null || next.linuxOwner !== null) && !this.projectionSections.has("linuxOwner")) {
      throw new StateCoordinatorError("PROJECTOR_UNAVAILABLE", "the Linux owner projector is not registered");
    }
    if ((previous.zeroTier !== null || next.zeroTier !== null) && !this.projectionSections.has("zeroTier")) {
      throw new StateCoordinatorError("PROJECTOR_UNAVAILABLE", "the mesh projector is not registered");
    }
  }

  private async project(
    operationId: string,
    previous: DurableState,
    next: DurableState,
    context: StateProjectionContext,
  ): Promise<void> {
    try {
      await this.fixedProjector.apply({ operationId, previous, next, context });
      for (const projector of this.projectors) {
        await projector.apply({ operationId, previous: cloneState(previous), next: cloneState(next), context });
        this.journal.boundary(`projection.${projector.name}`);
      }
    } catch (error) {
      if (error instanceof StateCoordinatorError) throw error;
      // Projector and parser errors may carry password hashes or identity bytes.
      throw new StateCoordinatorError("PROJECTION_FAILED", "a fixed durable-state projection failed");
    }
  }

  private async verify(operationId: string, expected: DurableState): Promise<void> {
    try {
      await this.fixedProjector.verify({ operationId, expected });
      for (const projector of this.projectors) {
        await projector.verify({ operationId, expected: cloneState(expected) });
      }
    } catch {
      throw new StateCoordinatorError("PROJECTION_FAILED", "a fixed durable-state projection could not be verified");
    }
  }

  private receipt(
    record: OperationRecord,
    outcome: OperationReceipt["outcome"],
    generation: string,
    reasonCode?: string,
  ): OperationReceipt {
    return {
      id: record.id,
      kind: record.kind,
      outcome,
      generation,
      previousGeneration: record.previousGeneration,
      ...(record.runtimeHandoff ? { runtimeHandoff: { ...record.runtimeHandoff } } : {}),
      ...(reasonCode ? { reasonCode } : {}),
      completedAt: this.now(),
    };
  }

  private releaseSnapshot(id: string): void {
    if (!this.snapshot || this.snapshot.id !== id) return;
    clearTimeout(this.snapshot.timer);
    this.snapshot = undefined;
  }

  private readGenerationIfComplete(generation: string): DurableState | undefined {
    try {
      return this.journal.readGeneration(generation);
    } catch {
      return undefined;
    }
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.transitioning || this.recovering) {
      throw new StateCoordinatorError("STATE_BUSY", "another durable state transition is in progress");
    }
    this.transitioning = true;
    try {
      return await work();
    } finally {
      this.transitioning = false;
    }
  }

}
