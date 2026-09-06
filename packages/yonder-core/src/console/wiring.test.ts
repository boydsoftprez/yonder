// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consoleGate, editorAuth, headInjection, ADMIN_USERNAME } from "./wiring.js";
import type { Middleware } from "./middleware.js";

/**
 * The functions a generated settings.js calls, and the only surface between
 * a description of a console and the code that is one.
 *
 * Every test against `consoleGate`/`editorAuth` points at a socket path with
 * nothing behind it. That is the state a console is in whenever the daemon is
 * down, and everything below has to be correct in it.
 */
const DEAD_SOCKET = join(tmpdir(), "yonder-no-such-daemon.sock");

let server: Server | undefined;
afterEach(async () => {
  if (server === undefined) return;
  await new Promise<void>((resolve) => { server?.close(() => { resolve(); }); });
  server = undefined;
});

function through(
  gate: ReturnType<typeof consoleGate>,
  path: string,
  opts: { method?: string; body?: string; type?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      gate(req, res, () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("behind the gate");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server?.address() as { port: number }).port;
      const headers: Record<string, string> = {};
      const payload = opts.body === undefined ? undefined : Buffer.from(opts.body, "utf8");
      if (payload !== undefined) {
        headers["content-type"] = opts.type ?? "application/x-www-form-urlencoded";
        headers["content-length"] = String(payload.length);
      }
      const method = opts.method ?? "GET";
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  });
}

