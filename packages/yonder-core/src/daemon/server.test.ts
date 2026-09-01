// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter } from "./routes.js";
import { startServer } from "./server.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { loadConfig } from "../config/load.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Clock, Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";

let dir: string, configPath: string, journalPath: string;
const noopRenderer: Renderer = { name: "noop", async render() {} };
const frozenClock: Clock = { now: () => 0, setTimer: () => 1, clearTimer: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-api-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
  saveConfig(configPath, DEFAULT_CONFIG);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function router() {
  const engine = new ApplyEngine({ configPath, journalPath, renderers: [noopRenderer], clock: frozenClock });
  return createRouter({ engine, configPath });
}

function changed(): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.system.hostname = "changed";
  return c;
}

describe("router", () => {
  it("GET /config returns the current configuration", async () => {
    const res = await router()("GET", "/config", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { version: number }).version).toBe(1);
  });

  it("GET /status reports idle before any apply", async () => {
    const res = await router()("GET", "/status", undefined);
    expect(res.status).toBe(200);
    expect((res.body as { state: string }).state).toBe("idle");
  });

  it("POST /apply returns 200 and an id", async () => {
    const res = await router()("POST", "/apply", changed());
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBeTruthy();
  });

  it("POST /apply returns 400 with issues when config is invalid", async () => {
    const res = await router()("POST", "/apply", { version: 1 });
    expect(res.status).toBe(400);
    expect((res.body as { issues: string[] }).issues.length).toBeGreaterThan(0);
  });

  it("POST /confirm keeps the change", async () => {
    const r = router();
    const applied = await r("POST", "/apply", changed());
    const id = (applied.body as { id: string }).id;
    const res = await r("POST", "/confirm", { id });
    expect(res.status).toBe(200);
    expect(((await r("GET", "/status", undefined)).body as { state: string }).state).toBe("confirmed");
  });

  it("POST /confirm with a wrong id returns 400", async () => {
    const r = router();
    await r("POST", "/apply", changed());
    const res = await r("POST", "/confirm", { id: "wrong" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown route", async () => {
    const res = await router()("GET", "/nope", undefined);
    expect(res.status).toBe(404);
  });
});

/**
 * Talk to the daemon the way the console will: over the Unix socket, with a
 * real HTTP client. Nothing here reaches for a port, because there is not one.
 */
function call(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text === "" ? undefined : JSON.parse(text) });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

describe("startServer", () => {
  let socketPath: string;
  beforeEach(() => { socketPath = join(dir, "core.sock"); });

  it("binds a Unix socket, group-accessible and nothing wider", async () => {
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer] });
    try {
      // A socket in the filesystem, reachable only by something that can open
      // it: no interface can expose the configuration API by accident.
      expect(statSync(socketPath).isSocket()).toBe(true);
      expect(statSync(socketPath).mode & 0o777).toBe(0o660);

      const res = await call(socketPath, "GET", "/status");
      expect(res.status).toBe(200);
      expect((res.body as { state: string }).state).toBe("idle");
    } finally {
      await server.close();
    }
    expect(existsSync(socketPath)).toBe(false);
  });

  it("replaces a socket left behind by a previous process", async () => {
    writeFileSync(socketPath, "");
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer] });
    try {
      expect(statSync(socketPath).isSocket()).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("answers 400 to a body that is not JSON", async () => {
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer] });
    try {
      const res = await call(socketPath, "POST", "/apply", "{ truncated");
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/not valid JSON/);
    } finally {
      await server.close();
    }
  });

  it("reverts an unconfirmed change before the socket exists", async () => {
    saveConfig(configPath, changed());
    writeFileSync(journalPath, JSON.stringify({ id: "prior", previous: DEFAULT_CONFIG, startedAt: 0 }));

    const socketAtRender: boolean[] = [];
    const watcher: Renderer = {
      name: "watch",
      async render() { socketAtRender.push(existsSync(socketPath)); },
    };

    const server = await startServer({ socketPath, configPath, journalPath, renderers: [watcher] });
    try {
      expect(loadConfig(configPath).system.hostname).toBe("yonder");
      // Binding first would let a console connect to a device still carrying
      // the change that cut its operator off.
      expect(socketAtRender).toEqual([false]);

      const res = await call(socketPath, "GET", "/status");
      const status = res.body as { state: string; lastResult?: { id: string; outcome: string } };
      expect(status.state).toBe("idle");
      expect(status.lastResult).toMatchObject({ id: "prior", outcome: "reverted" });
    } finally {
      await server.close();
    }
  });

  it("binds the socket even when recovery cannot complete", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      saveConfig(configPath, changed());
      writeFileSync(journalPath, JSON.stringify({ id: "prior", previous: DEFAULT_CONFIG, startedAt: 0 }));
      // Occupy the temp path the atomic write needs, so the rollback fails.
      mkdirSync(`${configPath}.tmp`);

      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer] });
      try {
        // A daemon that refuses to start because it could not roll back leaves
        // an operator with no way in at all.
        expect(statSync(socketPath).isSocket()).toBe(true);
        expect((await call(socketPath, "GET", "/status")).status).toBe(200);
        // The journal stays, so the next start tries the rollback again.
        expect(existsSync(journalPath)).toBe(true);
      } finally {
        await server.close();
      }
    } finally {
      stderr.mockRestore();
    }
  });
});
