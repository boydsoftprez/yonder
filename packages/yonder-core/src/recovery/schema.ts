// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DurableStateSchema, type DurableState } from "../state/types.js";
import { validateOwnerRecord } from "../owner-access/model.js";
import { canonicalJson, CanonicalSizeError } from "./canonical.js";
import { validateCanonicalZeroTierState } from "./zerotier.js";

export const MAX_RECOVERY_ARCHIVE_BYTES = 4 * 1024 * 1024;
const VERSION = /^([1-9][0-9]{3})\.(0|[1-9][0-9]?)\.(0|[1-9][0-9]*)$/;
const SourceSchema = z.object({
  version: z.string().regex(VERSION).max(32),
  board: z.enum(["rpi", "radxa-zero3w", "radxa-rock5c", "conventional"]),
  configSchemaVersion: z.literal(1),
}).strict();
const ArchiveSchema = z.object({
  format: z.literal("yonder-recovery"), formatVersion: z.literal(1),
  source: SourceSchema, createdAt: z.string().datetime(),
  payload: DurableStateSchema,
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RecoverySource = z.infer<typeof SourceSchema>;
export type RecoveryArchiveV1 = z.infer<typeof ArchiveSchema>;
export class RecoveryArchiveError extends Error {
  constructor(readonly code: "ARCHIVE_TOO_LARGE" | "ARCHIVE_INVALID" | "VERSION_UNSUPPORTED") {
    super(code === "ARCHIVE_TOO_LARGE" ? "Recovery archive exceeds 4 MiB"
      : code === "VERSION_UNSUPPORTED" ? "Recovery archive version is not supported by this Yonder version"
        : "Recovery archive is invalid or its checksum does not match");
    this.name = "RecoveryArchiveError";
  }
}
function versionParts(value: string): bigint[] {
  const match = VERSION.exec(value);
  if (!match || value.length > 32 || Number(match[2]) < 1 || Number(match[2]) > 12) throw new RecoveryArchiveError("VERSION_UNSUPPORTED");
  return match.slice(1).map(part => BigInt(part!));
}
function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) { if (a[i]! < b[i]!) return -1; if (a[i]! > b[i]!) return 1; }
  return 0;
}
function validatePayload(payload: unknown): DurableState {
  const canonical = canonicalJson(payload);
  const state = DurableStateSchema.parse(payload);
  if (state.linuxOwner) validateOwnerRecord(state.linuxOwner);
  if (state.zeroTier) validateCanonicalZeroTierState(state.zeroTier);
  // Existing configuration parsers may strip unknown keys or supply defaults.
  // An archive must contain the exact expanded state, not silently lose fields.
  if (canonicalJson(state) !== canonical) throw new Error("State fields differ");
  return state;
}
function digest(payload: DurableState): string { return createHash("sha256").update(canonicalJson(payload)).digest("hex"); }

export function encodeRecoveryArchive(state: DurableState, source: RecoverySource, now = new Date()): Buffer {
  try {
    versionParts(source.version);
    const payload = validatePayload(state);
    const archive = ArchiveSchema.parse({ format: "yonder-recovery", formatVersion: 1, source,
      createdAt: now.toISOString(), payload, payloadSha256: digest(payload) });
    const bytes = Buffer.from(canonicalJson(archive) + "\n", "utf8");
    if (bytes.length > MAX_RECOVERY_ARCHIVE_BYTES) throw new RecoveryArchiveError("ARCHIVE_TOO_LARGE");
    return bytes;
  } catch (error) {
    if (error instanceof CanonicalSizeError) throw new RecoveryArchiveError("ARCHIVE_TOO_LARGE");
    if (error instanceof RecoveryArchiveError) throw error;
    throw new RecoveryArchiveError("ARCHIVE_INVALID");
  }
}

/** No files, paths or native commands are read while parsing an archive. */
export function decodeRecoveryArchive(bytes: Uint8Array, currentVersion: string): RecoveryArchiveV1 {
  if (bytes.byteLength > MAX_RECOVERY_ARCHIVE_BYTES) throw new RecoveryArchiveError("ARCHIVE_TOO_LARGE");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const raw: unknown = JSON.parse(text);
    canonicalJson(raw); // Bound depth/node count before recursive schema parsing.
    const archive = ArchiveSchema.parse(raw);
    const rawPayload = (raw as { payload: unknown }).payload;
    archive.payload = validatePayload(rawPayload);
    // Format 1 was introduced with 2026.9.0; no implicit migrations from an
    // earlier or newer application's archive are claimed.
    if (compareVersions(archive.source.version, "2026.9.0") < 0
      || compareVersions(archive.source.version, currentVersion) > 0) throw new RecoveryArchiveError("VERSION_UNSUPPORTED");
    const actual = Buffer.from(digest(archive.payload), "hex");
    if (!timingSafeEqual(actual, Buffer.from(archive.payloadSha256, "hex"))) throw new Error("Checksum mismatch");
    return archive;
  } catch (error) {
    if (error instanceof RecoveryArchiveError) throw error;
    throw new RecoveryArchiveError("ARCHIVE_INVALID");
  }
}
