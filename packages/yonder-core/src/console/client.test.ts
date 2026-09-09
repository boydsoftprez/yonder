// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, unixTransport, type Transport } from "./client.js";

/**
 * The console's client, and the one property that matters about it: **a
 * daemon that is down, slow, or returning nonsense produces a failed login,
 * never a successful one.**
 *
 * Every failure mode below is produced by a stubbed transport, so no test
 * waits and no test needs a daemon. The real transport gets its own section
 * against a real Unix socket, because "it fails closed" is worth nothing if
 * the thing that talks to the socket does not work.
 */

/** A transport that answers with exactly this, whatever it is asked. */
function answering(status: number, body: string): Transport {
  return () => Promise.resolve({ status, body });
}

/** Every way a transport can fail to produce an answer at all. */
const BROKEN: Record<string, Transport> = {
  "socket absent": () => Promise.reject(new Error("connect ENOENT /run/yonder/core.sock")),
  "connection refused": () => Promise.reject(new Error("connect ECONNREFUSED")),
  "connection reset": () => Promise.reject(new Error("read ECONNRESET")),
  "timed out": () => Promise.reject(new Error("the configuration service did not answer within 5000 ms")),
  "reply not JSON": answering(200, "<html>a proxy got in the way</html>"),
  "reply truncated": answering(200, '{"ok":tr'),
  "reply is an error page": answering(502, "Bad Gateway"),
  "transport throws synchronously": () => { throw new Error("no socket configured"); },
};

/** Answers that are JSON, but not an answer to the question asked. */
const NONSENSE: Record<string, Transport> = {
  "ok is a string": answering(200, '{"ok":"true"}'),
  "ok is one": answering(200, '{"ok":1}'),
  "no ok at all": answering(200, "{}"),
  "null body": answering(200, "null"),
  "an array": answering(200, "[]"),
  "empty body": answering(200, ""),
  "the wrong status": answering(204, '{"ok":true}'),
  "an error with ok true in it": answering(500, '{"ok":true}'),
};

describe("DaemonClient.login", () => {
  it("is true only for a 200 whose body says ok is exactly true", async () => {
    const client = new DaemonClient({ transport: answering(200, '{"ok":true}') });
    expect(await client.login("a password")).toEqual({ ok: true });
    expect(await client.verify("a password")).toBe(true);
  });

  it("is false when the daemon says so", async () => {
    const client = new DaemonClient({ transport: answering(200, '{"ok":false}') });
    expect((await client.login("wrong")).ok).toBe(false);
  });

  it("is false for every way the daemon can fail to answer", async () => {
    for (const [name, transport] of Object.entries(BROKEN)) {
      const client = new DaemonClient({ transport });
      await expect(client.login("a password"), name).resolves.toEqual({ ok: false });
      await expect(client.verify("a password"), name).resolves.toBe(false);
    }
  });

  it("is false for every answer that is not the answer to this question", async () => {
    for (const [name, transport] of Object.entries(NONSENSE)) {
      const client = new DaemonClient({ transport });
      expect((await client.login("a password")).ok, name).toBe(false);
    }
  });

  it("never throws, whatever comes back", async () => {
    for (const transport of [...Object.values(BROKEN), ...Object.values(NONSENSE)]) {
      const client = new DaemonClient({ transport });
      // An unhandled rejection inside a Node-RED middleware is a console
      // that falls over, which would be a worse failure than a refused login.
      await expect(client.login("a password")).resolves.toEqual({ ok: false });
      await expect(client.provisioned()).resolves.not.toBe(true);
      await expect(client.setPassword("a password")).resolves.toMatchObject({ ok: false });
    }
  });

  it("passes a throttling refusal through, so the page can say wait rather than wrong", async () => {
    const client = new DaemonClient({ transport: answering(429, '{"ok":false,"retryAfter":60}') });
    expect(await client.login("a password")).toEqual({ ok: false, retryAfter: 60 });
  });

  it("ignores a retryAfter that is not a usable number", async () => {
    for (const body of ['{"retryAfter":"soon"}', '{"retryAfter":-1}', '{"retryAfter":null}', "{}"]) {
      const client = new DaemonClient({ transport: answering(429, body) });
      expect(await client.login("a password"), body).toEqual({ ok: false });
    }
  });

  it("sends the password to the verify route and nowhere else", async () => {
    const seen: { method: string; path: string; body?: unknown }[] = [];
    const client = new DaemonClient({
      transport: (req) => { seen.push(req); return Promise.resolve({ status: 200, body: '{"ok":true}' }); },
    });
    await client.login("a password");
    expect(seen).toEqual([{ method: "POST", path: "/admin/verify", body: { password: "a password" } }]);
  });
});

