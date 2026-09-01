// SPDX-License-Identifier: GPL-3.0-or-later
import { ApplyEngine } from "../apply/engine.js";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../config/errors.js";
import { warn } from "../log.js";

export interface RouterDeps {
  engine: ApplyEngine;
  configPath: string;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

export type Router = (method: string, path: string, body: unknown) => Promise<RouteResult>;

export function createRouter(deps: RouterDeps): Router {
  return async (method, path, body) => {
    try {
      if (method === "GET" && path === "/config") {
        return { status: 200, body: loadConfig(deps.configPath) };
      }
      if (method === "GET" && path === "/status") {
        return { status: 200, body: deps.engine.status() };
      }
      if (method === "POST" && path === "/apply") {
        return { status: 200, body: await deps.engine.apply(body) };
      }
      if (method === "POST" && path === "/confirm") {
        const id = (body as { id?: string } | undefined)?.id;
        if (typeof id !== "string") return { status: 400, body: { error: "id is required" } };
        deps.engine.confirm(id);
        return { status: 200, body: deps.engine.status() };
      }
      return { status: 404, body: { error: `no route for ${method} ${path}` } };
    } catch (e) {
      // A ConfigError is written for the operator: it says what is wrong with
      // the configuration they sent, and its issues list is the whole point
      // of the route. It never carries anything from a subprocess.
      if (e instanceof ConfigError) {
        return { status: 400, body: { error: e.message, issues: e.issues } };
      }
      // Everything else does. A renderer failure arrives here as an
      // NmcliError whose message embeds nmcli's stderr verbatim, and echoing
      // an arbitrary error message into an HTTP body is how that leaves the
      // device. NmcliError does not extend ConfigError, so it fell straight
      // through to this branch.
      //
      // The detail goes to the journal, which needs being on the device to
      // read — and being on the device is exactly what the caller of this API
      // may not yet be. The response says only that something failed.
      warn(`${method} ${path} failed: ${(e as Error).message}`);
      return {
        status: 500,
        body: { error: "the request failed; see the device journal for the reason" },
      };
    }
  };
}
