// SPDX-License-Identifier: GPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from "node:http";
import { renderPage } from "./assets.js";
import { CONSOLE_HOME } from "./settings.js";
import type { DaemonClient } from "./client.js";
import type { SessionStore } from "./session.js";

/**
 * The gate on the front of the console.
 *
 * Two middlewares, and which one is mounted is decided when `settings.js` is
 * generated, not per request. That is what makes R-SEC-09 structural: in
 * setup mode the console has no flows, no editor and — because of the
 * middleware below — no route but two. There is nothing to hide, because
 * there is nothing there.
 *
 * Both are plain `(req, res, next)` functions over `node:http`, so they are
 * testable without an HTTP server and without Express. Node-RED mounts them
 * through `httpNodeAuth`, which `red.js` applies to everything under
 * `httpNodeRoot` whether or not any flow exists — see settings.ts.
 *
 * Nothing here does any crypto. Verification is a question asked of the
 * daemon over a Unix socket (client.ts), session tokens are minted and
 * checked by session.ts, and this file only decides what happens next.
 */

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

/** The session cookie's name. */
export const SESSION_COOKIE = "yonder_session";

/**
 * The most request body this will read: 8 KiB.
 *
 * These forms carry a password and nothing else. Anything larger is not a
 * login, and reading it would be a way to make a board with a gigabyte of
 * RAM buffer whatever an unauthenticated caller sends.
 */
const MAX_BODY_BYTES = 8 * 1024;

/** The path, without the query string, and never empty. */
function pathOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const cut = url.indexOf("?");
  const path = cut === -1 ? url : url.slice(0, cut);
  return path === "" ? "/" : path;
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    // The console has no reason to be framed, and every reason not to be:
    // a page that can be framed can be clickjacked into setting a password.
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    // A password field on a page a browser has cached is a password field
    // someone else can get back to on a shared tablet.
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * A 404 with nothing in it.
 *
 * Not a redirect to a login page, and not a message naming what does exist:
 * in setup mode there genuinely is nothing else, and saying so in detail
 * would be a list of routes to come back to.
 */
function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("not found\n");
}

/** What came out of a request body. */
export interface Submission {
  fields: Record<string, string>;
  /** The body was larger than this console will read; nothing was parsed. */
  tooLarge: boolean;
}

/**
 * Read a form or JSON body into flat string fields.
 *
 * Never rejects. A body that is truncated, aborted, or not what its
 * content-type claims comes back as no fields at all, which every caller
 * below treats as a failed submission — the same direction everything else in
 * this console fails.
 *
 * An oversized body is told apart from an empty one, because the two deserve
 * different answers: an empty submission is an operator who pressed the
 * button too early, and an oversized one is not a login at all. The stream is
 * paused rather than drained, so nothing is gained by continuing to send.
 */
export function readFields(req: IncomingMessage): Promise<Submission> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (fields: Record<string, string>, tooLarge = false): void => {
      if (done) return;
      done = true;
      resolve({ fields, tooLarge });
    };

    req.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        req.pause();
        finish({}, true);
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => { finish({}); });
    req.on("aborted", () => { finish({}); });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const type = String(req.headers["content-type"] ?? "");
      try {
        if (type.includes("application/json")) {
          const parsed: unknown = JSON.parse(text);
          if (parsed === null || typeof parsed !== "object") { finish({}); return; }
          const fields: Record<string, string> = {};
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === "string") fields[key] = value;
          }
          finish(fields);
          return;
        }
        // Anything else is read as a form, because a form is what these
        // pages send and a browser that omits the header must still work.
        const fields: Record<string, string> = {};
        for (const [key, value] of new URLSearchParams(text)) fields[key] = value;
        finish(fields);
      } catch {
        finish({});
      }
    });
  });
}

/**
 * The answer to a body this console refused to read.
 *
 * `connection: close` because the rest of that body is still coming and there
 * is no reason to read it: the request is over, and keeping the connection
 * alive would mean either draining it or leaving it half-read.
 */