describe("DaemonClient.provisioned", () => {
  it("reports what the daemon said", async () => {
    expect(await new DaemonClient({ transport: answering(200, '{"provisioned":true}') }).provisioned())
      .toBe(true);
    expect(await new DaemonClient({ transport: answering(200, '{"provisioned":false}') }).provisioned())
      .toBe(false);
  });

  /**
   * Undefined, never false. "No password yet" is what opens the setup page,
   * so a daemon that is not answering must not be able to produce it.
   */
  it("says it cannot tell rather than saying unprovisioned", async () => {
    for (const [name, transport] of Object.entries({ ...BROKEN, ...NONSENSE })) {
      const answer = await new DaemonClient({ transport }).provisioned();
      expect(answer, name).not.toBe(false);
      expect(answer, name).toBeUndefined();
    }
    // Including the daemon's own "I cannot read my secrets" 503.
    expect(await new DaemonClient({ transport: answering(503, '{"error":"…"}') }).provisioned())
      .toBeUndefined();
  });
});

describe("DaemonClient.setPassword", () => {
  it("relays a refusal with its status and its message", async () => {
    const client = new DaemonClient({
      transport: answering(400, '{"error":"the administrator password must be at least 8 characters"}'),
    });
    expect(await client.setPassword("short")).toEqual({
      ok: false,
      status: 400,
      error: "the administrator password must be at least 8 characters",
    });
  });

  it("relays the 409 that means one is already set", async () => {
    const client = new DaemonClient({ transport: answering(409, '{"error":"already set"}') });
    const result = await client.setPassword("a long enough password");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });

  it("is a refusal when a 200 comes back without the daemon's own answer in it", async () => {
    // Valid JSON, wrong shape — something answering on this socket that is
    // not the daemon. Announcing a password that was never stored would send
    // the operator away, and they would find out only when the console came
    // back still asking for one.
    const client = new DaemonClient({ transport: answering(200, '{"status":"fine"}') });
    const result = await client.setPassword("a long enough password");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(502);
    expect(result.error).toMatch(/was not set/);
  });

  it("says the service is not answering rather than inventing a reason", async () => {
    const client = new DaemonClient({ transport: BROKEN["socket absent"]! });
    const result = await client.setPassword("a long enough password");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.error).toMatch(/not answering/);
  });

  it("does not put a transport error message in front of an operator", async () => {
    // The message from below could name a socket path, a file mode, or
    // whatever a proxy chose to say. None of it is for the operator, and the
    // console has no journal of its own to hide it in.
    const client = new DaemonClient({
      transport: () => Promise.reject(new Error("connect EACCES /run/yonder/core.sock")),
    });
    const result = await client.setPassword("a long enough password");
    expect(result.error).not.toContain("EACCES");
    expect(result.error).not.toContain("/run/yonder");
  });
});

/**
 * The stubs above prove the client fails closed. This proves the thing it
 * fails closed *from* actually works — a client that could never reach a
 * daemon would pass every test in this file and be useless.
 */
describe("unixTransport, against a real socket", () => {
  let dir: string, socketPath: string, server: Server;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yonder-client-"));
    socketPath = join(dir, "core.sock");
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    rmSync(dir, { recursive: true, force: true });
  });

  function listen(handler: Parameters<typeof createServer>[1]): Promise<void> {
    server = createServer(handler);
    return new Promise((resolve) => { server.listen(socketPath, resolve); });
  }

  it("carries a request and a reply over the socket", async () => {
    let seen = "";
    await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seen = `${req.method ?? ""} ${req.url ?? ""} ${Buffer.concat(chunks).toString("utf8")}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    const client = new DaemonClient({ socketPath });
    expect(await client.login("a password")).toEqual({ ok: true });
    expect(seen).toBe('POST /admin/verify {"password":"a password"}');
  });

  it("allows a bounded operation-specific wait without lengthening ordinary requests", async () => {
    await listen((_req,res) => { setTimeout(() => { res.writeHead(200);res.end('{}'); },80); });
    const client=new DaemonClient({socketPath,timeoutMs:20});
    expect((await client.request({method:'POST',path:'/cameras/cam0/apply',body:{},timeoutMs:300})).ok).toBe(true);
    expect((await client.request({method:'GET',path:'/status'})).ok).toBe(false);
  });

  it("fails closed against a socket path with nothing behind it", async () => {
    await listen(() => {});
    const client = new DaemonClient({ socketPath: join(dir, "not-a-socket") });
    expect((await client.login("a password")).ok).toBe(false);
    expect(await client.provisioned()).toBeUndefined();
  });

  it("fails closed against a daemon that accepts and never answers", async () => {
    // The failure a socket error does not cover, and the one that would
    // otherwise leave a browser waiting for ever. A short timeout so the
    // test is quick; nothing here sleeps waiting for a real one.
    await listen(() => { /* no reply, ever */ });
    const client = new DaemonClient({ socketPath, timeoutMs: 40 });
    expect((await client.login("a password")).ok).toBe(false);
  });

  it("refuses to be built with neither a socket nor a transport", () => {
    expect(() => new DaemonClient({})).toThrow(/socketPath or a transport/);
  });
});
