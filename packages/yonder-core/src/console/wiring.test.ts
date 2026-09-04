// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consoleGate, editorAuth, ADMIN_USERNAME } from "./wiring.js";

/**
 * The two functions a generated settings.js calls, and the only surface
 * between a description of a console and the code that is one.
 *
 * Every test here points at a socket path with nothing behind it. That is the
 * state a console is in whenever the daemon is down, and everything below has
 * to be correct in it.
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
