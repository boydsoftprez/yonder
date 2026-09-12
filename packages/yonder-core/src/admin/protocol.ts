// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import { DurableStateSchema, MAX_DURABLE_STATE_BYTES, MAX_STANDARD_CONTROL_BYTES, StateKindSchema } from "../state/types.js";
import { MAX_RECOVERY_ARCHIVE_BYTES } from "../recovery/schema.js";

export const MAX_RECOVERY_BASE64_BYTES = Math.ceil(MAX_RECOVERY_ARCHIVE_BYTES / 3) * 4;
export const MAX_ADMIN_FRAME_BYTES = Math.max(MAX_DURABLE_STATE_BYTES, MAX_RECOVERY_BASE64_BYTES)
  + MAX_STANDARD_CONTROL_BYTES;
const MAX_JSON_DEPTH = 64;
const UUID = z.string().uuid();
const OwnerPassword = z.string().max(1024);

export const OWNER_ADMIN_ERROR_MESSAGES = {
  OWNER_UNAVAILABLE: "Linux owner access is unavailable",
  OWNER_ALREADY_CONFIGURED: "A Linux owner is already configured",
  OWNER_NOT_CONFIGURED: "Create a Linux owner first",
  OWNER_PASSWORD_MISMATCH: "The Linux passwords do not match",
  OWNER_OUTCOME_UNKNOWN: "Linux access outcome needs recovery; check device state before retrying",
  OWNER_INVALID_USERNAME: "Invalid Linux access username",
  OWNER_INVALID_PASSWORD: "Invalid Linux access password",
  OWNER_INVALID_PUBLIC_KEY: "Invalid Linux access public key",
  OWNER_INVALID_PASSWORD_HASH: "Invalid Linux access password hash",
  OWNER_INVALID_RECORD: "Invalid Linux access record",
  OWNER_DESTINATION_CONFLICT: "The Linux account name or home is already in use",
  OWNER_NATIVE_STATE_INVALID: "Linux account state could not be verified",
  OWNER_POLICY_MISMATCH: "Linux login policy could not be verified",
} as const;
export type OwnerAdminErrorCode = keyof typeof OWNER_ADMIN_ERROR_MESSAGES;

export const RECOVERY_ADMIN_ERROR_MESSAGES = {
  RECOVERY_UNAVAILABLE: "Device recovery is unavailable",
  RESTORE_UNKNOWN: "The restore preview is unavailable",
  RESTORE_EXPIRED: "The restore preview expired; preview the backup again",
  RESTORE_SESSION_MISMATCH: "The restore preview belongs to another session",
  RESTORE_STALE: "Device state changed after preview; preview the backup again",
  RESTORE_NOT_CONFIRMED: "Restore requires explicit confirmation",
  RESTORE_INCOMPATIBLE: "The backup is not compatible with this device",
  RESTORE_FAILED: "The backup could not be restored",
  RESTORE_OUTCOME_UNKNOWN: "The restore outcome must be checked by operation ID",
  ARCHIVE_TOO_LARGE: "Recovery archive exceeds 4 MiB",
  ARCHIVE_INVALID: "Recovery archive is invalid or its checksum does not match",
  VERSION_UNSUPPORTED: "Recovery archive version is not supported by this Yonder version",
  ZEROTIER_UNAVAILABLE: "ZeroTier is unavailable on this device",
  ZEROTIER_IDENTITY_INVALID: "The ZeroTier identity is invalid",
  ZEROTIER_STATE_INVALID: "The ZeroTier state could not be safely read or projected",
  ZEROTIER_SERVICE_FAILED: "The ZeroTier service could not be safely restored",
} as const;
export type RecoveryAdminErrorCode = keyof typeof RECOVERY_ADMIN_ERROR_MESSAGES;

const Session = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const RecoveryBase64 = z.string().min(4).max(MAX_RECOVERY_BASE64_BYTES);

const Methods = {
  "storage.status": z.object({}).strict(),
  "storage.maintenance.request": z.object({}).strict(),
  "state.status": z.object({}).strict(),
  "state.active": z.object({}).strict(),
  "state.begin": z.object({ id: UUID, kind: StateKindSchema, expectedActiveGeneration: UUID.optional() }).strict(),
  "state.stage": z.object({ id: UUID, state: DurableStateSchema }).strict(),
  "state.activate": z.object({ id: UUID }).strict(),
  "state.hold": z.object({ id: UUID }).strict(),
  "state.commit": z.object({ id: UUID }).strict(),
  "state.commit.restart": z.object({ id: UUID, runtimeGeneration: UUID }).strict(),
  "state.rollback": z.object({ id: UUID, reasonCode: z.string().min(1).max(128) }).strict(),
  "state.snapshot.begin": z.object({ id: UUID }).strict(),
  "state.snapshot.release": z.object({ id: UUID }).strict(),
  "state.recover": z.object({}).strict(),
  "state.runtime.acknowledge": z.object({ operationId: UUID, generation: UUID, runtimeGeneration: UUID }).strict(),
  "owner.state": z.object({}).strict(),
  "owner.create": z.object({
    username: z.string().max(64),
    newPassword: OwnerPassword,
    confirmPassword: OwnerPassword,
  }).strict(),
  "owner.password": z.object({
    newPassword: OwnerPassword,
    confirmPassword: OwnerPassword,
  }).strict(),
  "owner.ssh": z.object({
    enabled: z.boolean(),
    passwordAuthentication: z.boolean(),
    authorizedKeys: z.array(z.string().max(16 * 1024)).max(64).optional(),
  }).strict(),
  "recovery.export": z.object({}).strict(),
  "recovery.preview": z.object({ archiveBase64: RecoveryBase64, sessionId: Session }).strict(),
  "recovery.commit": z.object({
    restoreId: UUID,
    sessionId: Session,
    destinationGeneration: UUID,
    runtimeGeneration: UUID,
    confirm: z.boolean(),
  }).strict(),
  "recovery.cancel": z.object({ restoreId: UUID, sessionId: Session }).strict(),
} as const;

