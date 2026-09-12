// SPDX-License-Identifier: GPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DaemonClient } from "./client.js";

export interface CockpitProxyOptions {
  client: DaemonClient;
  session: (request: IncomingMessage) => string | undefined;
}
const MAX_BODY = 512 * 1024;
const routes: Record<string, { method: string; path: string }> = {
  "/cockpit/api/terrain-service/policy": {method:"GET",path:"/cockpit/terrain-service/policy"},
  "/cockpit/api/terrain-service/policy/apply": {method:"POST",path:"/cockpit/terrain-service/policy/apply"},
  "/cockpit/api/terrain-service/policy/confirm": {method:"POST",path:"/cockpit/terrain-service/policy/confirm"},
  "/cockpit/api/terrain-service/policy/revert": {method:"POST",path:"/cockpit/terrain-service/policy/revert"},
  "/cockpit/api/terrain-service": {method: "GET", path: "/cockpit/terrain-service"},
  "/cockpit/api/terrain-service/preview": {method: "POST", path: "/cockpit/terrain-service/preview"},
  "/cockpit/api/terrain-service/prepare": {method: "POST", path: "/cockpit/terrain-service/prepare"},
  "/cockpit/api/terrain-service/cancel": {method: "POST", path: "/cockpit/terrain-service/cancel"},
  "/cockpit/api/terrain-service/pin": {method: "POST", path: "/cockpit/terrain-service/pin"},
  "/cockpit/api/terrain-service/remove": {method: "POST", path: "/cockpit/terrain-service/remove"},
  "/cockpit/api/terrain-service/refresh-controller": {method: "POST", path: "/cockpit/terrain-service/refresh-controller"},
  "/cockpit/api/terrain-service/samples": {method: "POST", path: "/cockpit/terrain-service/samples"},
  "/cockpit/api/flight": { method: "GET", path: "/cockpit/flight" },
  "/cockpit/api/instruments": { method: "GET", path: "/cockpit/instruments" },
  "/cockpit/api/details": { method: "GET", path: "/cockpit/details" },
  "/cockpit/api/mission": { method: "GET", path: "/cockpit/mission" },
  "/cockpit/api/traffic": { method: "GET", path: "/cockpit/traffic" },
  "/cockpit/api/state": { method: "GET", path: "/cockpit/state" },
  "/cockpit/api/terrain/manifest": {
    method: "GET",
    path: "/cockpit/terrain/manifest",
  },
  "/cockpit/api/data-options": {
    method: "POST",
    path: "/cockpit/data-options",
  },
  "/cockpit/api/command": { method: "POST", path: "/cockpit/command" },
};
function answer(res: ServerResponse, status: number, body: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  // Drain an oversized request without retaining its bytes or killing the
  // connection before the browser can receive the 413 response.
  for await (const chunk of req) {
    length += chunk.length;
    if (length <= MAX_BODY) chunks.push(Buffer.from(chunk));
    else {
      req.resume();
      throw new Error("large");
    }
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new Error("shape");
  return body;
}
/** R-FLT-02: a narrow same-origin gateway, with provenance from the session. */
export function cockpitProxy(options: CockpitProxyOptions) {
  return (request: IncomingMessage, response: ServerResponse): boolean => {
    const path = (request.url ?? "").split("?")[0]!;
    const terrainTile =
      /^\/cockpit\/api\/terrain\/tile\/[a-zA-Z0-9_.-]{1,96}$/.test(path);
    const tile =
      terrainTile ||
      /^\/cockpit\/api\/tiles\/(elevation|imagery|places|roads)\/\d{1,2}\/\d{1,7}\/\d{1,7}$/.test(
        path,
      );
    const trail=/^\/cockpit\/api\/trail(?:\/[a-zA-Z0-9-]{1,64}\/\d{1,12}(?:\/\d{1,12}\/\d{1,12})?)?$/.test(path);
    const route =
      routes[path] ??
      (tile||trail
        ? { method: "GET", path: path.replace("/cockpit/api/", "/cockpit/") }
        : undefined);
    if (!route) return false;
    const sessionId = options.session(request);
    if (!sessionId) {
      answer(response, 401, { error: "Sign in to use the cockpit." });
      return true;
    }
    if (request.method !== route.method) {
      answer(response, 405, { error: "Method not allowed." });
      return true;
    }
    if (route.method === "POST") {
      const origin = request.headers.origin;
      if (origin !== undefined) {
        let sameOrigin = false;
        try {
          const parsed = new URL(origin);
          sameOrigin =
            ["http:", "https:"].includes(parsed.protocol) &&
            parsed.host === request.headers.host;
        } catch {
          /* Invalid origins are not a same-origin request. */
        }
        if (!sameOrigin) {
          answer(response, 403, {
            error: "Use this console to issue cockpit commands.",
          });
          return true;
        }
      }
      if (
        request.headers["content-type"]?.split(";")[0]?.trim() !==
          "application/json" ||
        request.headers["x-yonder-cockpit"] !== "1"
      ) {
        answer(response, 415, { error: "A cockpit JSON request is required." });
        return true;
      }
    }
    void (async () => {
      let body: unknown;
      if (route.method === "POST") {
        try {
          body = { ...((await bodyOf(request)) as object), sessionId };
        } catch (error) {
          answer(
            response,
            error instanceof Error && error.message === "large" ? 413 : 400,
            { error: "Invalid or oversized cockpit request." },
          );
          return;
        }
      }
      const reply = await options.client.request({
        method: route.method,
        path: route.path,
        ...(body === undefined ? {} : { body }),
      });
      if (!reply.ok) {
        answer(response, 503, {
          error:
            route.method === "POST"
              ? "The flight service did not answer. The command outcome is unknown; check operation status before retrying."
              : "The flight service is unavailable.",
        });
      } else if (tile && reply.status === 200) {
        const result = reply.body as { data?: unknown; type?: unknown };
        if (
          typeof result?.data !== "string" ||
          result.data.length > 750000 ||
          !(terrainTile
            ? result.type === "application/octet-stream"
            : ["image/png", "image/jpeg"].includes(String(result.type)))
        ) {
          answer(response, 502, { error: "Invalid geographic tile reply" });
          return;
        }
        const bytes = Buffer.from(result.data, "base64");
        response.writeHead(200, {
          "content-type": String(result.type),
          "content-length": bytes.length,
          "cache-control": "private, no-store",
        });
        response.end(bytes);
      } else answer(response, reply.status, reply.body);
    })().catch(() =>
      answer(response, 503, { error: "The cockpit service is unavailable." }),
    );
    return true;
  };
}
