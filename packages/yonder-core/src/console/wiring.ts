// SPDX-License-Identifier: GPL-3.0-or-later
import type { ServerResponse } from "node:http";
import { DaemonClient } from "./client.js";
import { SessionStore } from "./session.js";
import { setupMiddleware, consoleMiddleware, type Middleware } from "./middleware.js";

/**
 * The things a generated `settings.js` calls into.
 *
 * `settings.js` is generated (settings.ts) and must stay a description: a
 * list of values, plus a call to each function here. Everything with a
 * decision in it lives in this package, where it has source files and tests —
 * the same reason CLAUDE.md rule 2 keeps logic out of `flows.json`. A
 * generated file with behaviour in it is a file nobody can review a diff of.
 *
 * Keeping the surface small is meant to keep the module graph small as well,
 * and it is worth writing down what that graph is rather than what it was
 * intended to be. Measured, by resolving every import reachable from this
 * file: 105 modules, 72 of them `yaml` and 10 `zod`. **Every one of those 82
 * arrives through a single edge** — `middleware.ts` takes the string
 * `CONSOLE_HOME` from `settings.ts`, which loads configuration in order to
 * generate a settings file, and loading configuration reaches the schema. One
 * constant, and the parser and the validator come with it. `headInjection`
 * below adds no edge of its own: the only new type it needs, `ServerResponse`,
 * is already part of this file's surface by way of `Middleware`, and a
 * type-only import is erased before anything is ever counted.
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

/**
 * Splice a fragment of markup into the `<head>` of whatever HTML document
 * this fronts, before the browser paints it (R-UI-22).
 *
 * The theme used to arrive through a `ui-template` node's `@import`. A
 * `ui-template` is delivered to the client over Dashboard's own socket
 * connection, which does not exist until *after* the SPA has booted — so the
 * browser always painted an unstyled page first and the console flashed
 * white on every load. On a night flight that flash is a torch in the
 * operator's face. Fixing it needs the stylesheet in the document Dashboard
 * actually serves, which a widget of any kind cannot reach: this is the one
 * hook that can.
 *
 * **The hook is `RED.settings.dashboard.middleware`**, read once by
 * `@flowfuse/node-red-dashboard`'s `ui_base.js` (`uiShared.settings =
 * RED.settings.dashboard || RED.settings.ui || {}`, the second name kept only
 * as Dashboard's own fallback) and applied in front of both the SPA's static
 * bundle and its two `res.sendFile(dist/index.html)` routes. Confirmed
 * against the installed package rather than guessed: grep
 * `node_modules/@flowfuse/node-red-dashboard/nodes/config/ui_base.js` for
 * `uiShared.settings` and `uiShared.httpMiddleware` to see the same thing.
 *
 * **Patching `res.sendFile` does not work**, and this was built against a
 * real Node-RED with the real dashboard specifically to find that out rather
 * than ship it. Both explicit routes call `res.sendFile` by name, which looks
 * like the hook — but loading the console's own root path never reaches
 * either of them: `express.static` is mounted in front of both with its
 * default `index: 'index.html'`, so a request for the bare path is answered
 * by `express.static`'s own internals — the `send` package, writing straight
 * to the response — before Dashboard's route handlers, and therefore a
 * patched `res.sendFile`, ever see it. The measured proof was a response
 * whose `ETag` and `Content-Length` matched the file on disk exactly:
 * nothing had touched it.
 *
 * So this patches `write`/`end` themselves, which is where every path that
 * can produce a response — `express.static`'s internals as much as
 * Dashboard's own `res.sendFile` — actually puts bytes on the wire. Gated on
 * `Content-Type: text/html`, so the SPA's own JS, CSS and image bundles pass
 * through untouched; everything else this fronts is exactly one HTML
 * document. The `WeakSet` guards the other half of the same discovery: the
 * identical middleware value is mounted at three separate points in
 * Dashboard's own route table, and a request that falls through the static
 * mount to the SPA's own catch-all route (any deep-linked page, reloaded)
 * runs it a second time — without the guard the markup was spliced in twice,
 * not zero times, on exactly the request the static shortcut does not take.
 *
 * The bytes on the wire no longer match the file on disk once this runs, so
 * the validators that described that file are wrong for what was actually
 * sent: `ETag` and `Last-Modified` are dropped and `Cache-Control` is set to
 * `no-store` rather than let a conditional request compare against a file
 * that was never what got served.
 *
 * **Content-Type is tracked, not read back.** The first version of this
 * asked `res.getHeader('content-type')` inside the patched `write`/`end`, and
 * it passed against `send` — which sets headers individually and lets
 * Node flush them on the first `write`/`end` it makes, so `getHeader` still
 * answers right up to that point — and failed against a handler that calls
 * `res.writeHead(status, headers)` itself: Node flushes headers immediately
 * when a headers object is given to `writeHead`, and `getHeader` after a
 * flush returns nothing. Both are ordinary ways to answer an HTTP request, so
 * this patches `setHeader` and `writeHead` too, purely to remember whatever
 * content type either one is given before it can be flushed out from under
 * this.
 */
