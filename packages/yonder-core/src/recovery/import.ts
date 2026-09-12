// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fsyncDir, unlinkDurable, writeFileDurable } from "../fs/durable.js";
import type { DurableState } from "../state/types.js";
import { decodeRecoveryArchive, type RecoveryArchiveV1 } from "./schema.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION = /^[A-Za-z0-9_-]{16,256}$/;
const PREFIX = "restore-";

export type RecoveryImportErrorCode =
  | "RECOVERY_UNAVAILABLE"
  | "RESTORE_UNKNOWN"
  | "RESTORE_EXPIRED"
  | "RESTORE_SESSION_MISMATCH"
  | "RESTORE_STALE"
  | "RESTORE_NOT_CONFIRMED"
  | "RESTORE_INCOMPATIBLE"
  | "RESTORE_FAILED"
  | "RESTORE_OUTCOME_UNKNOWN";

export class RecoveryImportError extends Error {
  constructor(readonly code: RecoveryImportErrorCode, readonly operationId?: string) {
    super(code === "RECOVERY_UNAVAILABLE" ? "Device recovery is unavailable"
      : code === "RESTORE_EXPIRED" ? "The restore preview expired; preview the backup again"
      : code === "RESTORE_SESSION_MISMATCH" ? "The restore preview belongs to another session"
        : code === "RESTORE_STALE" ? "Device state changed after preview; preview the backup again"
          : code === "RESTORE_NOT_CONFIRMED" ? "Restore requires explicit confirmation"
            : code === "RESTORE_INCOMPATIBLE" ? "The backup is not compatible with this device"
              : code === "RESTORE_OUTCOME_UNKNOWN" ? "The restore outcome must be checked by operation ID"
                : code === "RESTORE_FAILED" ? "The backup could not be restored"
                  : "The restore preview is unavailable");
    this.name = "RecoveryImportError";
  }
}

export interface RestoreSummary {
  replacesLinuxOwner: boolean;
  replacesDeviceCredentials: boolean;
  replacesMeshIdentity: boolean;
  membershipCount: number;
  networkInterruption: boolean;
  warnings: string[];
  excluded: string[];
  compatibility: RecoveryCompatibilitySummary;
}

export interface RecoveryCompatibility {
  unavailableCameras: number;
  unavailableUarts: number;
  unavailableNetworkInterfaces: number;
  apFallbackReachable: true;
}

export interface RecoveryCompatibilitySummary extends RecoveryCompatibility {
  adjusted: boolean;
  crossBoard: boolean;
}

export interface RestorePreview {
  restoreId: string;
  destinationGeneration: string;
  expiresAt: number;
  summary: RestoreSummary;
}

interface Entry extends RestorePreview {
  sessionId: string;
  path: string;
  prepared: DurableState;
  compatibilityInput: RecoveryCompatibility;
}

export interface RecoveryClaim {
  archive: RecoveryArchiveV1;
  prepared: DurableState;
  compatibility: RecoveryCompatibility;
}

/** Root-private, process-local preview registry; abandoned files are removed on construction. */
export class RecoveryImportStore {
  private readonly entries = new Map<string, Entry>();
  private readonly expectedUid: number;

