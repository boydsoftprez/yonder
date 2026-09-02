// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setupMiddleware, consoleMiddleware, cookieValue, SESSION_COOKIE, type Middleware } from "./middleware.js";
import { DaemonClient, type Transport } from "./client.js";
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
  opts: { form?: Record<string, string>; json?: unknown; cookie?: string; raw?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let payload: Buffer | undefined;
    const headers: Record<string, string> = {};
    if (opts.form !== undefined) {
      payload = Buffer.from(new URLSearchParams(opts.form).toString(), "utf8");
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (opts.json !== undefined) {
      payload = Buffer.from(JSON.stringify(opts.json), "utf8");
      headers["content-type"] = "application/json";
    } else if (opts.raw !== undefined) {
      payload = Buffer.from(opts.raw, "utf8");
      headers["content-type"] = "application/x-www-form-urlencoded";
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

/** A transport that answers with exactly this and counts how often it is asked. */
function answering(status: number, body: string): Transport & { calls: number } {
  const t = (): Promise<{ status: number; body: string }> => {
    t.calls += 1;
    return Promise.resolve({ status, body });
  };
  t.calls = 0;
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

function consoleWith(transport: Transport, sessions = new SessionStore({ clock: fakeClock() })): {
  middleware: Middleware;
  sessions: SessionStore;
} {
  return {
    middleware: consoleMiddleware({ client: new DaemonClient({ transport }), sessions }),
    sessions,
  };
}

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
    expect(login.headers.location).toBe("/");

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

  it("does not cache a page carrying a password field", async () => {
    await serve(consoleWith(answering(200, '{"ok":true}')).middleware);
    const res = await call("GET", "/");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });
});

// ---------------------------------------------------------------------------

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
