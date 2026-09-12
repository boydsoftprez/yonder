// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import { RecoveryAdminError, type AdminClient } from "../admin/client.js";
import { decodeRecoveryBase64, MAX_RECOVERY_BASE64_BYTES } from "../admin/protocol.js";
import { StateCoordinatorError } from "../state/coordinator.js";
import type { AdminCredential } from "../console/credential.js";
import type { AttemptThrottle } from "../console/throttle.js";
import type { RouteResult } from "./routes.js";

export type RecoveryToolsClient = Pick<AdminClient, "exportRecovery" | "previewRecovery" | "commitRecovery" | "cancelRecovery">;
const session = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const auth = { owner: session, currentPassword: z.string().max(1024) };
const forms = {
  "/recovery/export": z.object(auth).strict(),
  "/recovery/preview": z.object({ ...auth, archiveBase64: z.string().min(4).max(MAX_RECOVERY_BASE64_BYTES) }).strict(),
  "/recovery/commit": z.object({ ...auth, restoreId: z.string().uuid(), destinationGeneration: z.string().uuid(), confirm: z.literal(true) }).strict(),
  "/recovery/cancel": z.object({ owner: session, restoreId: z.string().uuid() }).strict(),
};
function answer(status: number, body: unknown): RouteResult {
  return { status, body, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } };
}

export async function recoveryToolsRoute(options: {
  client?: RecoveryToolsClient; credential?: AdminCredential; throttle: AttemptThrottle;
  runtimeGeneration?: string;
  restoreRefusal?: () => string | null;
  /** Install the restored generation into running services before acknowledging success. */
  afterRestore?: (result: { operationId: string; generation: string }) => Promise<void>;
}, method: string, path: string, body: unknown): Promise<RouteResult | null> {
  if (!Object.hasOwn(forms, path)) return null;
  if (method !== "POST") return answer(405, { error: "Method not allowed." });
  if (!options.credential?.isSet()) return answer(403, { error: "Set the console administrator password first." });
  if (!options.client) return answer(503, { error: "Device recovery is unavailable." });
  const parsed = forms[path as keyof typeof forms].safeParse(body);
  if (!parsed.success) return answer(400, { error: "Check the recovery request and try again." });
  try {
    const input = parsed.data;
    if ("currentPassword" in input) {
      const decision = options.throttle.check();
      if (!decision.allowed) return answer(429, { error: "Too many attempts. Try again later.", retryAfter: decision.retryAfter });
      const accepted = options.credential.verify(input.currentPassword);
      options.throttle.record(accepted);
      if (!accepted) return answer(401, { error: "The current console password was not accepted." });
    }
    if (path === "/recovery/export") {
      const bytes = await options.client.exportRecovery();
      return answer(200, { archiveBase64: bytes.toString("base64") });
    }
    if (path === "/recovery/preview") {
      const preview = forms["/recovery/preview"].parse(body);
      const bytes = decodeRecoveryBase64(preview.archiveBase64);
      return answer(200, await options.client.previewRecovery({ bytes, sessionId: preview.owner }));
    }
    if (path === "/recovery/commit") {
      const commit = forms["/recovery/commit"].parse(body);
      const refusal = options.restoreRefusal?.();
      if (refusal) return answer(409, { error: refusal });
      if (!options.afterRestore || !options.runtimeGeneration) return answer(503, { error: "Restore activation is unavailable." });
      const result = await options.client.commitRecovery({ restoreId: commit.restoreId,
        sessionId: commit.owner, destinationGeneration: commit.destinationGeneration, confirm: true,
        runtimeGeneration: options.runtimeGeneration });
      try { await options.afterRestore(result); }
      catch { return answer(503, { error: "Restore was committed but service activation needs recovery. Reboot and check the device.", code: "RESTORE_OUTCOME_UNKNOWN", operationId: result.operationId }); }
      return answer(200, { ...result, signInAgain: true });
    }
    if (path === "/recovery/cancel") {
      const cancel = forms["/recovery/cancel"].parse(body);
      await options.client.cancelRecovery({ restoreId: cancel.restoreId, sessionId: cancel.owner });
      return answer(200, { ok: true });
    }
    return answer(400, { error: "Invalid recovery request." });
  } catch (error) {
    if (error instanceof RecoveryAdminError) return answer(
      ["RESTORE_STALE", "RESTORE_SESSION_MISMATCH"].includes(error.code) ? 409
        : ["RESTORE_FAILED", "RESTORE_OUTCOME_UNKNOWN", "RECOVERY_UNAVAILABLE"].includes(error.code) ? 503 : 400,
      { error: error.message, code: error.code, ...(error.operationId ? { operationId: error.operationId } : {}) });
    if (error instanceof StateCoordinatorError && error.code === "STATE_BUSY")
      return answer(409, { error: "Finish the current device operation before using recovery.", code: "STATE_BUSY" });
    return answer(503, { error: "Recovery did not complete. Check device state before retrying." });
  }
}
