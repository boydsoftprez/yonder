// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { renderPage } from "./assets.js";
import { CONSOLE_HOME } from "./settings.js";
import type { DaemonClient } from "./client.js";
import type { SessionStore } from "./session.js";
import { whepHandler, WHEP_PREFIX, type WhepRequest, type WhepResponse } from "./whep.js";
import {
  captureRequestFor, stillRequestFor,
  type CaptureAnswer, type CaptureHandler, type StillHandler,
} from "./capture.js";
import { cameraFor } from "../video/media-path.js";
import { validAimRequest } from '../video/accessory/requests.js';

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

/**
 * The most of a stream handshake this will read: 64 KiB.
 *
 * Its own bound rather than the one above, because an SDP offer is not a
 * password: a browser listing every interface it has and every candidate it
 * gathered is comfortably into the kilobytes, and a limit set for a login
 * form would refuse a legitimate offer. That failure is worth naming — it
 * presents as "video does not work in this browser", on some machines and not
 * others, with nothing in any log to say why.
 *
 * **The figure is chosen, not measured.** No real browser's offer has been
 * put through this board yet. It is roughly an order of magnitude above the
 * largest offer expected, which is the right side to be wrong on: what it
 * protects against is an authenticated caller making this device buffer
 * whatever it likes, and no body on this device is read without a limit.
 */
const MAX_OFFER_BYTES = 64 * 1024;

/**
 * The most of a viewer's own statistic this will read: 4 KiB.
 *
 * Its own bound, smaller than either figure above, because a `ViewerStats` is
 * a handful of numbers and a short string — comfortably under a kilobyte
 * written out as JSON. This route is polled once a second for as long as a
 * picture is open, so a limit sized for an SDP offer would be a 1 Hz route
 * this device would go on buffering 64 KiB for, for ever, rather than a
 * bound that actually costs an authenticated caller something to reach.
 */
const MAX_REPORT_BYTES = 4 * 1024;

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
 * A request body, up to `limit` bytes, as text.
 *
 * Never rejects. A body that is truncated or aborted comes back as no text at
 * all, which every caller below treats as a failed submission — the same
 * direction everything else in this console fails.
 *
 * An oversized body is told apart from an empty one, because the two deserve
 * different answers: an empty submission is an operator who pressed the
 * button too early, and an oversized one is not a login at all. The stream is
 * paused rather than drained, so nothing is gained by continuing to send.
 *
 * One collector, so those properties hold for a stream handshake exactly as
 * they do for a login form rather than being written twice and drifting.
 */
function readBody(req: IncomingMessage, limit: number): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let done = false;
    const finish = (text: string, tooLarge = false): void => {
      if (done) return;
      done = true;
      resolve({ text, tooLarge });
    };

    req.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) {
        req.pause();
        finish("", true);
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => { finish(""); });
    req.on("aborted", () => { finish(""); });
    req.on("end", () => { finish(Buffer.concat(chunks).toString("utf8")); });
  });
}

/**
 * Read a form or JSON body into flat string fields.
 *
 * A body that is not what its content-type claims comes back as no fields at
 * all, which every caller below treats as a failed submission.
 */
export async function readFields(req: IncomingMessage): Promise<Submission> {
  const { text, tooLarge } = await readBody(req, MAX_BODY_BYTES);
  if (tooLarge) return { fields: {}, tooLarge: true };
  const type = String(req.headers["content-type"] ?? "");
  const fields: Record<string, string> = {};
  try {
    if (type.includes("application/json")) {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object") return { fields: {}, tooLarge: false };
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") fields[key] = value;
      }
      return { fields, tooLarge: false };
    }
    // Anything else is read as a form, because a form is what these pages
    // send and a browser that omits the header must still work.
    for (const [key, value] of new URLSearchParams(text)) fields[key] = value;
    return { fields, tooLarge: false };
  } catch {
    return { fields: {}, tooLarge: false };
  }
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