  constructor(
    private readonly root = "/run/yonder-admin/recovery",
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
    expectedUid?: number,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60_000) {
      throw new RecoveryImportError("RESTORE_FAILED");
    }
    this.expectedUid = expectedUid ?? (process.getuid?.() ?? 0);
    this.ensureRoot();
    for (const name of readdirSync(this.root)) {
      if (name.startsWith(PREFIX)) unlinkDurable(join(this.root, name));
    }
  }

  stage(input: {
    bytes: Uint8Array;
    archive: RecoveryArchiveV1;
    sessionId: string;
    destinationGeneration: string;
    destination: DurableState;
    prepared: DurableState;
    compatibility: RecoveryCompatibility;
    destinationBoard: RecoveryArchiveV1["source"]["board"];
  }): RestorePreview {
    this.expire();
    if (!SESSION.test(input.sessionId)) throw new RecoveryImportError("RESTORE_SESSION_MISMATCH");
    const restoreId = randomUUID();
    const path = join(this.root, `${PREFIX}${restoreId}.json`);
    writeFileDurable(path, Buffer.from(input.bytes).toString("utf8"), 0o600);
    const summary = summarize(input.destination, input.archive.payload, input.prepared,
      input.compatibility, input.archive.source.board, input.destinationBoard);
    const preview: RestorePreview = { restoreId, destinationGeneration: input.destinationGeneration,
      expiresAt: this.now() + this.ttlMs, summary };
    this.entries.set(restoreId, { ...preview, sessionId: input.sessionId, path,
      prepared: structuredClone(input.prepared), compatibilityInput: structuredClone(input.compatibility) });
    return structuredClone(preview);
  }

  claim(input: { restoreId: string; sessionId: string; destinationGeneration: string; currentVersion: string }): RecoveryClaim {
    if (!ID.test(input.restoreId)) throw new RecoveryImportError("RESTORE_UNKNOWN");
    const entry = this.entries.get(input.restoreId);
    if (!entry) throw new RecoveryImportError("RESTORE_UNKNOWN");
    if (entry.expiresAt <= this.now()) {
      this.discard(input.restoreId);
      throw new RecoveryImportError("RESTORE_EXPIRED");
    }
    this.expire();
    if (entry.sessionId !== input.sessionId) throw new RecoveryImportError("RESTORE_SESSION_MISMATCH");
    if (entry.destinationGeneration !== input.destinationGeneration) throw new RecoveryImportError("RESTORE_STALE");
    try {
      this.assertPrivateFile(entry.path);
      return { archive: decodeRecoveryArchive(readFileSync(entry.path), input.currentVersion),
        prepared: structuredClone(entry.prepared), compatibility: structuredClone(entry.compatibilityInput) };
    } catch (error) {
      this.discard(input.restoreId);
      throw error;
    }
  }

  discard(restoreId: string): void {
    const entry = this.entries.get(restoreId);
    if (!entry) return;
    this.entries.delete(restoreId);
    unlinkDurable(entry.path);
  }

  cancel(restoreId: string, sessionId: string): void {
    const entry = this.entries.get(restoreId);
    if (!entry) return;
    if (entry.sessionId !== sessionId) throw new RecoveryImportError("RESTORE_SESSION_MISMATCH");
    this.discard(restoreId);
  }

  private expire(): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > this.now()) continue;
      this.entries.delete(id);
      unlinkDurable(entry.path);
    }
  }

  private ensureRoot(): void {
    if (!existsSync(this.root)) { mkdirSync(this.root, { mode: 0o700 }); fsyncDir(dirname(this.root)); }
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== this.expectedUid || (info.mode & 0o777) !== 0o700) {
      throw new RecoveryImportError("RESTORE_FAILED");
    }
    chmodSync(this.root, 0o700);
  }

  private assertPrivateFile(path: string): void {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== this.expectedUid
      || (info.mode & 0o777) !== 0o600) throw new RecoveryImportError("RESTORE_FAILED");
  }
}

function summarize(
  destination: DurableState,
  incoming: DurableState,
  prepared: DurableState,
  compatibility: RecoveryCompatibility,
  sourceBoard: RecoveryArchiveV1["source"]["board"],
  destinationBoard: RecoveryArchiveV1["source"]["board"],
): RestoreSummary {
  const warnings = [
    "Restoring may disconnect current network and administrator sessions.",
    "Setup AP and fallback remain enabled; unavailable hardware will not start automatically.",
  ];
  if (prepared.zeroTier !== null) warnings.push("The original device must not run the restored mesh identity at the same time.");
  if (sourceBoard !== destinationBoard) warnings.push("Hardware-dependent settings were reconciled for this device.");
  if (compatibility.unavailableCameras > 0) warnings.push("Some saved cameras are unavailable on this device.");
  if (compatibility.unavailableUarts > 0) warnings.push("Some saved UART settings are unavailable on this device.");
  if (compatibility.unavailableNetworkInterfaces > 0) warnings.push("Some saved network interfaces are unavailable on this device.");
  return {
    replacesLinuxOwner: JSON.stringify(destination.linuxOwner) !== JSON.stringify(prepared.linuxOwner),
    replacesDeviceCredentials: JSON.stringify(destination.secrets) !== JSON.stringify(prepared.secrets),
    replacesMeshIdentity: destination.zeroTier?.identityPublic !== prepared.zeroTier?.identityPublic,
    membershipCount: prepared.zeroTier?.memberships.length ?? 0,
    networkInterruption: destination.zeroTier !== null || prepared.zeroTier !== null,
    warnings,
    excluded: ["recordings", "browser Flight state", "custom Node-RED flows and extensions", "operating-system files"],
    compatibility: { ...compatibility, adjusted: JSON.stringify(incoming) !== JSON.stringify(prepared),
      crossBoard: sourceBoard !== destinationBoard },
  };
}