describe("consoleGate", () => {
  it("is the setup gate on a device with no administrator password", async () => {
    const gate = consoleGate({ socketPath: DEAD_SOCKET, provisioned: false, log: () => {} });
    expect(await through(gate, "/")).toMatchObject({ status: 200 });
    expect((await through(gate, "/")).body).toContain("Set an administrator password");
  });

  it("mounts nothing else in setup mode, whatever is behind it", async () => {
    const gate = consoleGate({ socketPath: DEAD_SOCKET, provisioned: false, log: () => {} });
    for (const path of ["/editor", "/dashboard", "/config"]) {
      const res = await through(gate, path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toBe("behind the gate");
    }
  });

  it("is the login gate on a provisioned device", async () => {
    const gate = consoleGate({ socketPath: DEAD_SOCKET, provisioned: true, log: () => {} });
    const res = await through(gate, "/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Sign in");
    expect(res.body).not.toBe("behind the gate");
  });

  /**
   * R-SEC-13, asserted where the routes are actually assembled.
   *
   * The stream handshake is the only way a browser reaches a picture — the
   * media server's WebRTC listener is on loopback — so a caller with no
   * session must not get one. Asserted here as well as in whep.test.ts
   * because a route that is authenticated only because it happens to sit
   * below a check is a route that stops being authenticated the day somebody
   * reorders the table.
   */
  it("does not hand out a stream handshake to a caller with no session", async () => {
    const gate = consoleGate({ socketPath: DEAD_SOCKET, provisioned: true, log: () => {} });
    const res = await through(gate, "/video/cam0-preview/whep", {
      method: "POST",
      type: "application/sdp",
      body: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n",
    });
    expect(res.status).toBe(401);
    // The proxy's own refusal, not the gate's generic one: this is what says
    // the route was assembled and refused, rather than never existing and
    // being caught by whatever happens to sit below it.
    expect(res.body).toContain("log in to watch this camera");
    expect(res.body).not.toContain("v=0");
    expect(res.body).not.toBe("behind the gate");
  });

  it("builds its client lazily, so a daemon that is not up yet is not a crash", () => {
    // Node-RED evaluates settings.js at start-up, and on a cold boot the
    // daemon's socket may not exist yet. Constructing the gate must not
    // depend on it.
    expect(() => consoleGate({ socketPath: DEAD_SOCKET, provisioned: false, log: () => {} }))
      .not.toThrow();
  });
});

describe("editorAuth", () => {
  it("is the credentials shape Node-RED's adminAuth expects", () => {
    const auth = editorAuth({ socketPath: DEAD_SOCKET });
    expect(auth.type).toBe("credentials");
    expect(typeof auth.users).toBe("function");
    expect(typeof auth.authenticate).toBe("function");
  });

  it("knows one administrator and no one else", async () => {
    const auth = editorAuth({ socketPath: DEAD_SOCKET });
    expect(await auth.users(ADMIN_USERNAME)).toEqual({ username: ADMIN_USERNAME, permissions: "*" });
    for (const other of ["root", "pi", "", "Admin"]) {
      expect(await auth.users(other), other).toBeNull();
    }
  });

  /**
   * The property the whole milestone turns on, at the editor's door as well
   * as the console's: a daemon that is not answering produces a refused
   * login, never a successful one.
   */
  it("refuses every login when the daemon is not there", async () => {
    const auth = editorAuth({ socketPath: DEAD_SOCKET });
    expect(await auth.authenticate(ADMIN_USERNAME, "any password at all")).toBeNull();
    expect(await auth.authenticate(ADMIN_USERNAME, "")).toBeNull();
    expect(await auth.authenticate("root", "any password at all")).toBeNull();
  });

  it("never throws out of authenticate, whatever happens below it", async () => {
    // passport calls this inside its own promise chain; a rejection there is
    // an editor that returns a stack trace instead of a login form.
    const auth = editorAuth({ socketPath: "/dev/null/not-a-socket" });
    await expect(auth.authenticate(ADMIN_USERNAME, "x")).resolves.toBeNull();
  });
});

/**
 * `headInjection` is `RED.settings.dashboard.middleware` — the hook
 * `@flowfuse/node-red-dashboard`'s `ui_base.js` runs in front of everything
 * it serves, static bundle and document alike. Driven here against a real
 * `node:http` server and a handler that stands in for what that package
 * actually does downstream, the same way `consoleGate` above is driven
 * against a real gate rather than trusted from its source.
 */
describe("headInjection", () => {
  function serve(
    middleware: Middleware,
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
    return new Promise((resolve, reject) => {
      server = createServer((req, res) => { middleware(req, res, () => { handler(req, res); }); });
      server.listen(0, "127.0.0.1", () => {
        const port = (server?.address() as { port: number }).port;
        const req = request({ host: "127.0.0.1", port, method: "GET", path: "/" }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
          });
        });
        req.on("error", reject);
        req.end();
      });
    });
  }

  const TAG = '<link rel="stylesheet" href="/yonder/theme.css">';
  const page = "<!doctype html><html><head><title>t</title></head><body></body></html>";
  const injected = page.replace("</head>", `${TAG}\n</head>`);

  /**
   * `res.setHeader` then an unadorned `res.end`/`res.write` — never a single
   * `res.writeHead(status, headers)` — is what the `send` package Dashboard's
   * own `express.static` wraps actually calls, confirmed by tracing a real
   * request through a real Dashboard 1.31.0 rather than assumed. It matters
   * here specifically: Node flushes headers immediately when `writeHead` is
   * given a headers object, and `res.getHeader` after a flush answers
   * nothing — which this exists to fix, not to depend on.
   */
  it("puts the markup in the head of an HTML document sent in one write", async () => {
    const res = await serve(headInjection(TAG), (_req, res) => {
      res.setHeader("content-type", "text/html; charset=UTF-8");
      res.write(Buffer.from(page));
      res.end();
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe(injected);
  });

  it("puts the markup in the head of a document sent as a single end(chunk)", async () => {
    // express.static's own automatic index.html serving for a bare directory
    // request — which is what a request for the console's own root path
    // actually gets, and the one shape a fix that only patches res.sendFile
    // never sees at all (see this function's own doc comment).
    const res = await serve(headInjection(TAG), (_req, res) => {
      res.setHeader("content-type", "text/html; charset=UTF-8");
      res.end(page);
    });
    expect(res.body).toBe(injected);
  });

  it("assembles a document handed over in several writes before it looks for the head", () => {
    const chunks = [page.slice(0, 20), page.slice(20, 40), page.slice(40)];
    return serve(headInjection(TAG), (_req, res) => {
      res.setHeader("content-type", "text/html; charset=UTF-8");
      for (const c of chunks) res.write(c);
      res.end();
    }).then((res) => {
      expect(res.body).toBe(injected);
    });
  });

  /**
   * The other legal way to answer with a content type: `writeHead(status,
   * headers)` in one call, rather than `setHeader` beforehand. Node flushes
   * immediately in this shape, which is exactly what defeated the first
   * version of this (see the doc comment on `headInjection`) — so this
   * proves the fix, not just the common case above.
   */
  it("still recognises an HTML document announced through writeHead's own headers argument", async () => {
    const res = await serve(headInjection(TAG), (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end(page);
    });
    expect(res.body).toBe(injected);
  });

  /**
   * The gate this exists for: `express.static` and the `send` package it
   * wraps write the SPA's JS, CSS and image bundles through the exact same
   * response object, and none of them may come back with markup spliced into
   * them — nor with a length recomputed for a body that never changed.
   */
  it("leaves a non-HTML response, and its own Content-Length, byte-for-byte alone", async () => {
    const script = 'var x = 1; var head = "</head>";';
    const res = await serve(headInjection(TAG), (_req, res) => {
      res.setHeader("content-type", "application/javascript; charset=UTF-8");
      res.setHeader("content-length", Buffer.byteLength(script));
      res.end(script);
    });
    expect(res.body).toBe(script);
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(script)));
  });

  /**
   * The bytes sent no longer match the file the original validators
   * described, so a conditional request must not be answered out of a cache
   * keyed on them.
   */
  it("drops the stale validators and states the length it actually sent", async () => {
    const res = await serve(headInjection(TAG), (_req, res) => {
      res.setHeader("content-type", "text/html; charset=UTF-8");
      res.setHeader("etag", 'W/"deadbeef"');
      res.setHeader("last-modified", "Mon, 01 Jan 2024 00:00:00 GMT");
      res.setHeader("cache-control", "public, max-age=0");
      res.end(page);
    });
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers["last-modified"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(injected)));
    expect(res.body).toBe(injected);
  });

  /**
   * `RED.settings.dashboard.middleware` is the same function value mounted at
   * three separate points in Dashboard's own route table (the static bundle,
   * the exact index route, and the SPA's catch-all). A request that falls
   * through to the second mount point on the same response must not be
   * spliced twice — that is the shape a deep-linked page reload actually
   * takes, once `express.static` has looked for a file that is not there and
   * called `next()`.
   */
  it("does not splice the markup in twice when it runs on the same response twice", async () => {
    const mw = headInjection(TAG);
    const res = await serve(mw, (req, res) => {
      mw(req, res, () => {
        res.setHeader("content-type", "text/html; charset=UTF-8");
        res.end(page);
      });
    });
    expect(res.body).toBe(injected);
  });

  it("does nothing to a document with no head to speak of", async () => {
    const bare = "<html><body>hello</body></html>";
    const res = await serve(headInjection(TAG), (_req, res) => {
      res.setHeader("content-type", "text/html; charset=UTF-8");
      res.end(bare);
    });
    expect(res.body).toBe(bare);
    // Nothing to splice is nothing to say. A body left alone must not come
    // back wearing a `Cache-Control` this middleware invented for a rewrite
    // that never happened.
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  /**
   * A `text/html` response with no body at all still reaches this middleware,
   * and used to leave it with its headers edited for a splice that could not
   * have happened. `304` is the one that matters: it must not carry a body,
   * and it was being handed `Content-Length: 0`.
   */
  it("leaves a bodyless html response alone", async () => {
    const res = await serve(headInjection(TAG), (_req, res) => {
      res.setHeader("content-type", "text/html; charset=UTF-8");
      res.statusCode = 304;
      res.end();
    });
    expect(res.status).toBe(304);
    expect(res.body).toBe("");
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  /**
   * The one response this must refuse. A handler that has already flushed a
   * header block stating a `Content-Length` has committed to a byte count,
   * and that count is of the document *without* this markup. Splicing it in
   * anyway sends more bytes than were promised; the surplus lands in the
   * socket where the next response's status line belongs, and the client
   * fails to parse a connection that was working until the console tried to
   * style it.
   *
   * So the assertion is not "the markup is absent" — it is that the response
   * is intact and byte-exact. A broken console is a worse outcome than an
   * unstyled one, and this is the trade being made.
   */
  it("refuses a document whose length is already stated and no longer editable", async () => {
    const res = await serve(headInjection(TAG), (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html; charset=UTF-8",
        "content-length": String(Buffer.byteLength(page)),
      });
      res.end(page);
    });
    expect(res.body).toBe(page);
    expect(res.body).not.toContain(TAG);
    // The promise the handler made, kept exactly.
    expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(page)));
  });

  /**
   * **The guard is per response, and nothing proved it.** `headInjection`
   * returns one middleware value which Dashboard mounts at several points in
   * its own route table, so the same response object can pass through it more
   * than once — hence the `WeakSet`. Replacing that `WeakSet` with a single
   * `let patched = false` captured in the closure keeps every other test in
   * this file green, because each of them serves exactly one request. It also
   * means only the first document the console ever serves carries the theme
   * and every reload after it flashes white, which is the whole of R-UI-22.
   *
   * Two requests through one middleware instance is the smallest thing that
   * tells those two implementations apart.
   */
  it("injects into every response, not merely the first one it ever sees", async () => {
    const middleware = headInjection(TAG);
    const bodies = await new Promise<string[]>((resolve, reject) => {
      server = createServer((req, res) => {
        middleware(req, res, () => {
          res.setHeader("content-type", "text/html; charset=UTF-8");
          res.end(page);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server?.address() as { port: number }).port;
        const get = (): Promise<string> => new Promise((ok, bad) => {
          const req = request({ host: "127.0.0.1", port, method: "GET", path: "/" }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => { ok(Buffer.concat(chunks).toString("utf8")); });
          });
          req.on("error", bad);
          req.end();
        });
        // Sequential, not concurrent: a shared-state bug that only the second
        // request can show must not be able to hide behind interleaving.
        get().then((first) => get().then((second) => resolve([first, second]))).catch(reject);
      });
    });
    expect(bodies).toEqual([injected, injected]);
  });
});