/**
 * The live session this request carries, refreshing its idle timer, or
 * undefined where it carries none.
 *
 * The one notion of "logged in" on this device. Every route that needs the
 * answer asks this, so there is nowhere a second, weaker version of the
 * question could grow.
 */
function sessionOf(req: IncomingMessage, sessions: SessionStore): string | undefined {
  const token = cookieValue(req.headers.cookie, SESSION_COOKIE);
  return token !== undefined && sessions.check(token) ? token : undefined;
}

function hasSession(req: IncomingMessage, sessions: SessionStore): boolean {
  return sessionOf(req, sessions) !== undefined;
}

/**
 * The header the stream handshake answers with: **which viewer this browser
 * is** (R-VID-11, R-VID-13; spec §8.2).
 *
 * A viewer is a browser session, not a camera page component. Two pages of
 * one camera open in one session are one viewer watching one camera, and
 * they share one subscription and one transmission — so the id has to be a
 * property of the *session*, which is the only thing on this device with
 * that lifetime.
 */
export const VIEWER_HEADER = "x-yonder-viewer";

/**
 * A viewer id, from a session token.
 *
 * **Derived rather than issued**, so there is no second register to keep in
 * step with the session store: the id exists exactly as long as the session
 * does, dies with it, and cannot outlive a logout.
 *
 * **And it is not the token.** It goes into messages the page carries around
 * and posts back to the daemon, so handing out the session token under
 * another name would be putting the credential somewhere any script on the
 * page could read it. A SHA-256 of the token, truncated, is stable for that
 * session, distinct between sessions, and reversible to nothing.
 */
export function viewerFor(token: string): string {
  return createHash("sha256").update(`yonder-viewer:${token}`).digest("hex").slice(0, 16);
}

/** An answer relayed from the media server, or this console's refusal of one. */
/**
 * A capture, relayed byte for byte.
 *
 * `no-store`, like everything else this console serves: a capture can be
 * deleted, and a browser holding a cached copy of a file the operator has
 * removed would be the console showing something the device no longer has.
 * `nosniff` because the content type is the daemon's own answer about a file
 * an operator's camera wrote, and a browser guessing differently about it is
 * a guess nobody asked for.
 */
