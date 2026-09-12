// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import type { AdminClient } from "../admin/client.js";
import { StateCoordinatorError } from "../state/coordinator.js";
import type { AdminCredential } from "../console/credential.js";
import type { AttemptThrottle } from "../console/throttle.js";
import type { RouteResult } from "./routes.js";
export type StorageToolsClient = Pick<AdminClient, "storageState" | "requestMaintenance">;
const inputSchema = z.object({ owner: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  currentPassword: z.string().max(1024), confirm: z.enum(["MAINTENANCE", "PROTECT"]) }).strict();
function answer(status: number, body: unknown): RouteResult { return { status, body, headers: { "cache-control": "no-store" } }; }
export async function storageToolsRoute(options: {
  client?: StorageToolsClient; credential?: AdminCredential; throttle: AttemptThrottle;
  reboot?: () => Promise<void>; refusal?: () => string | null;
}, method: string, path: string, body: unknown): Promise<RouteResult | null> {
  if (!["/storage/state", "/storage/enter", "/storage/exit"].includes(path)) return null;
  if (!options.credential?.isSet()) return answer(403, { error: "Set the console administrator password first." });
  if (method !== (path === "/storage/state" ? "GET" : "POST")) return answer(405, { error: "Method not allowed." });
  if (!options.client) return answer(503, { error: "Storage management is unavailable." });
  let operationId: string | undefined;
  try {
    if (path === "/storage/state") return answer(200, await options.client.storageState());
    const parsed = inputSchema.safeParse(body);
    if (!parsed.success || parsed.data.confirm !== (path === "/storage/enter" ? "MAINTENANCE" : "PROTECT"))
      return answer(400, { error: "Confirm the requested storage reboot." });
    const decision = options.throttle.check();
    if (!decision.allowed) return answer(429, { error: "Too many attempts. Try again later.", retryAfter: decision.retryAfter });
    const accepted = options.credential.verify(parsed.data.currentPassword); options.throttle.record(accepted);
    if (!accepted) return answer(401, { error: "The current console password was not accepted." });
    const refusal = options.refusal?.();
    if (refusal) return answer(409, { error: refusal });
    if (!options.reboot) return answer(503, { error: "System reboot is unavailable." });
    const state = await options.client.storageState();
    if (!state.managed) return answer(409, { error: "This installation uses conventional writable storage." });
    if (path === "/storage/enter") {
      if (!state.ownerConfigured) return answer(409, { error: "Create a Linux owner before entering maintenance." });
      if (state.mode !== "protected") return answer(409, { error: "The device is already in writable maintenance." });
      if (state.operation?.kind === "maintenance" && state.operation.phase === "awaiting-maintenance-reboot") operationId = state.operation.id;
      else operationId = (await options.client.requestMaintenance()).id;
    } else {
      if (state.mode !== "maintenance" || state.operation?.kind !== "maintenance")
        return answer(409, { error: "The device is not in writable maintenance." });
      operationId = state.operation.id;
    }
    await options.reboot();
    return answer(200, { ok: true, operationId, message: path === "/storage/enter"
      ? "Reboot scheduled in one minute. The next boot permits Linux package maintenance."
      : "Reboot scheduled in one minute. The next boot restores protected storage." });
  } catch (error) {
    if (error instanceof StateCoordinatorError && error.code === "STATE_BUSY")
      return answer(409, { error: "Finish the current device operation before changing storage mode.", code: "STATE_BUSY" });
    return answer(503, { error: operationId ? "The storage request is saved, but reboot scheduling failed. Check storage status before retrying."
      : "Storage mode could not be changed. Refresh its status before retrying.", ...(operationId ? { operationId } : {}) });
  }
}
