// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CONSOLE_HOME } from "./settings.js";
import { createServer, request, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  setupMiddleware,
  consoleMiddleware,
  cookieValue,
  viewerFor,
  SESSION_COOKIE,
  VIEWER_HEADER,
  type ConsoleMiddlewareDeps,
  type Middleware,
} from "./middleware.js";
import { Readable } from "node:stream";
import { DaemonClient, type DaemonRequest, type Transport } from "./client.js";
import type { CaptureAnswer, StillRequest } from "./capture.js";
import { STILL_AGE_HEADER, STILL_AT_HEADER } from "../video/media-path.js";
import { SessionStore } from "./session.js";
import type { Clock } from "../apply/types.js";

/**
 * The gate, exercised over a real HTTP server.
 *
 * A real server rather than fake req/res objects, because half of what these
 * middlewares do is header and body handling and a hand-rolled fake proves
 * nothing about either. No Node-RED here: these are plain `(req, res, next)`
 * functions, which is what makes that possible.
 *
 * Two properties are what this file exists for:
 *
 *   - **In setup mode there is no route that reads configuration.** Proved by
 *     404, not by a UI conditional.
 *   - **The console fails closed.** A daemon that is down, slow or returning
 *     nonsense produces a failed login, never a successful one.
 */

let server: Server;
let port: number;
/** Set when the middleware called next() — i.e. let the request through. */
let passedThrough: string[];

