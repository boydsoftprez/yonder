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
import { SecretStore } from "../secrets/store.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { DEFAULT_AP_PASSPHRASE } from "../net/profiles.js";
import type { Clock, Renderer } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import type { CommandRunner } from "../net/runner.js";

let dir: string, configPath: string, journalPath: string;
const noopRenderer: Renderer = { name: "noop", async render() {} };
const frozenClock: Clock = { now: () => 0, setTimer: () => 1, clearTimer: () => {} };

// startServer now also assembles a network renderer via buildRenderers(). A
// fake runner and a secretsPath inside the test's own tmpdir keep it inert —
// these tests exercise the HTTP/apply plumbing, not networking, and must
// never touch a real nmcli or write outside the sandbox.
const noopRunner: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });

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
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
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
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
    try {
      expect(statSync(socketPath).isSocket()).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("answers 400 to a body that is not JSON", async () => {
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
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

    const server = await startServer({ socketPath, configPath, journalPath, renderers: [watcher], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
    try {
      expect(loadConfig(configPath).system.hostname).toBe("yonder");
      // Two renders: the rollback, then the startup render that brings the
      // access point up on a device nobody has applied anything to. Binding
      // first would let a console connect to a device still carrying the
      // change that cut its operator off.
      expect(socketAtRender).toEqual([false, false]);

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

      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
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

  it("seeds a default configuration when the device has none", async () => {
    // A freshly flashed board that was never given a config.yaml. Before this,
    // loadConfig threw before listen() and Restart=always looped forever.
    rmSync(configPath);
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
    try {
      expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
      expect((await call(socketPath, "GET", "/status")).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("leaves an existing configuration alone", async () => {
    saveConfig(configPath, changed());
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
    try {
      expect(loadConfig(configPath).system.hostname).toBe("changed");
    } finally {
      await server.close();
    }
  });

  /**
   * R-CFG-08. Without this, renderAll only ever ran from apply() and the two
   * rollback paths, so a device nobody had posted an apply to came up with no
   * access point — and nobody could post one, because reaching the device is
   * what the access point is for.
   */
  it("renders the current configuration at startup, before the socket exists", async () => {
    const seen: { ssid: string; socket: boolean }[] = [];
    const watcher: Renderer = {
      name: "watch",
      async render(c) { seen.push({ ssid: c.network.ap.ssid, socket: existsSync(socketPath) }); },
    };

    const server = await startServer({ socketPath, configPath, journalPath, renderers: [watcher], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
    try {
      expect(seen).toEqual([{ ssid: "yonder", socket: false }]);
    } finally {
      await server.close();
    }
  });

  /**
   * ADR-0007. The daemon used to print every secret it generated, because a
   * random per-device passphrase nobody sees is useless. There is no random
   * passphrase now, so nothing is printed — but the operator is still told,
   * plainly, that the device is on the published default.
   */
  it("reports the default passphrase without printing any secret", async () => {
    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    let server: { close(): Promise<void> };
    try {
      server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
    } finally {
      stdout.mockRestore();
    }
    try {
      const out = lines.join("");
      expect(out).toMatch(/access point: using the published default passphrase/);
      expect(out).not.toMatch(/generated /);
    } finally {
      await server.close();
    }
  });

  it("seeds the access point passphrase but never an administrator password", async () => {
    const secretsPath = join(dir, "secrets.yaml");
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath, runner: noopRunner });
    try {
      const bag = new SecretStore(secretsPath);
      expect(bag.get("ap_psk")).toBe(DEFAULT_AP_PASSPHRASE);
      // R-SEC-09: it does not exist until the operator sets it. That absence
      // is what makes the console's first-run setup step mean anything.
      expect(bag.get("editor_password")).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("binds the socket even when the startup render fails", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const wedged: Renderer = {
        name: "wedged",
        async render() { throw new Error("NetworkManager is not running"); },
      };
      // A board whose networking is broken is exactly the one an operator
      // needs to be able to ask what is wrong. The configuration API comes up
      // regardless, the same as when recovery fails.
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [wedged], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
      try {
        expect(statSync(socketPath).isSocket()).toBe(true);
        expect((await call(socketPath, "GET", "/status")).status).toBe(200);
      } finally {
        await server.close();
      }
    } finally {
      stderr.mockRestore();
    }
  });
});