function tooLarge(res: ServerResponse): void {
  res.writeHead(413, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end("that request was larger than this console will read\n");
}

/** One cookie's value out of a Cookie header. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const cut = part.indexOf("=");
    if (cut === -1) continue;
    if (part.slice(0, cut).trim() !== name) continue;
    return decodeURIComponent(part.slice(cut + 1).trim());
  }
  return undefined;
}

/**
 * The session cookie.
 *
 * **`Secure` is deliberately not set**, and that is a known limitation rather
 * than an oversight. The setup access point is plain HTTP — there is no
 * certificate a device with no name and no internet connection could present
 * — and a `Secure` cookie over plain HTTP is simply never sent, so setting it
 * would produce a console that accepts a password and then behaves as though
 * nobody had logged in. `HttpOnly` and `SameSite=Strict` are set and do work
 * over plain HTTP: the first keeps the token away from any script on the
 * page, the second keeps it off cross-site requests. TLS is R-SEC-08 and is a
 * later milestone; until then, anyone already inside the access point's radio
 * range can read the cookie off the air. ADR-0008 records this.
 */
function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** GET and HEAD are the only methods that get a page rather than a status. */
function wantsPage(req: IncomingMessage): boolean {
  return req.method === "GET" || req.method === "HEAD";
}

export interface SetupMiddlewareDeps {
  client: DaemonClient;
  log?: (line: string) => void;
}

/**
 * What an unprovisioned console serves: one page and one POST.
 *
 * **Everything else is 404.** Not hidden behind a conditional, not redirected
 * to a login page that does not exist — absent. R-SEC-09 says a device with
 * no administrator password offers no function but setting one, and a route
 * that answers is a function whatever it answers with.
 *
 * `next()` is never called. There is nothing behind this middleware in setup
 * mode — no flows, no editor — so passing a request on could only ever reach
 * Node-RED's own 404, and going through this one instead means the property
 * is stated here rather than inferred from an empty flows file.
 */
export function setupMiddleware(deps: SetupMiddlewareDeps): Middleware {
  const log = deps.log ?? (() => {});

  return (req, res) => {
    const path = pathOf(req);

    if (wantsPage(req) && path === "/") {
      sendHtml(res, 200, renderPage("setup"));
      return;
    }

    if (req.method === "POST" && path === "/setup") {
      void (async () => {
        const submission = await readFields(req);
        if (submission.tooLarge) { tooLarge(res); return; }
        const password = submission.fields.password ?? "";
        const confirm = submission.fields.confirm;

        // Checked here rather than at the daemon, because it is a property of
        // *this form*, not of the device. It matters more than it looks:
        // setting the administrator password is one-way in this milestone, so
        // a typo nobody caught is a console its owner can never open.
        if (confirm !== undefined && confirm !== password) {
          sendHtml(res, 400, renderPage("setup", "The two passwords do not match."));
          return;
        }

        const result = await deps.client.setPassword(password);
        if (result.ok) {
          log("console: an administrator password was set; restarting into the console proper");
          sendHtml(res, 200, renderPage("restarting"));
          return;
        }
        // The daemon's own status and message, relayed once. No retry: a
        // refusal is a refusal, and a second attempt with the same body would
        // only spend another scrypt derivation on the device.
        sendHtml(res, result.status, renderPage("setup", result.error));
      })();
      return;
    }

    notFound(res);
  };
}

export interface ConsoleMiddlewareDeps {
  client: DaemonClient;
  sessions: SessionStore;
  log?: (line: string) => void;
}

/**
 * What a provisioned console serves: a login gate in front of everything.
 *
 * Mounted through `httpNodeAuth`, so it runs before any flow, before the
 * dashboard, and before anything else served under `httpNodeRoot`. The flow
 * editor is not behind this one — it has its own `adminAuth`, which asks the
 * same daemon the same question (settings.ts).
 */
export function consoleMiddleware(deps: ConsoleMiddlewareDeps): Middleware {
  const log = deps.log ?? (() => {});

  return (req, res, next) => {
    const path = pathOf(req);

    if (req.method === "POST" && path === "/login") {
      void (async () => {
        const submission = await readFields(req);
        if (submission.tooLarge) { tooLarge(res); return; }
        const attempt = await deps.client.login(submission.fields.password ?? "");
        if (attempt.ok) {
          res.setHeader("set-cookie", sessionCookie(deps.sessions.mint()));
          // 303, so the browser follows with a GET and a reload does not
          // re-post the password.
          res.writeHead(303, { location: CONSOLE_HOME, "cache-control": "no-store" });
          res.end();
          return;
        }
        // No cookie is set on a failure. Not an empty one, not an expired
        // one: nothing, so nothing downstream can mistake it for a session.
        log("console: a failed sign-in attempt");
        const message = attempt.retryAfter === undefined
          ? "That password was not accepted."
          : `Too many attempts. Try again in ${attempt.retryAfter} seconds.`;
        sendHtml(res, attempt.retryAfter === undefined ? 401 : 429, renderPage("login", message));
      })();
      return;
    }

    if (req.method === "POST" && path === "/logout") {
      const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
      if (token !== undefined) deps.sessions.revoke(token);
      res.setHeader("set-cookie", clearedCookie());
      res.writeHead(303, { location: "/", "cache-control": "no-store" });
      res.end();
      return;
    }

    const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
    if (token !== undefined && deps.sessions.check(token)) {
      next();
      return;
    }

    // No session. A browser gets the login page; anything else gets a status,
    // because a page is not an answer to a POST and an unauthenticated caller
    // must not be able to tell one route from another by what comes back.
    if (wantsPage(req)) {
      sendHtml(res, 200, renderPage("login"));
      return;
    }
    sendJson(res, 401, { error: "sign in to use this device" });
  };
}
