// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import type { StateCoordinator, StateTransaction } from "../state/types.js";
import { StateCoordinatorError } from "../state/coordinator.js";
import { exportRecoveryArchive } from "./export.js";
import { RecoveryImportError, RecoveryImportStore, type RestorePreview } from "./import.js";
import type { DurableState } from "../state/types.js";
import { canonicalJson } from "./canonical.js";
import { decodeRecoveryArchive, encodeRecoveryArchive, type RecoveryArchiveV1, type RecoverySource } from "./schema.js";
import type { ZeroTierStateAdapter } from "./zerotier.js";
import type { RecoveryCompatibility } from "./import.js";

export interface RecoveryReconciliation {
  state: DurableState;
  compatibility: RecoveryCompatibility;
}

export type RecoveryDestinationReconciler = (input: {
  incoming: DurableState;
  destination: DurableState;
  source: RecoverySource;
  destinationSource: RecoverySource;
}) => Promise<RecoveryReconciliation>;

export interface RecoveryServiceOptions {
  coordinator: StateCoordinator;
  zeroTier: Pick<ZeroTierStateAdapter, "capture" | "validate">;
  imports?: RecoveryImportStore;
  source: RecoverySource;
  currentVersion: string;
  now?: () => number;
  /** Trusted hardware/runtime compatibility policy; public requests never select it. */
  reconcileDestination?: RecoveryDestinationReconciler;
}

/** Privileged recovery orchestration. Web authentication belongs to Task 8. */
export class RecoveryService {
  private readonly imports: RecoveryImportStore;
  constructor(private readonly options: RecoveryServiceOptions) {
    this.imports = options.imports ?? new RecoveryImportStore();
  }

  export(): Promise<Buffer> {
    return exportRecoveryArchive({ coordinator: this.options.coordinator, source: this.options.source,
      zeroTier: this.options.zeroTier, now: new Date(this.options.now?.() ?? Date.now()) });
  }

  async preview(input: { bytes: Uint8Array; sessionId: string }): Promise<RestorePreview> {
    if (!this.options.reconcileDestination) throw new RecoveryImportError("RECOVERY_UNAVAILABLE");
    const archive = decodeRecoveryArchive(input.bytes, this.options.currentVersion);
    if (archive.payload.zeroTier !== null) await this.options.zeroTier.validate(archive.payload.zeroTier);
    const lease = await this.options.coordinator.beginSnapshot({ id: randomUUID() });
    try {
      const reconciled = await this.reconcile(archive, lease.snapshot.state);
      return this.imports.stage({ bytes: input.bytes, archive, sessionId: input.sessionId,
        destinationGeneration: lease.snapshot.generation, destination: lease.snapshot.state,
        prepared: reconciled.state, compatibility: reconciled.compatibility,
        destinationBoard: this.options.source.board });
    } finally { await lease.release(); }
  }

  async commit(input: {
    restoreId: string;
    sessionId: string;
    destinationGeneration: string;
    runtimeGeneration: string;
    confirm: boolean;
  }): Promise<{ operationId: string; generation: string }> {
    if (input.confirm !== true) throw new RecoveryImportError("RESTORE_NOT_CONFIRMED");
    const operationId = randomUUID();
    let transaction: StateTransaction | undefined;
    let stagedGeneration: string | undefined;
    let committed = false;
    let commitAttempted = false;
    let discard = false;
    try {
      if (!this.options.reconcileDestination) throw new RecoveryImportError("RECOVERY_UNAVAILABLE");
      const claimed = this.imports.claim({ ...input, currentVersion: this.options.currentVersion });
      const archive = claimed.archive;
      discard = true;
      if (archive.payload.zeroTier !== null) await this.options.zeroTier.validate(archive.payload.zeroTier);
      transaction = await this.options.coordinator.begin({ id: operationId, kind: "restore",
        expectedActiveGeneration: input.destinationGeneration });
      const reconciled = await this.reconcile(archive, transaction.previous.state);
      if (canonicalJson(reconciled) !== canonicalJson({ state: claimed.prepared, compatibility: claimed.compatibility })) {
        throw new RecoveryImportError("RESTORE_STALE");
      }
      stagedGeneration = (await transaction.stage(reconciled.state)).generation;
      await transaction.activate();
      commitAttempted = true;
      try {
        await transaction.commitForRestart(input.runtimeGeneration);
        committed = true;
      } catch {
        try { await transaction.commitForRestart(input.runtimeGeneration); committed = true; }
        catch {
          // A restart handoff deliberately retains the coordinator guard.
          // Exact same-runtime retry above is the only automatic replay; any
          // remaining uncertainty is resolved by operation ID after restart.
          throw new RecoveryImportError("RESTORE_OUTCOME_UNKNOWN", operationId);
        }
      }
      return { operationId, generation: stagedGeneration };
    } catch (error) {
      if (error instanceof RecoveryImportError
        && !["RESTORE_SESSION_MISMATCH", "RESTORE_UNKNOWN"].includes(error.code)) discard = true;
      if (!committed && !commitAttempted && transaction) {
        try { await transaction.rollback("restore-failed"); }
        catch { throw new RecoveryImportError("RESTORE_OUTCOME_UNKNOWN", operationId); }
      }
      if (error instanceof RecoveryImportError) throw error;
      if (error instanceof StateCoordinatorError && error.code === "GENERATION_CHANGED") {
        throw new RecoveryImportError("RESTORE_STALE");
      }
      throw new RecoveryImportError("RESTORE_FAILED");
    } finally { if (discard) this.imports.discard(input.restoreId); }
  }

  cancel(input: { restoreId: string; sessionId: string }): void {
    this.imports.cancel(input.restoreId, input.sessionId);
  }

  private async reconcile(archive: RecoveryArchiveV1, destination: DurableState): Promise<RecoveryReconciliation> {
    const policy = this.options.reconcileDestination;
    if (!policy) throw new RecoveryImportError("RECOVERY_UNAVAILABLE");
    try {
      const result = await policy({ incoming: structuredClone(archive.payload), destination: structuredClone(destination),
        source: structuredClone(archive.source), destinationSource: structuredClone(this.options.source) });
      const compatibility = result.compatibility;
      for (const count of [compatibility?.unavailableCameras, compatibility?.unavailableUarts,
        compatibility?.unavailableNetworkInterfaces]) {
        if (!Number.isSafeInteger(count) || count < 0 || count > 1024) throw new Error("invalid compatibility count");
      }
      if (compatibility?.apFallbackReachable !== true || Object.keys(compatibility).sort().join(",")
        !== "apFallbackReachable,unavailableCameras,unavailableNetworkInterfaces,unavailableUarts") {
        throw new Error("invalid compatibility result");
      }
      // Reuse the strict archive validator for the trusted adapter's output,
      // including owner and canonical mesh constraints.
      const state = decodeRecoveryArchive(
        encodeRecoveryArchive(result.state, this.options.source),
        this.options.currentVersion,
      ).payload;
      if (state.zeroTier !== null) await this.options.zeroTier.validate(state.zeroTier);
      return { state, compatibility: structuredClone(compatibility) };
    } catch (error) {
      if (error instanceof RecoveryImportError) throw error;
      throw new RecoveryImportError("RESTORE_INCOMPATIBLE");
    }
  }
}