export function headInjection(markup: string): Middleware {
  const patched = new WeakSet<ServerResponse>();

  return (_req, res, next) => {
    if (patched.has(res)) { next(); return; }
    patched.add(res);

    let contentType: string | undefined;
    const noteContentType = (name: string, value: unknown): void => {
      if (name.toLowerCase() === "content-type" && typeof value === "string") contentType = value;
    };
    const isDocument = (): boolean => contentType !== undefined && contentType.includes("text/html");

    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: unknown) => {
      noteContentType(name, value);
      return originalSetHeader(name, value as never);
    }) as unknown as ServerResponse["setHeader"];

    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = ((...args: unknown[]) => {
      // (status), (status, headers) or (status, statusMessage, headers) —
      // the headers object, whichever position it is in, is the only object
      // among otherwise numeric and string arguments.
      const headers = args.find((a) => typeof a === "object" && a !== null) as
        | Record<string, unknown>
        | undefined;
      if (headers) for (const [name, value] of Object.entries(headers)) noteContentType(name, value);
      return (originalWriteHead as (...a: unknown[]) => ServerResponse)(...args);
    }) as unknown as ServerResponse["writeHead"];

    const chunks: Buffer[] = [];
    const toBuffer = (chunk: unknown, encoding: unknown): Buffer | undefined => {
      if (chunk === undefined || typeof chunk === "function") return undefined;
      if (Buffer.isBuffer(chunk)) return chunk;
      return Buffer.from(String(chunk), typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
    };
    // Whichever of the three positions `write`/`end` were actually called
    // with turns out to hold the completion callback, if there is one — a
    // bare `res.end(cb)` is legal and is how Node-RED itself sometimes closes
    // a response, so this cannot just assume it is always last.
    const callbackOf = (...args: unknown[]): (() => void) | undefined =>
      args.find((a): a is () => void => typeof a === "function");

    const originalWrite = res.write.bind(res);
    res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      if (!isDocument()) return originalWrite(chunk as never, encoding as never, callback as never);
      const buf = toBuffer(chunk, encoding);
      if (buf) chunks.push(buf);
      callbackOf(chunk, encoding, callback)?.();
      return true;
    }) as unknown as ServerResponse["write"];

    const originalEnd = res.end.bind(res);
    res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
      if (!isDocument()) return originalEnd(chunk as never, encoding as never, callback as never);
      const buf = toBuffer(chunk, encoding);
      if (buf) chunks.push(buf);
      const html = Buffer.concat(chunks).toString("utf8");
      const withMarkup = html.includes("</head>") ? html.replace("</head>", `${markup}\n</head>`) : html;
      try {
        // The response no longer describes the file on disk: its length
        // changed, so an ETag or a Last-Modified that named that file now
        // names a document that was never sent. Guarded: a caller that
        // flushed its own headers before reaching here (unlike `send`, which
        // never does) leaves nothing left to correct, and the alternative to
        // catching that is a console that answers with no body at all.
        res.removeHeader("ETag");
        res.removeHeader("Last-Modified");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Length", Buffer.byteLength(withMarkup));
      } catch { /* headers already sent; the body still carries the markup */ }
      return originalEnd(withMarkup, "utf8", callbackOf(chunk, encoding, callback) as never);
    }) as unknown as ServerResponse["end"];

    next();
  };
}
