// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from "zod";
import { OwnerAdminError, type AdminClient } from "../admin/client.js";
import { StateCoordinatorError } from "../state/coordinator.js";
import type { AdminCredential } from "../console/credential.js";
import type { AttemptThrottle } from "../console/throttle.js";
import type { RouteResult } from "./routes.js";

export type OwnerToolsClient = Pick<AdminClient, "ownerState" | "createOwner" | "changeOwnerPassword" | "configureOwnerSsh">;
const auth = {
  owner: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  currentPassword: z.string().max(1024),
};
const create = z.object({ ...auth, username: z.string().max(64), newPassword: z.string().max(1024), confirmPassword: z.string().max(1024) }).strict();
const password = z.object({ ...auth, newPassword: z.string().max(1024), confirmPassword: z.string().max(1024) }).strict();
const ssh = z.object({ ...auth, enabled: z.boolean(), passwordAuthentication: z.boolean(), authorizedKeys: z.array(z.string().max(16 * 1024)).max(64).optional() }).strict();
function answer(status: number, body: unknown): RouteResult {
  return { status, body, headers: { "cache-control": "no-store" } };
}

/** Public proxy authenticates the session; core reauthenticates every mutation. */
export async function ownerToolsRoute(options: {
  client?: OwnerToolsClient;
  credential?: AdminCredential;
  throttle: AttemptThrottle;
}, method: string, path: string, body: unknown): Promise<RouteResult | null> {
  if (!["/owner/state", "/owner/create", "/owner/password", "/owner/ssh"].includes(path)) return null;
  if (!options.credential?.isSet()) return answer(403, { error: "Set the console administrator password first." });
  if ((path === "/owner/state" ? "GET" : "POST") !== method) return answer(405, { error: "Method not allowed." });
  if (!options.client) return answer(503, { error: "Linux owner access is unavailable." });
  try {
    if (path === "/owner/state") return answer(200, await options.client.ownerState());
    const parsed = (path === "/owner/create" ? create : path === "/owner/password" ? password : ssh).safeParse(body);
    if (!parsed.success) return answer(400, { error: "Check the Linux account form and try again." });
    const decision = options.throttle.check();
    if (!decision.allowed) return answer(429, { error: "Too many attempts. Try again later.", retryAfter: decision.retryAfter });
    const accepted = options.credential.verify(parsed.data.currentPassword);
    options.throttle.record(accepted);
    if (!accepted) return answer(401, { error: "The current console password was not accepted." });
    const { owner: _session, currentPassword: _currentPassword, ...input } = parsed.data;
    let result;
    if (path === "/owner/create") result = await options.client.createOwner(input as z.infer<typeof create>);
    else if (path === "/owner/password") result = await options.client.changeOwnerPassword(input as z.infer<typeof password>);
    else result = await options.client.configureOwnerSsh(input as z.infer<typeof ssh>);
    return answer(200, result);
  } catch (error) {
    if (error instanceof OwnerAdminError) {
      const status = error.code === "OWNER_OUTCOME_UNKNOWN" ? 503
        : error.code === "OWNER_UNAVAILABLE" ? 503
          : ["OWNER_ALREADY_CONFIGURED", "OWNER_DESTINATION_CONFLICT"].includes(error.code) ? 409 : 400;
      return answer(status, { error: error.message, code: error.code,
        ...(error.operationId ? { operationId: error.operationId } : {}) });
    }
    if (error instanceof StateCoordinatorError && error.code === "STATE_BUSY") {
      return answer(409, { error: "Finish the current device operation before changing Linux access.", code: "STATE_BUSY" });
    }
    return answer(503, { error: "Linux access could not be updated. Check its current state before retrying." });
  }
}
