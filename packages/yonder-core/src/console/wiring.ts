// SPDX-License-Identifier: GPL-3.0-or-later
import { DaemonClient } from "./client.js";
import { SessionStore } from "./session.js";
import { setupMiddleware, consoleMiddleware, type Middleware } from "./middleware.js";

/**
 * The one thing a generated `settings.js` calls into.
 *
 * `settings.js` is generated (settings.ts) and must stay a description: a
 * list of values, plus a call to each function here. Everything with a
 * decision in it lives in this package, where it has source files and tests —
 * the same reason CLAUDE.md rule 2 keeps logic out of `flows.json`. A
 * generated file with behaviour in it is a file nobody can review a diff of.
 *
 * Keeping the surface to two functions is meant to keep the module graph
 * small as well, and it is worth writing down what that graph is rather than
 * what it was intended to be. Measured, by resolving every import reachable
 * from this file: 105 modules, 72 of them `yaml` and 10 `zod`. **Every one of
 * those 82 arrives through a single edge** — `middleware.ts` takes the string
 * `CONSOLE_HOME` from `settings.ts`, which loads configuration in order to
 * generate a settings file, and loading configuration reaches the schema. One
 * constant, and the parser and the validator come with it.
 *
 * The stream handshake route was very nearly the second such edge: it needs
 * the media server's WebRTC port, which lived beside the code that writes
 * that server's YAML. It reads `media/ports.js` instead — a file that imports
 * nothing at all — and so costs this graph one module rather than the
 * seventy-six that `media/config.js` brings. Giving `CONSOLE_HOME` the same
 * treatment is what would make the first sentence true.
 */

/** The username the flow editor's login expects. There is one administrator. */
export const ADMIN_USERNAME = "admin";

export interface GateOptions {
  /** The daemon's Unix socket. */
  socketPath: string;
  /**
   * Whether this device has an administrator password.
   *
   * Decided when `settings.js` was generated, not per request. That is what
   * makes R-SEC-09 structural rather than conditional: an unprovisioned
   * console is mounted with a middleware that has no console behind it, no
   * flows to serve and no editor to reach.
   */
  provisioned: boolean;
  log?: (line: string) => void;
}

/**
 * The middleware Node-RED mounts in front of everything under
 * `httpNodeRoot`.
 *
 * `httpNodeAuth`, not `httpNodeMiddleware`. The latter is consulted only by
 * the `http in` node, so on a console with no flows at all — which is exactly
 * what setup mode is — it would never run and the setup page would never be
 * served. `httpNodeAuth`, when it is a function, is applied by Node-RED's own
 * `red.js` with `app.use(httpNodeRoot, fn)` whether or not any flow exists.
 * It is also the hook that *means* this: it is where Node-RED expects
 * authentication for everything it serves under that root.
 */
export function consoleGate(opts: GateOptions): Middleware {
  const client = new DaemonClient({ socketPath: opts.socketPath });
  const log = opts.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (!opts.provisioned) {
    return setupMiddleware({ client, log });
  }
  return consoleMiddleware({ client, sessions: new SessionStore(), log });
}

/** What Node-RED's `adminAuth` wants back from a successful login. */
export interface EditorUser {
  username: string;
  permissions: string;
}

export interface EditorAuth {
  type: "credentials";
  users: (username: string) => Promise<EditorUser | null>;
  authenticate: (username: string, password: string) => Promise<EditorUser | null>;
}

/**
 * The flow editor's login, delegated to the daemon.
 *
 * The same question over the same socket as the console's own login, so there
 * is one credential on this device and one place that knows how to check it.
 * The console holds no hash and can compare nothing itself (ADR-0007).
 *
 * Fails closed by construction: `verify` is false for a daemon that is down,
 * slow, throttling or answering nonsense, and false is `null` here, which is
 * a refused login.
 */
export function editorAuth(opts: { socketPath: string }): EditorAuth {
  const client = new DaemonClient({ socketPath: opts.socketPath });
  const user = (username: string): EditorUser => ({ username, permissions: "*" });
  return {
    type: "credentials",
    users: (username) => Promise.resolve(username === ADMIN_USERNAME ? user(username) : null),
    authenticate: async (username, password) => {
      if (username !== ADMIN_USERNAME) return null;
      return (await client.verify(password)) ? user(username) : null;
    },
  };
}