function sendCapture(res: ServerResponse, answer: CaptureAnswer): void {
  res.writeHead(answer.status, {
    ...answer.headers,
    "content-type": answer.contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (typeof answer.body === "string") {
    res.end(answer.body);
    return;
  }
  // Piped rather than collected: see `capture.ts` on why a recording must not
  // become a second whole copy in this process. A stream that fails mid-body
  // ends the response — there is no status left to change by then, and a
  // half-written file is what the browser will make of it either way.
  answer.body.on("error", () => { res.end(); });
  answer.body.pipe(res);
}

function sendProxied(res: ServerResponse, answer: WhepResponse): void {
  res.writeHead(answer.status, {
    "content-type": "text/plain; charset=utf-8",
    ...answer.headers,
    "cache-control": "no-store",
  });
  res.end(answer.body);
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
  /**
   * The stream handshake proxy (whep.ts). Injected so a test can reach this
   * route without a media server and without opening a socket.
   */
  whep?: (req: WhepRequest) => Promise<WhepResponse>;
  /**
   * A capture's bytes (capture.ts), for the same reason and in the same
   * shape. Absent on a console assembled without one — which is every test
   * that is not about this route, and a device with no video layer — and the
   * route then answers 404 rather than throwing, exactly as a daemon with no
   * recorder answers the routes behind it.
   */
  capture?: CaptureHandler;
  /** A camera's latest volatile still, relayed over the daemon socket. */
  still?: StillHandler;
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
  const whep = deps.whep ?? whepHandler();

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

    // The stream handshake, behind this console's own credential (R-SEC-13).
    // Handed the answer rather than placed below the check further down: a
    // route that is authenticated by where it sits in this function is a
    // route that stops being authenticated the day the function is reordered.
    if (path === WHEP_PREFIX || path.startsWith(`${WHEP_PREFIX}/`)) {
      // One browser's own measurement of the path its picture is arriving on
      // (R-VID-07, R-VID-11, R-VID-19), relayed to the daemon's rate
      // controller (spec §8.2). Matched before the handshake below rather
      // than after it: `/report` is not a WHEP verb, and falling through to
      // `whep()` would only have it refused there as "no such camera
      // stream" — a 404 this route can both avoid and answer more usefully.
      /**
       * **A capture's bytes, behind this console's own credential**
       * (R-CAM-18, R-SEC-13).
       *
       * Matched here, beside the viewer report and before the handshake, for
       * the same two reasons that one is: `captures` is not a WHEP verb, so
       * falling through would answer "no such camera stream" — a 404 that
       * says nothing — and a route authenticated by where it sits in a
       * function is a route that stops being authenticated the day the
       * function is reordered. The session is therefore checked here, in this
       * branch, rather than relied on from below.
       *
       * `GET` only. A capture is deleted through the daemon's own route, from
       * the flow, where a delete is a press an operator made on a panel that
       * asked them first — never by a URL a browser can be pointed at.
       */
      const wanted = captureRequestFor(path);
      if (wanted !== null) {
        if (req.method !== "GET") {
          sendProxied(res, { status: 405, body: "only GET reads a capture" });
          return;
        }
        if (sessionOf(req, deps.sessions) === undefined) {
          sendProxied(res, { status: 401, body: "log in to read this camera's captures" });
          return;
        }
        const serve = deps.capture;
        if (serve === undefined) {
          sendProxied(res, { status: 404, body: "this device serves no captures" });
          return;
        }
        void (async () => {
          const answer = await serve(wanted);
          sendCapture(res, answer);
        })();
        return;
      }

      const stillWanted = stillRequestFor(path);
      if (stillWanted !== null) {
        if (req.method !== "GET") {
          sendProxied(res, { status: 405, body: "only GET reads a camera's still" });
          return;
        }
        const token = sessionOf(req, deps.sessions);
        if (token === undefined) {
          sendProxied(res, { status: 401, body: "log in to read this camera's stills" });
          return;
        }
        const serve = deps.still;
        if (serve === undefined) {
          sendProxied(res, { status: 404, body: "this device serves no stills" });
          return;
        }
        void (async () => {
          const answer = await serve({ camera: stillWanted.camera, viewer: viewerFor(token) });
          sendCapture(res, answer);
        })();
        return;
      }

      const aim = /^\/video\/([^/]+)\/aim$/.exec(path);
      if (aim) {
        const token = sessionOf(req, deps.sessions);
        if (!token) { sendJson(res, 401, { error: 'Log in to aim this camera' }); return; }
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'Aim requires POST' }); return; }
        let originOkay = false;
        try { const origin = new URL(String(req.headers.origin)); originOkay = origin.host === req.headers.host && ['http:', 'https:'].includes(origin.protocol); } catch { /* missing origin refuses */ }
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(aim[1]) || !originOkay || req.headers['x-yonder-aim'] !== '1'
          || !/^application\/json(?:;|$)/i.test(String(req.headers['content-type']))
          || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
          sendJson(res, 403, { error: 'Use the same-origin camera aim control' }); return;
        }
        res.setHeader('pragma', 'no-cache');
        void (async () => {
          const submission = await readBody(req, 2048);
          if (submission.tooLarge) { tooLarge(res); return; }
          let request: unknown;
          try { request = JSON.parse(submission.text); } catch { sendJson(res, 400, { error: 'Malformed aim JSON' }); return; }
          if (!validAimRequest(request)) { sendJson(res, 400, { error: 'Malformed aim request' }); return; }
          // Resolve authentication again after reading a body: logout invalidates renewal too.
          if (sessionOf(req, deps.sessions) !== token) { sendJson(res, 401, { error: 'Aim session expired' }); return; }
          const reply = await deps.client.request({ method: 'POST', path: `/cameras/${aim[1]}/aim`, body: { owner: viewerFor(token), request } });
          sendJson(res, reply.ok ? reply.status : 503, reply.ok ? reply.body : { error: 'Camera service unavailable' });
        })().catch(() => sendJson(res, 503, { error: 'Camera aim request failed' }));
        return;
      }
      const report = /^\/video\/([^/]+)\/report$/.exec(path);
      if (report !== null) {
        const streamPath = report[1];
        if (req.method !== "POST") {
          sendProxied(res, { status: 405, body: "only POST reports a viewer's statistic" });
          return;
        }
        // Resolved exactly as the handshake below resolves it, and for the
        // same reason nothing reads the body before this: an unauthenticated
        // request must not be able to make this process do work either.
        const token = sessionOf(req, deps.sessions);
        if (token === undefined) {
          sendProxied(res, { status: 401, body: "log in to report on this camera" });
          return;
        }
        void (async () => {
          const submission = await readBody(req, MAX_REPORT_BYTES);
          if (submission.tooLarge) { tooLarge(res); return; }
          let body: unknown = {};
          try {
            body = submission.text === "" ? {} : JSON.parse(submission.text);
          } catch {
            // Not a shape the daemon would accept as a statistic either, and
            // it will say so below — falling back to an empty submission
            // only keeps a malformed body from throwing uncaught here.
          }
          // Only the four fields the daemon's own route reads are ever
          // relayed. **Never a viewer id from the body, in any field**: the
          // one thing that stops a script on the page reporting as, or
          // steering the rate of, a viewer that is not its own is that
          // nothing above reads the body before `viewerFor(token)` below is
          // already decided, and nothing here reads it afterwards either.
          let relay: unknown = body;
          if (typeof body === "object" && body !== null && !Array.isArray(body)) {
            const sent = body as { want?: unknown; stills?: unknown; fullRate?: unknown; stats?: unknown };
            relay = { want: sent.want, stills: sent.stills, fullRate: sent.fullRate, stats: sent.stats };
          }
          const reply = await deps.client.request({
            method: "POST",
            path: `/cameras/${cameraFor(streamPath)}/viewers/${viewerFor(token)}`,
            body: relay,
          });
          if (!reply.ok) {
            sendJson(res, 503, {
              error: "the device's configuration service is not answering; the report was not recorded",
            });
            return;
          }
          // The daemon's own status and body, unchanged: it owns what a
          // valid statistic is, and restating that here would be a second
          // source of truth for those rules to drift from.
          sendJson(res, reply.status, reply.body);
        })();
        return;
      }

      const token = sessionOf(req, deps.sessions);
      const authenticated = token !== undefined;
      void (async () => {
        // Nothing reads the body until the credential has been checked, so an
        // unauthenticated request cannot make this process do work either.
        const offer = authenticated && req.method === "POST"
          ? await readBody(req, MAX_OFFER_BYTES)
          : { text: "", tooLarge: false };
        if (offer.tooLarge) { tooLarge(res); return; }
        const answer = await whep({
          method: req.method ?? "",
          path,
          body: offer.text,
          authenticated,
        });
        // Which viewer this browser is, on the one exchange every picture
        // makes before it can show anything (spec §8.2). On the handshake
        // rather than on a route of its own, because a browser that has just
        // negotiated a stream is exactly the browser that is about to start
        // reporting on it — and an unauthenticated caller never reaches this
        // line, so the id is never handed to somebody who could not watch.
        sendProxied(res, token === undefined
          ? answer
          : { ...answer, headers: { ...answer.headers, [VIEWER_HEADER]: viewerFor(token) } });
      })();
      return;
    }

    if (hasSession(req, deps.sessions)) {
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