function serve(middleware: Middleware): Promise<void> {
  passedThrough = [];
  server = createServer((req, res) => {
    middleware(req, res, () => {
      passedThrough.push(`${req.method ?? ""} ${req.url ?? ""}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("behind the gate");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(
  method: string,
  path: string,
  opts: {
    form?: Record<string, string>;
    json?: unknown;
    cookie?: string;
    raw?: string;
    /** The content-type sent with `raw`. A form, unless something says otherwise. */
    type?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let payload: Buffer | undefined;
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.form !== undefined) {
      payload = Buffer.from(new URLSearchParams(opts.form).toString(), "utf8");
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (opts.json !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.json), "utf8");
      headers["content-type"] = "application/json";
    } else if (opts.raw !== undefined) {
      payload = Buffer.from(opts.raw, "utf8");
      headers["content-type"] = opts.type ?? "application/x-www-form-urlencoded";
    }
    if (payload !== undefined) headers["content-length"] = String(payload.length);
    if (opts.cookie !== undefined) headers.cookie = opts.cookie;

    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * As `call`, but the body kept as bytes.
 *
 * `call` above decodes to UTF-8, which is right for every other route here
 * and destroys the one this exists for: a JPEG's first two bytes are 0xff
 * 0xd8, and a test that compared strings would pass on a proxy that had
 * replaced every one of them.
 */
function callBytes(
  method: string, path: string, cookie?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: cookie === undefined ? {} : { cookie } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A transport that answers with exactly this and counts how often it is asked. */
function answering(status: number, body: string): Transport & { calls: number } {
  const t = (): Promise<{ status: number; body: string }> => {
    t.calls += 1;
    return Promise.resolve({ status, body });
  };
  t.calls = 0;
  return t;
}

/**
 * A transport that answers with exactly this and records every request it
 * was actually asked to make — which path, and which body — so a test can
 * assert on the daemon call the report route made rather than only on what
 * came back from it.
 */
function recording(status: number, body: string): Transport & { calls: DaemonRequest[] } {
  const t = (req: DaemonRequest): Promise<{ status: number; body: string }> => {
    t.calls.push(req);
    return Promise.resolve({ status, body });
  };
  t.calls = [];
  return t;
}

const GOOD = "a long enough password";

// ---------------------------------------------------------------------------

describe("setupMiddleware", () => {
  it("serves the setup page at /", async () => {
    await serve(setupMiddleware({ client: new DaemonClient({ transport: answering(200, "{}") }) }));
    const res = await call("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Set an administrator password");
  });

  /**
   * R-SEC-09, expressed as a status code. A dashboard whose pages are hidden
   * by a UI conditional does not satisfy it — the routes still exist and
   * still answer. Here they do not exist.
   */
  it("answers 404 to everything else, including the routes a console would have", async () => {
    await serve(setupMiddleware({ client: new DaemonClient({ transport: answering(200, "{}") }) }));
    for (const path of [
      "/editor", "/editor/", "/dashboard", "/ui", "/config", "/status", "/settings",
      "/admin/verify", "/login", "/logout", "/index.html", "/red/red.js", "/setup",
      "/../etc/yonder/secrets.yaml",
    ]) {
      const res = await call("GET", path);
      expect(res.status, `GET ${path}`).toBe(404);
      expect(res.body, `GET ${path}`).not.toContain("password");
    }
    // And no method on / but GET.
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await call(method, "/")).status, method).toBe(404);
    }
  });

  it("never lets a request through to whatever is behind it", async () => {
    await serve(setupMiddleware({ client: new DaemonClient({ transport: answering(200, "{}") }) }));
    await call("GET", "/");
    await call("GET", "/anything");
    await call("POST", "/setup", { form: { password: GOOD, confirm: GOOD } });
    expect(passedThrough).toEqual([]);
  });

  it("accepts a good password, relays it once, and says the console is restarting", async () => {
    const transport = answering(200, '{"ok":true}');
    await serve(setupMiddleware({ client: new DaemonClient({ transport }) }));
    const res = await call("POST", "/setup", { form: { password: GOOD, confirm: GOOD } });
    expect(res.status).toBe(200);
    expect(res.body).toContain("The password is set");
    expect(transport.calls).toBe(1);
  });

  it("returns the daemon's own refusal, and does not retry", async () => {
    const transport = answering(400, '{"error":"the administrator password must be at least 8 characters"}');
    await serve(setupMiddleware({ client: new DaemonClient({ transport }) }));
    const res = await call("POST", "/setup", { form: { password: "short", confirm: "short" } });
    expect(res.status).toBe(400);
    expect(res.body).toContain("at least 8 characters");
    // Still the setup form, so the operator can correct it.
    expect(res.body).toContain("Set an administrator password");
    expect(transport.calls).toBe(1);
  });

  /**
   * Setting the password is one-way in this milestone, so a typo nobody
   * caught is a console its owner can never open. Checked here, before the
   * daemon is troubled at all.
   */
  it("refuses a mistyped confirmation without asking the daemon anything", async () => {
    const transport = answering(200, '{"ok":true}');
    await serve(setupMiddleware({ client: new DaemonClient({ transport }) }));
    const res = await call("POST", "/setup", { form: { password: GOOD, confirm: `${GOOD}x` } });
    expect(res.status).toBe(400);
    expect(res.body).toContain("do not match");
    expect(transport.calls).toBe(0);
  });

  it("says the service is not answering when the daemon is down", async () => {
    const transport: Transport = () => Promise.reject(new Error("connect ENOENT"));
    await serve(setupMiddleware({ client: new DaemonClient({ transport }) }));
    const res = await call("POST", "/setup", { form: { password: GOOD, confirm: GOOD } });
    expect(res.status).toBe(503);
    expect(res.body).toContain("not answering");
    // Not a page claiming the password was set.
    expect(res.body).not.toContain("The password is set");
  });

  it("puts no submitted password in the page it sends back", async () => {
    const transport = answering(400, '{"error":"too short"}');
    await serve(setupMiddleware({ client: new DaemonClient({ transport }) }));
    const res = await call("POST", "/setup", { form: { password: "sekrit", confirm: "sekrit" } });
    expect(res.body).not.toContain("sekrit");
  });

  it("reads a JSON body as well as a form", async () => {
    const transport = answering(200, '{"ok":true}');
    await serve(setupMiddleware({ client: new DaemonClient({ transport }) }));
    const res = await call("POST", "/setup", { json: { password: GOOD } });
    expect(res.status).toBe(200);
    expect(transport.calls).toBe(1);
  });

  it("treats a body it cannot read as an empty submission rather than falling over", async () => {
    const transport = answering(400, '{"error":"the administrator password cannot be blank"}');
    await serve(setupMiddleware({ client: new DaemonClient({ transport }) }));
    for (const raw of ["", "not=a&valid", "%%%%"]) {
      const res = await call("POST", "/setup", { raw });
      expect(res.status, JSON.stringify(raw)).toBe(400);
    }
  });

  it("refuses a body far larger than a password rather than buffering it", async () => {
    const transport = answering(200, '{"ok":true}');
    await serve(setupMiddleware({ client: new DaemonClient({ transport }) }));
    const res = await call("POST", "/setup", { raw: `password=${"x".repeat(16 * 1024)}` });
    expect(res.status).toBe(413);
    // And the daemon was never troubled with it.
    expect(transport.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------

function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    setTimer: () => 0,
    clearTimer: () => {},
    advance(ms: number) { t += ms; },
  };
}

function consoleWith(
  transport: Transport,
  sessions = new SessionStore({ clock: fakeClock() }),
  whep?: ConsoleMiddlewareDeps["whep"],
): {
  middleware: Middleware;
  sessions: SessionStore;
} {
  return {
    middleware: consoleMiddleware({ client: new DaemonClient({ transport }), sessions, whep }),
    sessions,
  };
}

/** A stand-in for the stream handshake proxy, recording what reached it. */
function recordingWhep(): {
  handler: NonNullable<ConsoleMiddlewareDeps["whep"]>;
  seen: Parameters<NonNullable<ConsoleMiddlewareDeps["whep"]>>[0][];
} {
  const seen: Parameters<NonNullable<ConsoleMiddlewareDeps["whep"]>>[0][] = [];
  return {
    seen,
    handler: (req) => {
      seen.push(req);
      return Promise.resolve({
        status: 201,
        body: ANSWER,
        headers: { "content-type": "application/sdp" },
      });
    },
  };
}

/** An SDP offer, which is neither a form nor JSON and must survive as sent. */
const OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n";
const ANSWER = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n";

/** The token out of a Set-Cookie header, or undefined. */
function tokenFrom(res: Reply): string | undefined {
  const header = res.headers["set-cookie"];
  const line = Array.isArray(header) ? header[0] : header;
  if (line === undefined) return undefined;
  return cookieValue(line.split(";")[0], SESSION_COOKIE);
}

describe("consoleMiddleware", () => {
  it("serves the login page, not the console, when there is no cookie", async () => {
    await serve(consoleWith(answering(200, '{"ok":true}')).middleware);
    const res = await call("GET", "/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Sign in");
    expect(passedThrough).toEqual([]);
  });

  it("serves the login page for any path, so nothing behind it is reachable", async () => {
    await serve(consoleWith(answering(200, '{"ok":true}')).middleware);
    for (const path of ["/", "/dashboard", "/ui/status", "/anything"]) {
      const res = await call("GET", path);
      expect(res.body, path).toContain("Sign in");
    }
    expect(passedThrough).toEqual([]);
  });

  it("answers a non-browser request with 401 rather than a page", async () => {
    await serve(consoleWith(answering(200, '{"ok":true}')).middleware);
    const res = await call("POST", "/api/anything", { json: {} });
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(passedThrough).toEqual([]);
  });

  it("sets a session cookie on the right password and lets the next request through", async () => {
    await serve(consoleWith(answering(200, '{"ok":true}')).middleware);
    const login = await call("POST", "/login", { form: { password: GOOD } });
    expect(login.status).toBe(303);
    // Where the dashboard actually is. Redirecting to "/" landed a
    // freshly signed-in operator on Express's bare "Cannot GET /".
    expect(login.headers.location).toBe(CONSOLE_HOME);

    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]!
      : String(login.headers["set-cookie"]);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // Deliberately absent: the access point is plain HTTP, and a Secure
    // cookie there is simply never sent — a console that accepted a password
    // and then behaved as though nobody had logged in (ADR-0008).
    expect(cookie).not.toContain("Secure");

    const res = await call("GET", "/dashboard", { cookie: cookie.split(";")[0] });
    expect(res.body).toBe("behind the gate");
    expect(passedThrough).toEqual(["GET /dashboard"]);
  });

  it("sets no cookie on a wrong password", async () => {
    await serve(consoleWith(answering(200, '{"ok":false}')).middleware);
    const res = await call("POST", "/login", { form: { password: "wrong" } });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.body).toContain("not accepted");
  });

  /**
   * The property this whole milestone turns on. Every way the daemon can be
   * unavailable or wrong must produce a failed login — never a session.
   */
  it("fails a login closed for every way the daemon can be unreachable or wrong", async () => {
    const broken: Record<string, Transport> = {
      "socket absent": () => Promise.reject(new Error("connect ENOENT")),
      "connection refused": () => Promise.reject(new Error("connect ECONNREFUSED")),
      "not JSON": answering(200, "<html>proxy</html>"),
      "truncated": answering(200, '{"ok":tr'),
      "ok is a string": answering(200, '{"ok":"true"}'),
      "no ok": answering(200, "{}"),
      "empty body": answering(200, ""),
      "500 with ok true": answering(500, '{"ok":true}'),
      "throws": () => { throw new Error("nope"); },
    };
    for (const [name, transport] of Object.entries(broken)) {
      const { sessions } = consoleWith(transport);
      await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
      const res = await call("POST", "/login", { form: { password: GOOD } });
      expect(res.status, name).not.toBe(303);
      expect(tokenFrom(res), name).toBeUndefined();
      expect(sessions.size, name).toBe(0);
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    }
  });

  it("says wait, not wrong, when the daemon is throttling", async () => {
    await serve(consoleWith(answering(429, '{"ok":false,"retryAfter":60}')).middleware);
    const res = await call("POST", "/login", { form: { password: GOOD } });
    expect(res.status).toBe(429);
    expect(res.body).toContain("60 seconds");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a cookie that is not a session it minted", async () => {
    const { middleware, sessions } = consoleWith(answering(200, '{"ok":true}'));
    await serve(middleware);
    const real = sessions.mint();
    for (const value of ["", "nonsense", `${real}x`, "a.b", real.split(".")[0]!]) {
      const res = await call("GET", "/", { cookie: `${SESSION_COOKIE}=${encodeURIComponent(value)}` });
      expect(res.body, JSON.stringify(value)).toContain("Sign in");
    }
    expect(passedThrough).toEqual([]);
    // The real one still works, so the rejections above were about the token.
    const ok = await call("GET", "/", { cookie: `${SESSION_COOKIE}=${encodeURIComponent(real)}` });
    expect(ok.body).toBe("behind the gate");
  });

  it("logs out, clearing the cookie and the session", async () => {
    const { middleware, sessions } = consoleWith(answering(200, '{"ok":true}'));
    await serve(middleware);
    const token = sessions.mint();
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;

    const res = await call("POST", "/logout", { cookie });
    expect(res.status).toBe(303);
    const cleared = Array.isArray(res.headers["set-cookie"])
      ? res.headers["set-cookie"][0]!
      : String(res.headers["set-cookie"]);
    expect(cleared).toContain("Max-Age=0");
    expect(sessions.check(token)).toBe(false);

    const after = await call("GET", "/", { cookie });
    expect(after.body).toContain("Sign in");
  });

  it("stops honouring a session once it has expired on the injected clock", async () => {
    const clock = fakeClock();
    const sessions = new SessionStore({ clock, idleMs: 1000 });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, '{"ok":true}') }),
      sessions,
    }));
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessions.mint())}`;
    expect((await call("GET", "/", { cookie })).body).toBe("behind the gate");
    clock.advance(2000);
    expect((await call("GET", "/", { cookie })).body).toContain("Sign in");
  });

  /**
   * R-SEC-13, at the console's door. The media server's WebRTC listener is on
   * loopback, so this route is the only way a browser reaches a stream, and
   * what it is told about the session is the whole of the protection. The
   * refusal itself is whep.ts's (and is proved end to end in wiring.test.ts);
   * what this asserts is that the answer handed over is the truth.
   */
  it("tells the proxy there is no session, and reads no offer when there is none", async () => {
    const proxy = recordingWhep();
    await serve(consoleWith(answering(200, '{"ok":true}'), undefined, proxy.handler).middleware);
    await call("POST", "/video/cam0-preview/whep", { raw: OFFER, type: "application/sdp" });
    // An empty body, not the offer: the credential is checked before anything
    // reads it, so an unauthenticated request cannot make this process do
    // work either.
    expect(proxy.seen).toEqual([{
      method: "POST",
      path: "/video/cam0-preview/whep",
      body: "",
      authenticated: false,
    }]);
    expect(passedThrough).toEqual([]);
  });

  it("hands an authenticated offer to the proxy byte for byte, and relays the answer", async () => {
    // An SDP offer is neither a form nor JSON. Read as either, it arrives
    // mangled and the picture fails with nothing in any log to say why.
    const proxy = recordingWhep();
    await serve(consoleWith(answering(200, '{"ok":true}'), undefined, proxy.handler).middleware);
    const login = await call("POST", "/login", { form: { password: GOOD } });
    const cookie = (login.headers["set-cookie"] as string[])[0]!.split(";")[0]!;

    const res = await call("POST", "/video/cam0-preview/whep", {
      raw: OFFER, type: "application/sdp", cookie,
    });
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toEqual({
      method: "POST",
      path: "/video/cam0-preview/whep",
      body: OFFER,
      authenticated: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toBe(ANSWER);
    expect(res.headers["content-type"]).toBe("application/sdp");
    // Not through to Node-RED: this route answers, it does not pass on.
    expect(passedThrough).toEqual([]);
  });

  /**
   * Which viewer this browser is (spec §8.2, R-VID-11).
   *
   * A viewer is a browser *session*, and this is the one exchange every
   * picture makes before it can show anything — so the id rides back on it
   * rather than on a route of its own.
   */
  it("answers the stream handshake with this browser's viewer id", async () => {
    const proxy = recordingWhep();
    await serve(consoleWith(answering(200, '{"ok":true}'), undefined, proxy.handler).middleware);
    const login = await call("POST", "/login", { form: { password: GOOD } });
    const cookie = (login.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const token = cookieValue(cookie, SESSION_COOKIE)!;

    const first = await call("POST", "/video/cam0-preview/whep", {
      raw: OFFER, type: "application/sdp", cookie,
    });
    expect(first.headers[VIEWER_HEADER]).toBe(viewerFor(token));

    // Two pages of one camera in one session are one viewer, which is what
    // makes them share a subscription and one transmission rather than two.
    const second = await call("POST", "/video/cam0/whep", {
      raw: OFFER, type: "application/sdp", cookie,
    });
    expect(second.headers[VIEWER_HEADER]).toBe(first.headers[VIEWER_HEADER]);
  });

  it("gives a second session a different viewer, and an unauthenticated caller none", async () => {
    const proxy = recordingWhep();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleWith(answering(200, '{"ok":true}'), sessions, proxy.handler).middleware);

    const one = `${SESSION_COOKIE}=${encodeURIComponent(sessions.mint())}`;
    const two = `${SESSION_COOKIE}=${encodeURIComponent(sessions.mint())}`;
    const a = await call("POST", "/video/cam0-preview/whep", { raw: OFFER, type: "application/sdp", cookie: one });
    const b = await call("POST", "/video/cam0-preview/whep", { raw: OFFER, type: "application/sdp", cookie: two });
    expect(a.headers[VIEWER_HEADER]).not.toBe(b.headers[VIEWER_HEADER]);

    const none = await call("POST", "/video/cam0-preview/whep", { raw: OFFER, type: "application/sdp" });
    expect(none.headers[VIEWER_HEADER]).toBeUndefined();
  });

  it("does not cache a page carrying a password field", async () => {
    await serve(consoleWith(answering(200, '{"ok":true}')).middleware);
    const res = await call("GET", "/");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

// ---------------------------------------------------------------------------

/**
 * `POST /video/<streamPath>/report` — the browser telling this device what it
 * is actually measuring on the path its own picture arrived on (R-VID-07,
 * R-VID-11, R-VID-19; spec §8.2). It sits in the same authenticated block as
 * the handshake above and follows the identical pattern: resolved before
 * anything reads a body, capped the same way, and never trusting the body
 * for who is reporting.
 */
describe("consoleMiddleware — a viewer's own report", () => {
  function sessionCookie(sessions: SessionStore): { cookie: string; token: string } {
    const token = sessions.mint();
    return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`, token };
  }

  it("relays a report to the daemon, camera derived from the stream path, viewer from the session", async () => {
    const transport = recording(200, '{"mine":{},"shared":{}}');
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie, token } = sessionCookie(sessions);

    const res = await call("POST", "/video/cam0-preview/report", {
      json: { stats: { rtt: 40, loss: 0, egress: 900, capacity: 4000 } },
      cookie,
    });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.method).toBe("POST");
    // The `-preview` stripped, through the one shared function — not a
    // second `.slice(0, -8)` living in this test's own expectations.
    expect(transport.calls[0]!.path).toBe(`/cameras/cam0/viewers/${viewerFor(token)}`);
    expect(transport.calls[0]!.body).toEqual({ stats: { rtt: 40, loss: 0, egress: 900, capacity: 4000 } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mine: {}, shared: {} });
  });

  it("relays independent thumbnail demand beside live-video selection", async () => {
    const transport = recording(200, '{"mine":{"delivery":"video"}}');
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie } = sessionCookie(sessions);

    const res = await call("POST", "/video/cam0/report", {
      json: { want: "video", stills: true }, cookie,
    });

    expect(transport.calls[0]?.body).toEqual({ want: "video", stills: true });
    expect(res.status).toBe(200);
  });

  it("leaves a path with no -preview suffix alone", async () => {
    const transport = recording(200, "{}");
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie } = sessionCookie(sessions);

    await call("POST", "/video/cam0/report", { json: {}, cookie });

    expect(transport.calls[0]!.path).toMatch(/^\/cameras\/cam0\/viewers\//);
  });

  /**
   * The load-bearing one (R-SEC-13). The viewer id travels in the page, so a
   * body-supplied id must never be able to steer another session's rate —
   * only `viewerFor(token)` may name whose subscription this post is.
   */
  it("ignores a body claiming another viewer's id; the id used is the one derived from the session", async () => {
    const transport = recording(200, "{}");
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie, token } = sessionCookie(sessions);

    await call("POST", "/video/cam0-preview/report", {
      json: {
        viewer: "someone-elses-viewer-id",
        viewerId: "someone-elses-viewer-id",
        stats: { rtt: 1, loss: 0, egress: 1, capacity: 1 },
      },
      cookie,
    });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.path).toBe(`/cameras/cam0/viewers/${viewerFor(token)}`);
    expect(transport.calls[0]!.path).not.toContain("someone-elses-viewer-id");
    expect(JSON.stringify(transport.calls[0]!.body)).not.toContain("someone-elses-viewer-id");
  });

  it("refuses an unauthenticated report, and never calls the daemon", async () => {
    const transport = recording(200, "{}");
    await serve(consoleWith(transport).middleware);

    const res = await call("POST", "/video/cam0-preview/report", {
      json: { stats: { rtt: 1, loss: 0, egress: 1, capacity: 1 } },
    });

    expect(res.status).toBe(401);
    expect(transport.calls).toHaveLength(0);
  });

  it("relays the daemon's own 400 unchanged, rather than restating its rules", async () => {
    const transport = recording(
      400,
      '{"error":"a statistic carries rtt, loss, egress and capacity as finite numbers, with loss between 0 and 1"}',
    );
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie } = sessionCookie(sessions);

    const res = await call("POST", "/video/cam0-preview/report", { json: { stats: { rtt: -1 } }, cookie });

    expect(res.status).toBe(400);
    expect(res.body).toContain("finite numbers");
  });

  it("says the service is not answering, rather than inventing a result, when the daemon is unreachable", async () => {
    const transport: Transport = () => Promise.reject(new Error("connect ENOENT"));
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie } = sessionCookie(sessions);

    const res = await call("POST", "/video/cam0-preview/report", { json: {}, cookie });

    expect(res.status).toBe(503);
  });

  it("refuses a report far larger than a statistic, and never calls the daemon", async () => {
    const transport = recording(200, "{}");
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie } = sessionCookie(sessions);

    const res = await call("POST", "/video/cam0-preview/report", {
      raw: `{"pad":"${"x".repeat(8 * 1024)}"}`,
      type: "application/json",
      cookie,
    });

    expect(res.status).toBe(413);
    expect(transport.calls).toHaveLength(0);
  });

  it("treats a body it cannot parse as an empty submission rather than falling over", async () => {
    const transport = recording(200, "{}");
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie } = sessionCookie(sessions);

    const res = await call("POST", "/video/cam0-preview/report", {
      raw: "not json", type: "application/json", cookie,
    });

    expect(res.status).toBe(200);
    expect(transport.calls[0]!.body).toEqual({});
  });

  it("answers 405 to anything but POST, and never calls the daemon", async () => {
    const transport = recording(200, "{}");
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const { cookie } = sessionCookie(sessions);

    const res = await call("GET", "/video/cam0-preview/report", { cookie });

    expect(res.status).toBe(405);
    expect(transport.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * **A capture's bytes, behind the same credential as the picture**
 * (R-CAM-18, R-SEC-13).
 *
 * The captures panel draws a thumbnail, a View and a Download, and all three
 * are this route. It sits inside the `/video` branch beside the handshake, so
 * these tests are as much about *where* the session is checked as about what
 * comes back: a route authenticated by falling through to the check at the
 * bottom of the function stops being authenticated the day the function is
 * reordered, which is the property the first test here holds.
 */
describe("consoleMiddleware — a capture's bytes", () => {
  function sessionCookie(sessions: SessionStore): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(sessions.mint())}`;
  }
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const NAME = "2026-09-07T14-22-05-123Z-1280x720.jpg";

  /** A stand-in for the proxy, recording what reached it. */
  function recordingCapture(answer?: Partial<CaptureAnswer>): {
    handler: NonNullable<ConsoleMiddlewareDeps["capture"]>;
    seen: { camera: string; name: string }[];
  } {
    const seen: { camera: string; name: string }[] = [];
    return {
      seen,
      handler: (req) => {
        seen.push({ camera: req.camera, name: req.name });
        return Promise.resolve({
          status: 200,
          contentType: "image/jpeg",
          body: Readable.from([JPEG]),
          ...answer,
        });
      },
    };
  }

  it("refuses without a session, and never asks for the file", async () => {
    const capture = recordingCapture();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      capture: capture.handler,
    }));

    const res = await call("GET", `/video/cam0/captures/${NAME}`);

    expect(res.status).toBe(401);
    expect(capture.seen, "an unauthenticated request must not reach the file").toEqual([]);
    // And it did not fall through to whatever is behind the gate either.
    expect(passedThrough).toEqual([]);
  });

  it("serves the bytes to a session, unchanged, with the daemon's own type", async () => {
    const capture = recordingCapture();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      capture: capture.handler,
    }));

    const res = await callBytes("GET", `/video/cam0/captures/${NAME}`, sessionCookie(sessions));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    // Byte for byte: the first two are 0xff 0xd8, which no text encoding
    // survives, and a broken image is the only thing a browser would report.
    expect(res.body).toEqual(JPEG);
    expect(capture.seen).toEqual([{ camera: "cam0", name: NAME }]);
  });

  it("never lets a capture be cached, because a capture can be deleted", async () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      capture: recordingCapture().handler,
    }));

    const res = await callBytes("GET", `/video/cam0/captures/${NAME}`, sessionCookie(sessions));

    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("takes GET and nothing else — a capture is deleted from the flow, not by a URL", async () => {
    const capture = recordingCapture();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      capture: capture.handler,
    }));

    const res = await call("DELETE", `/video/cam0/captures/${NAME}`, {
      cookie: sessionCookie(sessions),
    });

    expect(res.status).toBe(405);
    expect(capture.seen).toEqual([]);
  });

  it("answers 404, not a stack trace, on a console assembled with no capture proxy", async () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
    }));

    const res = await call("GET", `/video/cam0/captures/${NAME}`, {
      cookie: sessionCookie(sessions),
    });

    expect(res.status).toBe(404);
  });

  it("leaves the handshake and the report where they were", async () => {
    // The capture match sits in the same branch as those two, so the guard
    // that it did not swallow either of them belongs here rather than in a
    // reviewer's head.
    const whep = recordingWhep();
    const capture = recordingCapture();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      whep: whep.handler,
      capture: capture.handler,
    }));
    const cookie = sessionCookie(sessions);

    await call("POST", "/video/cam0/whep", { raw: OFFER, type: "application/sdp", cookie });

    expect(whep.seen).toHaveLength(1);
    expect(capture.seen).toEqual([]);
  });
});

