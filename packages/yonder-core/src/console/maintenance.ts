// SPDX-License-Identifier: GPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonClient } from "./client.js";

/** Narrow, authenticated HTTP transport. Passwords never enter flow/socket stores. */
export function maintenanceProxy(options: {
  client: DaemonClient; session: (request: IncomingMessage) => string | undefined;
  passwordChanged: () => void;
}) {
  const routes: Record<string, [string, string]> = {
    "/maintenance/api/interfaces": ["GET", "/net/interfaces"],
    "/maintenance/api/preferences": ["GET", "/ui/preferences"],
    "/maintenance/api/theme": ["POST", "/ui/theme"],
    "/maintenance/api/password": ["POST", "/admin/change-password"],
    "/maintenance/api/reboot": ["POST", "/system/reboot"],
    "/maintenance/api/diagnostics": ["POST", "/diag/jobs"],
  };
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = (req.url ?? "").split("?")[0]!;
    const job = /^\/maintenance\/api\/diagnostics\/([a-f0-9-]{36})(\/cancel)?$/.exec(path);
    const route = routes[path] ?? (job ? [job[2] ? "POST" : "GET", `/diag/jobs/${job[1]}${job[2] ?? ""}`] : undefined);
    if (!path.startsWith("/maintenance/api/")) return false;
    const answer = (status: number, body: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    const owner = options.session(req);
    if (!owner) { answer(401, { error: "Sign in to use the device tools." }); return true; }
    if (!route) { answer(404, { error: "No such device tool." }); return true; }
    if (req.method !== route[0]) { answer(405, { error: "Method not allowed." }); return true; }
    if (req.method === "POST") {
      const origin = req.headers.origin;
      try {
        if (origin !== undefined && (!/^https?:$/.test(new URL(origin).protocol) || new URL(origin).host !== req.headers.host))
          throw new Error("origin");
      } catch { answer(403, { error: "Use the current console to run this action." }); return true; }
      if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" || req.headers["x-yonder-maintenance"] !== "1") {
        answer(415, { error: "A console JSON request is required." }); return true;
      }
    }
    void (async () => {
      let body: unknown;
      if (req.method === "POST") {
        let length = 0; const chunks: Buffer[] = [];
        try {
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 8 * 1024) { req.resume(); answer(413, { error: "Request is too large." }); return; }
            chunks.push(Buffer.from(chunk));
          }
          const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("shape");
          body = { ...input, owner };
        } catch { answer(400, { error: "Invalid JSON request." }); return; }
      }
      const reply = await options.client.request({
        method: route[0]!, path: route[1]! + (job && req.method === "GET" ? `?owner=${encodeURIComponent(owner)}` : ""),
        ...(body === undefined ? {} : { body }),
        ...(path.endsWith("/theme") ? { timeoutMs: 60_000 } : {}),
      });
      if (!reply.ok) { answer(503, { error: "The device service did not answer. Refresh to check its state before retrying." }); return; }
      if (path.endsWith("/password") && reply.status === 200) options.passwordChanged();
      answer(reply.status, reply.body);
    })().catch(() => answer(503, { error: "The device service is unavailable." }));
    return true;
  };
}