export type AdminMethod = keyof typeof Methods;
export interface AdminRequest {
  id: string;
  method: AdminMethod;
  params: Record<string, unknown>;
}

export type AdminReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string; operationId?: string } };

export class AdminProtocolError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "REQUEST_TOO_LARGE" | "RESPONSE_TOO_LARGE", message: string) {
    super(message);
    this.name = "AdminProtocolError";
  }
}

function assertDepth(text: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) throw new AdminProtocolError("INVALID_REQUEST", "admin request nesting is invalid");
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) throw new AdminProtocolError("INVALID_REQUEST", "admin request structure is invalid");
    }
  }
  if (quoted || depth !== 0) throw new AdminProtocolError("INVALID_REQUEST", "admin request is not valid JSON");
}

export function decodeAdminRequest(text: string): AdminRequest {
  const size = Buffer.byteLength(text, "utf8");
  if (size > MAX_ADMIN_FRAME_BYTES) {
    throw new AdminProtocolError("REQUEST_TOO_LARGE", "admin request exceeds its size limit");
  }
  assertDepth(text);
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new AdminProtocolError("INVALID_REQUEST", "admin request is not valid JSON"); }
  const envelope = z.object({ id: UUID, method: z.string(), params: z.unknown() }).strict().safeParse(input);
  if (!envelope.success || !(envelope.data.method in Methods)) {
    throw new AdminProtocolError("INVALID_REQUEST", "admin request is not allowlisted");
  }
  const method = envelope.data.method as AdminMethod;
  const methodLimit = method === "state.stage"
    ? MAX_DURABLE_STATE_BYTES + MAX_STANDARD_CONTROL_BYTES
    : method === "recovery.preview"
      ? MAX_RECOVERY_BASE64_BYTES + MAX_STANDARD_CONTROL_BYTES
      : MAX_STANDARD_CONTROL_BYTES;
  if (size > methodLimit) {
    throw new AdminProtocolError("REQUEST_TOO_LARGE", "admin control request exceeds 64 KiB");
  }
  const params = Methods[method].safeParse(envelope.data.params);
  if (!params.success) throw new AdminProtocolError("INVALID_REQUEST", "admin request parameters are invalid");
  if (method === "recovery.preview") decodeRecoveryBase64((params.data as { archiveBase64: string }).archiveBase64);
  return { id: envelope.data.id, method, params: params.data };
}

/** Decode only canonical padded base64, and enforce the archive bound after decoding. */
export function decodeRecoveryBase64(value: string): Buffer {
  if (value.length < 4 || value.length > MAX_RECOVERY_BASE64_BYTES || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new AdminProtocolError("INVALID_REQUEST", "recovery archive encoding is invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > MAX_RECOVERY_ARCHIVE_BYTES) {
    throw new AdminProtocolError("REQUEST_TOO_LARGE", "recovery archive exceeds 4 MiB");
  }
  if (bytes.toString("base64") !== value) {
    throw new AdminProtocolError("INVALID_REQUEST", "recovery archive encoding is invalid");
  }
  return bytes;
}

export function requestFrameLimit(method: AdminMethod): number {
  return method === "state.stage"
    ? MAX_DURABLE_STATE_BYTES + MAX_STANDARD_CONTROL_BYTES
    : method === "recovery.preview"
      ? MAX_RECOVERY_BASE64_BYTES + MAX_STANDARD_CONTROL_BYTES
      : MAX_STANDARD_CONTROL_BYTES;
}

export function responseFrameLimit(method: AdminMethod): number {
  return method === "recovery.export"
    ? MAX_RECOVERY_BASE64_BYTES + MAX_STANDARD_CONTROL_BYTES
    : MAX_STANDARD_CONTROL_BYTES;
}

export function encodeAdminMessage(message: AdminReply | AdminRequest, replyTo?: AdminMethod): string {
  let encoded: string;
  try { encoded = `${JSON.stringify(message)}\n`; } catch {
    throw new AdminProtocolError("RESPONSE_TOO_LARGE", "admin response could not be encoded");
  }
  const limit = "method" in message ? requestFrameLimit(message.method)
    : replyTo === undefined ? MAX_STANDARD_CONTROL_BYTES : responseFrameLimit(replyTo);
  if (Buffer.byteLength(encoded) > limit) {
    throw new AdminProtocolError("RESPONSE_TOO_LARGE", "admin response exceeds its size limit");
  }
  return encoded;
}