/**
 * **A camera's latest still, behind the same credential as the picture**
 * (R-VID-14, R-VID-11, R-SEC-13).
 *
 * The picture fetches it on the interval it was told and the strip fetches
 * one per other camera; every fetch is a copy leaving the aircraft and is
 * counted against the browser that made it — so the viewer the relay names
 * has to be the session's own, never anything the request said.
 */
describe("consoleMiddleware — a camera's latest still", () => {
  function sessionCookie(sessions: SessionStore): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(sessions.mint())}`;
  }
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  /** A stand-in for the still proxy, recording what reached it. */
  function recordingStill(answer?: Partial<CaptureAnswer>): {
    handler: NonNullable<ConsoleMiddlewareDeps["still"]>;
    seen: StillRequest[];
  } {
    const seen: StillRequest[] = [];
    return {
      seen,
      handler: (req) => {
        seen.push(req);
        return Promise.resolve({
          status: 200,
          contentType: "image/jpeg",
          body: Readable.from([JPEG]),
          headers: { [STILL_AT_HEADER]: "1700000000000", [STILL_AGE_HEADER]: "2500" },
          ...answer,
        });
      },
    };
  }

  it("refuses without a session, and never asks for the still", async () => {
    const still = recordingStill();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      still: still.handler,
    }));

    const res = await call("GET", "/video/cam0/still");

    expect(res.status).toBe(401);
    expect(still.seen, "an unauthenticated request must not reach the still").toEqual([]);
    expect(passedThrough).toEqual([]);
  });

  it("serves the bytes and the frame's age to a session, the viewer derived from that session", async () => {
    const still = recordingStill();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      still: still.handler,
    }));
    const cookie = sessionCookie(sessions);

    const res = await callBytes("GET", "/video/cam0-preview/still?t=123", cookie);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.body).toEqual(JPEG);
    // The age travels (R-VID-14) …
    expect(res.headers[STILL_AT_HEADER]).toBe("1700000000000");
    expect(res.headers[STILL_AGE_HEADER]).toBe("2500");
    // … and so do this console's own rules, which nothing relayed overrides.
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // The camera the stream path is of, and the session's own viewer — the
    // same id the handshake answers with, so the copy is counted against
    // the browser that fetched it and no other.
    expect(still.seen).toEqual([{ camera: "cam0", viewer: viewerFor(cookie.split("=")[1]!.replace(/%.*/, "")) }]);
  });

  it("takes GET and nothing else — nothing a browser sends asks for a still to be taken", async () => {
    const still = recordingStill();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      still: still.handler,
    }));
    for (const method of ["POST", "DELETE", "PUT"]) {
      const res = await call(method, "/video/cam0/still", { cookie: sessionCookie(sessions) });
      expect(res.status, method).toBe(405);
    }
    expect(still.seen).toEqual([]);
  });

  it("answers 404 in words on a console assembled with no still proxy", async () => {
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
    }));
    const res = await call("GET", "/video/cam0/still", { cookie: sessionCookie(sessions) });
    expect(res.status).toBe(404);
    expect(res.body).toContain("serves no stills");
  });

  it("relays the daemon's refusal, in words, and never caches it", async () => {
    const still = recordingStill({
      status: 404, contentType: "application/json",
      body: '{"error":"cam0 is not running: there is no pipeline to take a frame from"}',
      headers: undefined,
    });
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: answering(200, "{}") }),
      sessions,
      still: still.handler,
    }));
    const res = await call("GET", "/video/cam0/still", { cookie: sessionCookie(sessions) });
    expect(res.status).toBe(404);
    expect(res.body).toContain("cam0 is not running");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("leaves the handshake, the report and the capture where they were", async () => {
    const whep = recordingWhep();
    const capture = recordingCaptureFor();
    const still = recordingStill();
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({
      client: new DaemonClient({ transport: recording(200, "{}") }),
      sessions,
      whep: whep.handler,
      capture: capture.handler,
      still: still.handler,
    }));
    const cookie = sessionCookie(sessions);

    await call("POST", "/video/cam0/whep", { raw: OFFER, type: "application/sdp", cookie });
    await call("POST", "/video/cam0/report", { json: { want: "stills" }, cookie });
    await callBytes("GET", "/video/cam0/captures/2026-09-07T14-22-05-123Z-1280x720.jpg", cookie);

    expect(whep.seen).toHaveLength(1);
    expect(capture.seen).toHaveLength(1);
    expect(still.seen).toEqual([]);
  });

  /** The capture stand-in, as the describe above builds it, for the test
   *  that holds the three routes apart. */
  function recordingCaptureFor(): {
    handler: NonNullable<ConsoleMiddlewareDeps["capture"]>;
    seen: { camera: string; name: string }[];
  } {
    const seen: { camera: string; name: string }[] = [];
    return {
      seen,
      handler: (req) => {
        seen.push({ camera: req.camera, name: req.name });
        return Promise.resolve({ status: 200, contentType: "image/jpeg", body: Readable.from([JPEG]) });
      },
    };
  }
});

describe("viewerFor", () => {
  /**
   * It goes into messages the page carries around and posts back, so the one
   * thing it must not be is the credential it is derived from.
   */
  it("is not the session token, and cannot be read back to it", () => {
    const token = "abc.def-a-real-looking-session-token";
    const id = viewerFor(token);
    expect(id).not.toContain(token);
    expect(token).not.toContain(id);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for one session and different for another", () => {
    expect(viewerFor("one")).toBe(viewerFor("one"));
    expect(viewerFor("one")).not.toBe(viewerFor("two"));
  });

  it("is a shape the daemon's viewer route will accept", () => {
    expect(viewerFor("one")).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });
});

describe("cookieValue", () => {
  it("finds one cookie among several", () => {
    expect(cookieValue("a=1; yonder_session=abc; b=2", SESSION_COOKIE)).toBe("abc");
  });
  it("is not fooled by a name that ends the same way", () => {
    expect(cookieValue("not_yonder_session=abc", SESSION_COOKIE)).toBeUndefined();
  });
  it("returns nothing when there is no header at all", () => {
    expect(cookieValue(undefined, SESSION_COOKIE)).toBeUndefined();
    expect(cookieValue("", SESSION_COOKIE)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

/**
 * R-UI-01: the entire interface is served from the device, with no asset
 * fetched from the internet at runtime. Asserted as a test rather than left
 * to review, because a stylesheet or a font added in a hurry is exactly how
 * this regresses — and it regresses invisibly, on a bench with a network, and
 * shows up as a blank page on an aircraft that has none.
 */
describe("the console's pages", () => {
  const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "assets");
  const pages = readdirSync(ASSETS).filter((f) => f.endsWith(".html"));

  it("are all three of them", () => {
    expect(pages.sort()).toEqual(["login.html", "restarting.html", "setup.html"]);
  });

  for (const page of pages) {
    describe(page, () => {
      const html = readFileSync(join(ASSETS, page), "utf8");

      it("fetches nothing from anywhere", () => {
        expect(html).not.toMatch(/https?:\/\//);
        expect(html).not.toMatch(/<link[^>]+href=/i);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<img/i);
        expect(html).not.toMatch(/@import/i);
        expect(html).not.toMatch(/url\(/i);
      });

      it("is day-themed, which is the default", () => {
        // R-UI-07. Full theming is a later milestone; this page just must not
        // be dark, because in direct sunlight a dark screen is a mirror.
        expect(html).toContain("color-scheme: light");
        expect(html).not.toMatch(/prefers-color-scheme:\s*dark/);
      });

      it("carries its licence", () => {
        expect(html).toContain("SPDX-License-Identifier: GPL-3.0-or-later");
      });
    });
  }

  /**
   * ADR-0007. The access-point passphrase is a published default and must
   * never be described as a secret anywhere, in docs or in the interface —
   * describing a published value as a secret teaches people the wrong thing
   * about the rest of the system.
   */
  it("say plainly that the access-point passphrase is published, not secret", () => {
    const setup = readFileSync(join(ASSETS, "setup.html"), "utf8");
    expect(setup).toMatch(/published default/i);
    expect(setup).not.toMatch(/secret (passphrase|wi-?fi)/i);
    expect(setup).toMatch(/lock/i);
  });
});

describe('private accessory aim proxy', () => {
  const gesture = { op: 'issue', clientGesture: 'physical-1' };
  async function fixture() {
    const transport = recording(200, '{"accepted":true,"grant":{"gesture":"g","credential":"secret","deadline":500}}');
    const sessions = new SessionStore({ clock: fakeClock() });
    await serve(consoleMiddleware({ client: new DaemonClient({ transport }), sessions }));
    const token = sessions.mint();
    return { transport, sessions, token, cookie: `${SESSION_COOKIE}=${token}`,
      headers: { origin: `http://127.0.0.1:${port}`, 'x-yonder-aim': '1', 'sec-fetch-site': 'same-origin' } };
  }
  it('derives the owner from a current session and returns private grants only to the caller', async () => {
    const f = await fixture();
    const reply = await call('POST', '/video/cam1/aim', { cookie: f.cookie, headers: f.headers, json: gesture });
    expect(reply.status).toBe(200); expect(reply.headers['cache-control']).toBe('no-store');
    expect(f.transport.calls[0]).toMatchObject({ method: 'POST', path: '/cameras/cam1/aim', body: { owner: viewerFor(f.token), request: gesture } });
    expect(passedThrough).toEqual([]);
    f.sessions.revoke(f.token);
    expect((await call('POST', '/video/cam1/aim', { cookie: f.cookie, headers: f.headers, json: gesture })).status).toBe(401);
    expect(f.transport.calls).toHaveLength(1);
  });
  it('rejects cross-origin, forged owner fields and malformed JSON before the daemon', async () => {
    const f = await fixture();
    expect((await call('POST', '/video/cam1/aim', { cookie: f.cookie, headers: { ...f.headers, origin: 'http://attacker.invalid' }, json: gesture })).status).toBe(403);
    expect((await call('POST', '/video/cam1/aim', { cookie: f.cookie, headers: f.headers, json: { ...gesture, owner: 'other' } })).status).toBe(400);
    expect((await call('POST', '/video/cam1/aim', { cookie: f.cookie, headers: f.headers, raw: '{', type: 'application/json' })).status).toBe(400);
    expect(f.transport.calls).toEqual([]);
  });
  it.each([[2, -1], [60, 0], [0, -120], [72, 96]])('forwards the exact one-use grant and deadline at %s/%s degrees per second', async (pan, tilt) => {
    const f = await fixture();
    const request = { op: 'slew', gesture: 'g', credential: 'c', deadline: 12, seq: 2, pan, tilt };
    expect((await call('POST', '/video/cam1/aim', { cookie: f.cookie, headers: f.headers, json: request })).status).toBe(200);
    expect(f.transport.calls[0].body).toEqual({ owner: viewerFor(f.token), request });
  });
  it.each([[120.1, 0], [0, -120.1], [120, 120]])('refuses over-cap vectors %s/%s before forwarding', async (pan, tilt) => {
    const f = await fixture();
    const request = { op: 'slew', gesture: 'g', credential: 'c', deadline: 12, seq: 2, pan, tilt };
    expect((await call('POST', '/video/cam1/aim', { cookie: f.cookie, headers: f.headers, json: request })).status).toBe(400);
    expect(f.transport.calls).toHaveLength(0);
  });
});
