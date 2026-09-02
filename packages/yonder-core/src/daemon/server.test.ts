// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRouter } from "./routes.js";
import { startServer } from "./server.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { loadConfig } from "../config/load.js";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential, ADMIN_PASSWORD_SECRET } from "../console/credential.js";
import { hashPassword } from "../console/password.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { DEFAULT_AP_PASSPHRASE } from "../net/profiles.js";
import { NmcliError } from "../net/nmcli/client.js";
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

/**
 * A device that already has an administrator password.
 *
 * Almost every test below is about the apply engine, the socket or the
 * rollback, and none of those is a test of R-SEC-09's gate — but the gate now
 * sits in front of GET /config, POST /apply and POST /confirm, so a device
 * with no password answers 403 to all three. Seeding one here keeps each test
 * about the thing it was written for. The gate itself is exercised
 * deliberately, in routes.test.ts and in the tests here that deliberately use
 * a secrets file of their own.
 *
 * Hashed once, at module load: scrypt is expensive on purpose, and paying for
 * it in every beforeEach would put seconds on the suite for no coverage.
 */
const ADMIN_PASSWORD = "an operator's password";
const ADMIN_HASH = hashPassword(ADMIN_PASSWORD);

function provision(path: string): void {
  new SecretStore(path).ensureValue(ADMIN_PASSWORD_SECRET, ADMIN_HASH);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-api-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
  saveConfig(configPath, DEFAULT_CONFIG);
  provision(join(dir, "secrets.yaml"));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function credential(): AdminCredential {
  return new AdminCredential(new SecretStore(join(dir, "secrets.yaml")));
}

function router() {
  const engine = new ApplyEngine({ configPath, journalPath, renderers: [noopRenderer], clock: frozenClock });
  return createRouter({ engine, configPath, credential: credential() });
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

  /**
   * A renderer failure arrives here as an NmcliError, which does not extend
   * ConfigError, so it fell through to a 500 whose body was
   * `(e as Error).message` — and that message embeds nmcli's stderr verbatim.
   * The detail belongs in the journal, which needs being on the device to
   * read; being on the device is exactly what the caller may not be.
   */
  it("never puts a subprocess's output in an HTTP response", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const psk = "hunter2hunter2";
      const leaky: Renderer = {
        name: "leaky",
        async render() {
          throw new NmcliError(
            ["nmcli", "connection", "modify", "yonder-ap", "802-11-wireless-security.psk", psk],
            1,
            `Error: invalid property '${psk}'; interface wlan0 at 192.168.77.1`,
          );
        },
      };
      const engine = new ApplyEngine({ configPath, journalPath, renderers: [leaky], clock: frozenClock });
      const res = await createRouter({ engine, configPath, credential: credential() })("POST", "/apply", changed());

      expect(res.status).toBe(500);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(psk);
      expect(text).not.toContain("invalid property");
      expect(text).not.toContain("192.168.77.1");
      expect(text).not.toContain("nmcli");
    } finally {
      stderr.mockRestore();
    }
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

/** A clock the test drives by hand; see the equivalent in watchdog.test.ts. */
function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => t,
    setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  };
  return {
    clock,
    advance(ms: number) {
      t += ms;
      for (const [h, timer] of [...timers]) if (timer.at <= t) { timers.delete(h); timer.fn(); }
    },
  };
}

/**
 * The fallback fires through several chained awaits before it reaches the
 * runner. Draining them is what makes an assertion about what did *not*
 * happen mean anything — see the long note in watchdog.test.ts.
 *
 * The count is deliberately far larger than any chain here is deep. The
 * daemon's start-up work is now more than one call away from the runner — a
 * bounded wait for the radio, then a whole render through the apply engine —
 * and a number tuned to the shortest chain that happened to exist when it was
 * written is a helper that silently stops draining the moment anything grows.
 * Extra turns of an empty microtask queue cost nothing.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
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
    // A secrets file of its own, untouched by the fixture above: the whole
    // point of this test is what a device that nobody has provisioned does
    // not have.
    const secretsPath = join(dir, "unprovisioned-secrets.yaml");
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath, runner: noopRunner });
    try {
      const bag = new SecretStore(secretsPath);
      expect(bag.get("ap_psk")).toBe(DEFAULT_AP_PASSPHRASE);
      // R-SEC-09: neither exists until the operator sets one. That absence is
      // what makes the console's first-run setup step mean anything.
      expect(bag.get("editor_password")).toBeUndefined();
      expect(bag.get(ADMIN_PASSWORD_SECRET)).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  /**
   * The crash loop with no socket. seedConfigIfAbsent covers *absent*, not
   * *invalid* — an existing file is never touched, whatever is in it — so a
   * configuration an operator has hand-edited into nonsense, or one a schema
   * tightening on upgrade has just invalidated, used to take the daemon down
   * before listen(): the start-up render logged "serving anyway", the
   * watchdog's own loadConfig threw on the next line, startServer rejected,
   * main() exited 1, and Restart=always did it again forever.
   *
   * A device with a broken configuration is exactly the device somebody has
   * to be able to reach.
   */
  it("binds the socket when the configuration on disk is invalid", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeFileSync(configPath, "version: 99\nnetwork: nonsense\n");
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
      try {
        expect(statSync(socketPath).isSocket()).toBe(true);
        expect((await call(socketPath, "GET", "/status")).status).toBe(200);
        // And the API says what is wrong with it, rather than the operator
        // having to guess from a service that will not start.
        const res = await call(socketPath, "GET", "/config");
        expect(res.status).toBe(400);
        expect((res.body as { issues: string[] }).issues.length).toBeGreaterThan(0);
      } finally {
        await server.close();
      }
      // The operator's file is never silently replaced with defaults.
      expect(readFileSync(configPath, "utf8")).toContain("version: 99");
    } finally {
      stderr.mockRestore();
    }
  });

  /**
   * K-14, at the HTTP layer. `apply()` used to snapshot config.yaml as its
   * rollback target before validating the operator's own posted body, so an
   * unloadable file on disk refused *every* apply through this route —
   * including a good one — with the schema issues for the file already on
   * disk, which reads as though the posted body was rejected. The daemon
   * itself starting from an invalid config.yaml is exercised just above;
   * this is the repair path that used to be unreachable from it.
   */
  it("accepts a good POST /apply even though the configuration on disk is invalid", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      writeFileSync(configPath, "version: 99\nnetwork: nonsense\n");
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
      try {
        const res = await call(socketPath, "POST", "/apply", changed());
        expect(res.status).toBe(200);
        expect((res.body as { previousIsDefault?: boolean }).previousIsDefault).toBe(true);
        expect(loadConfig(configPath).system.hostname).toBe("changed");
      } finally {
        await server.close();
      }
    } finally {
      stderr.mockRestore();
    }
  });

  /** The same class of failure through the other file the daemon must read. */
  it("binds the socket when secrets.yaml cannot be read", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const secretsPath = join(dir, "secrets.yaml");
      writeFileSync(secretsPath, "ap_psk:\n  not: a-string\n", { mode: 0o600 });
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath, runner: noopRunner });
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

  /**
   * A malformed secrets.yaml means buildRenderers threw, so the daemon is
   * serving with the network renderer missing (see buildRenderers' catch in
   * startServer). Before this, POST /apply still answered 200, POST /confirm
   * still answered 200 "confirmed", and zero nmcli commands were ever issued
   * — the operator was told their change took effect when nothing happened.
   * That is strictly worse than a loud failure, so apply() now refuses
   * outright while degraded, and says why.
   */
  describe("with a renderer set degraded by a malformed secrets.yaml", () => {
    function startDegraded() {
      const secretsPath = join(dir, "secrets.yaml");
      writeFileSync(secretsPath, "ap_psk:\n  not: a-string\n", { mode: 0o600 });
      return startServer({
        socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath, runner: noopRunner,
      });
    }

    it("reports the degraded reason on GET /status", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const server = await startDegraded();
        try {
          const res = await call(socketPath, "GET", "/status");
          expect(res.status).toBe(200);
          const body = res.body as { degraded?: string };
          expect(body.degraded).toMatch(/network renderer could not be built/);
        } finally {
          await server.close();
        }
      } finally {
        stderr.mockRestore();
      }
    });

    it("refuses POST /apply instead of silently succeeding", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const server = await startDegraded();
        try {
          const res = await call(socketPath, "POST", "/apply", changed());
          // It used to be 200 here, with config.yaml written and nothing
          // rendered. Refused instead, and config.yaml is untouched.
          //
          // 403 rather than the engine's own 400: the secrets.yaml that
          // degraded the renderer set is the same file the administrator
          // password lives in, so this daemon cannot tell whether the device
          // has a lock on it, and a daemon that cannot tell refuses. The
          // engine's degraded refusal is unchanged and tested directly in
          // apply/engine.test.ts; the reason still reaches an operator
          // through GET /status, above.
          expect(res.status).toBe(403);
          expect(loadConfig(configPath).system.hostname).toBe("yonder");
        } finally {
          await server.close();
        }
      } finally {
        stderr.mockRestore();
      }
    });

    it("keeps GET /status answering so the device stays diagnosable", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const server = await startDegraded();
        try {
          // GET /status carries no configuration, so it stays in front of the
          // gate and is what makes this state visible at all. GET /config
          // does carry configuration, and R-SEC-09 does not let a device that
          // cannot prove it has an administrator password hand it over.
          expect((await call(socketPath, "GET", "/status")).status).toBe(200);
          const res = await call(socketPath, "GET", "/config");
          expect(res.status).toBe(403);
          expect((res.body as { error: string }).error).toMatch(/administrator password/);
        } finally {
          await server.close();
        }
      } finally {
        stderr.mockRestore();
      }
    });
  });

  it("binds the socket when the configuration directory cannot be seeded", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // A path the durable write cannot create: seedConfigIfAbsent throws
      // ConfigError, and that must cost a default configuration, not the API.
      const wedged = join(dir, "config.yaml", "config.yaml");
      const server = await startServer({ socketPath, configPath: wedged, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner: noopRunner });
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

  /**
   * R-NET-07, at the level that matters: not "the FallbackWatchdog class
   * behaves", but "this daemon actually arms one, points it at the access
   * point, and stops it on close". Every line of that wiring — the
   * watchdog.start(), the apUp closure, the watchdog.stop() in close() —
   * could be deleted with the whole suite green, because nothing above the
   * class ever tested it.
   *
   * The runner records every argv, so `nmcli connection up yonder-ap` is the
   * observable. Nothing else issues it here: the fake device list is empty,
   * so the start-up render finds no wifi interface and never raises the
   * access point itself.
   */
  function watchdogHarness() {
    const { clock, advance } = fakeClock();
    const calls: string[][] = [];
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    const raised = () => calls.filter((c) => c.join(" ") === "nmcli connection up yonder-ap").length;
    return { clock, advance, calls, runner, raised };
  }

  it("arms the fallback watchdog and raises the access point when nothing is reachable", async () => {
    const { clock, advance, runner, raised } = watchdogHarness();
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner, clock });
    try {
      advance(89_000);
      await flushMicrotasks();
      expect(raised()).toBe(0);

      advance(2_000);
      await flushMicrotasks();
      // activeIpv4() returned nothing, so nothing is reachable, so the one
      // action that gets an operator back to the board happens.
      expect(raised()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("stops the fallback watchdog when the server closes", async () => {
    const { clock, advance, runner, raised } = watchdogHarness();
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner, clock });
    await server.close();
    advance(200_000);
    await flushMicrotasks();
    // A timer left running against a closed daemon reconfigures a radio
    // nobody is managing any more.
    expect(raised()).toBe(0);
  });

  /**
   * R-NET-07, second sentence: the window "is measured from the moment the
   * daemon starts, not from kernel boot, and start-up work comes out of it
   * rather than pushing the deadline back."
   *
   * That clause is the daemon's to honour, not the watchdog's. `since` has
   * its own unit tests in watchdog.test.ts, and nothing gated that
   * `startServer` actually passes it — deleting `since: startedAt` left all
   * 273 green.
   *
   * Recovery is the start-up work that can be slow, and the one path
   * guaranteed to run before the watchdog can be armed: a board that crashed
   * mid-apply rolls the configuration back and re-renders it through every
   * renderer. Give that 60 s and the deadline still has to land at t=90 s.
   * The mutant arms a full 90 s after recovery finishes instead, and the
   * access point that R-NET-07 promises within 90 s appears at 150.
   */
  it("measures the fallback deadline from start-up, not from when it arms the watchdog", async () => {
    const { clock, advance, runner, raised } = watchdogHarness();
    // A journal entry left by a previous process is what makes recover() do
    // any work at all; without one it returns immediately.
    writeFileSync(journalPath, JSON.stringify({ id: "prior", previous: DEFAULT_CONFIG, startedAt: 0 }));
    let recovering = true;
    const slowRecovery: Renderer = {
      name: "slow-recovery",
      async render() {
        // Only the rollback re-render inside recover(). The start-up render
        // runs after the watchdog is armed, and moving the clock there would
        // be moving it past a deadline this test is about to check.
        if (recovering) { recovering = false; advance(60_000); }
      },
    };
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [slowRecovery], secretsPath: join(dir, "secrets.yaml"), runner, clock });
    try {
      // t = 60_000, and R-NET-07's 90 s is 30 s away rather than 90.
      advance(29_000);
      await flushMicrotasks();
      expect(raised()).toBe(0);

      advance(1_000);
      await flushMicrotasks();
      expect(raised()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("arms the fallback watchdog even when the configuration cannot be loaded", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { clock, advance, runner, raised } = watchdogHarness();
      writeFileSync(configPath, "version: 99\nnetwork: nonsense\n");
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner, clock });
      try {
        advance(91_000);
        await flushMicrotasks();
        // The device whose config.yaml is unreadable is the one that most
        // needs its access point raised.
        expect(raised()).toBe(1);
      } finally {
        await server.close();
      }
    } finally {
      stderr.mockRestore();
    }
  });

  it("leaves the fallback alone when configuration disables it", async () => {
    const { clock, advance, runner, raised } = watchdogHarness();
    const off = structuredClone(DEFAULT_CONFIG);
    off.network.ap.fallback.enabled = false;
    saveConfig(configPath, off);
    const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner, clock });
    try {
      advance(200_000);
      await flushMicrotasks();
      expect(raised()).toBe(0);
    } finally {
      await server.close();
    }
  });

  /**
   * R-CFG-09, at the level the board actually failed at.
   *
   * A Raspberry Pi running an earlier build was upgraded past the commit that
   * removed `network.ap.dhcp`. Its `/etc/yonder/config.yaml` still carried
   * that key, the schema is strict, and so every read of the file failed. The
   * journal said all of it:
   *
   *     could not render the current configuration, serving anyway: …
   *       network.ap: Unrecognized key(s) in object: 'dhcp'
   *     fallback: cannot read the configuration, using defaults: …same…
   *
   * Both halves matter and neither is visible from `loadConfig` alone. The
   * network was never rendered, so there was no access point; the fallback
   * watchdog — the thing that exists precisely for a device nobody can reach
   * — was running on the shipped defaults rather than on the operator's
   * settings. The board was reachable only because someone had left an
   * Ethernet cable in it. On an aircraft that is a card reader and a bench.
   *
   * So the assertions are behavioural, not textual. The fixture is the file
   * that build seeded, byte for byte, with two values changed away from the
   * defaults — the SSID and the fallback timeout — so that "the renderer and
   * the watchdog got *this* document" is provable rather than inferred from a
   * log line that happens not to appear.
   */
  it("renders and arms the fallback from a configuration an earlier version wrote", async () => {
    let journal = "";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      journal += String(chunk);
      return true;
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const { clock, advance, runner, raised } = watchdogHarness();
      const onTheCard = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "..", "config", "fixtures", "config-0.1.0-with-dhcp.yaml"),
        "utf8",
      ).replace("ssid: yonder", "ssid: yonder-field").replace("timeout: 90", "timeout: 300");
      writeFileSync(configPath, onTheCard);

      const rendered: string[] = [];
      const watcher: Renderer = {
        name: "watch",
        async render(c) { rendered.push(c.network.ap.ssid); },
      };

      const server = await startServer({ socketPath, configPath, journalPath, renderers: [watcher], secretsPath: join(dir, "secrets.yaml"), runner, clock });
      try {
        // The start-up render ran, and against the operator's configuration.
        // This is the line that used to read "could not render the current
        // configuration, serving anyway".
        expect(rendered).toEqual(["yonder-field"]);
        expect(journal).not.toContain("could not render the current configuration");

        // And the fallback is armed on the operator's 300 s, not the 90 s a
        // watchdog handed DEFAULT_CONFIG would have used. Nothing textual
        // here: at 91 s a defaulted watchdog has already fired.
        expect(journal).not.toContain("fallback: cannot read the configuration");
        advance(91_000);
        await flushMicrotasks();
        expect(raised()).toBe(0);
        advance(210_000);
        await flushMicrotasks();
        expect(raised()).toBe(1);

        // Loud, and reachable: the console gets the configuration rather than
        // the 400 that a device in this state used to answer with.
        expect(journal).toContain("network.ap.dhcp");
        expect(journal).toContain("no longer used by Yonder");
        const res = await call(socketPath, "GET", "/config");
        expect(res.status).toBe(200);
        expect((res.body as Config).network.ap.ssid).toBe("yonder-field");
      } finally {
        await server.close();
      }

      // Booting did not edit the operator's file. The retired key is still
      // there, ignored, until something saves the configuration.
      expect(readFileSync(configPath, "utf8")).toBe(onTheCard);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  /**
   * R-NET-07 and R-CFG-08 on the boot that broke them.
   *
   * A real Raspberry Pi 4 printed `wlan0:wifi:unavailable:` moments before
   * `yonder-core` would have rendered. The start-up render is the only thing
   * that writes the `yonder-ap` profile, and the fallback watchdog's only
   * action is to raise that profile — so a daemon that renders once against a
   * radio NetworkManager has not finished with, and never looks again, comes
   * up with no access point and no way to recover one.
   *
   * This is the wiring, not the class: `waitForRadio()` could behave
   * perfectly and the daemon could still never call it. The observables are
   * the argv the daemon issued and whether nmcli accepted it.
   *
   * The fake answers `device status` from the **fake clock**, not from a call
   * counter, so "the radio becomes usable at t" is exactly what the test
   * says rather than something recovered from how many times the daemon
   * happened to ask. It also refuses the two activations a real
   * NetworkManager refuses — a profile that does not exist, and a radio that
   * is not ready — because a fake that says yes to both is a fake in which
   * this defect cannot be reproduced at all.
   */
  const COLD_BOOT = "lo:loopback:connected (externally):lo\neth0:ethernet:unavailable:\nwlan0:wifi:unavailable:\n";
  const RADIO_READY = "lo:loopback:connected (externally):lo\neth0:ethernet:unavailable:\nwlan0:wifi:disconnected:\n";
  const NO_RADIO_YET = "lo:loopback:connected (externally):lo\neth0:ethernet:unavailable:\n";

  const AP_UP = "nmcli connection up yonder-ap";

  function coldBootHarness(deviceStatusAt: (now: number) => string) {
    const { clock, advance } = fakeClock();
    const calls: string[][] = [];
    const names = new Set<string>();
    let current = "";
    let activated = 0;
    const runner: CommandRunner = async (argv) => {
      calls.push(argv);
      const key = argv.join(" ");
      if (key === "nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status") {
        current = deviceStatusAt(clock.now());
        return { code: 0, stdout: current, stderr: "" };
      }
      if (key === "nmcli -t -f NAME,UUID,TYPE,DEVICE connection show") {
        return { code: 0, stdout: [...names].map((n) => `${n}:u-${n}:802-11-wireless:\n`).join(""), stderr: "" };
      }
      if (argv[1] === "connection") {
        if (argv[2] === "add") names.add(argv[4] ?? "");
        if (argv[2] === "delete") names.delete(argv[3] ?? "");
        if (argv[2] === "up") {
          const name = argv[3] ?? "";
          // The failure the fallback logs on a board whose render never got
          // far enough to write the profile.
          if (!names.has(name)) {
            return { code: 10, stdout: "", stderr: `Error: unknown connection '${name}'.` };
          }
          const wifiRow = current.split("\n").map((l) => l.split(":")).find((f) => f[1] === "wifi");
          if (name === "yonder-ap" && wifiRow?.[2] === "unavailable") {
            return { code: 4, stdout: "", stderr: "Error: Connection activation failed: device is not ready" };
          }
          if (name === "yonder-ap") activated++;
        }
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return {
      clock, advance, calls, names, runner,
      /** Activations nmcli accepted — not commands issued. On a cold boot those come apart, which is the whole defect. */
      raised: () => activated,
      /** Activations nmcli refused. Must stay at zero: each one is a line in the journal that says nothing useful. */
      refused: () => calls.filter((c) => c.join(" ") === AP_UP).length - activated,
    };
  }

  /** Quiet the daemon's own stdout/stderr for a test that expects both. */
  function muted() {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    return () => { stdout.mockRestore(); stderr.mockRestore(); };
  }

  it("raises the access point when the radio only becomes usable after the socket binds", async () => {
    const unmute = muted();
    try {
      const { clock, advance, names, runner, raised, refused } =
        coldBootHarness((now) => (now < 1_000 ? COLD_BOOT : RADIO_READY));
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner, clock });
      try {
        await flushMicrotasks();
        // The socket is up regardless: reaching a board to ask what is wrong
        // never waits on a radio.
        expect(statSync(socketPath).isSocket()).toBe(true);
        expect((await call(socketPath, "GET", "/status")).status).toBe(200);
        // nmcli refused the start-up activation, exactly as it does on a radio
        // that is not ready. Nothing is on the air.
        expect(raised()).toBe(0);

        advance(1_000);
        await flushMicrotasks();

        expect(names.has("yonder-ap")).toBe(true);
        expect(raised()).toBe(1);
        expect(refused()).toBe(1); // the start-up attempt, and only that one
      } finally {
        await server.close();
      }
    } finally {
      unmute();
    }
  });

  it("creates the access-point profile when the radio is not even listed at the first render", async () => {
    const unmute = muted();
    try {
      const { clock, advance, names, runner, raised } =
        coldBootHarness((now) => (now < 1_000 ? NO_RADIO_YET : RADIO_READY));
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner, clock });
      try {
        await flushMicrotasks();
        // The render found no wifi interface, so it wrote no yonder-ap at all
        // — and `up yonder-ap` is the only thing the fallback knows how to do.
        expect(names.has("yonder-ap")).toBe(false);

        advance(1_000);
        await flushMicrotasks();

        expect(names.has("yonder-ap")).toBe(true);
        expect(raised()).toBe(1);
      } finally {
        await server.close();
      }
    } finally {
      unmute();
    }
  });

  /**
   * The interaction between the wait above and R-NET-07's deadline, in the
   * one arrangement where they genuinely collide: `network.ap.fallback.timeout`
   * at its schema minimum of 30 s, which is also where the radio wait's own
   * bound lands, on a board whose radio is not listed until that very moment.
   *
   * The deadline is not moved — that is the guarantee. What must not happen is
   * the fallback's *action* running while the render that creates the profile
   * is still in flight: `nmcli connection up yonder-ap` against a profile that
   * does not exist fails with `unknown connection`, which tells an operator
   * nothing about a radio that was simply slow. So the observable is that
   * every activation this daemon issued was one nmcli could accept.
   */
  it("does not raise the access point before the render that creates it", async () => {
    const unmute = muted();
    try {
      const soon = structuredClone(DEFAULT_CONFIG);
      soon.network.ap.fallback.timeout = 30;
      saveConfig(configPath, soon);

      const { clock, advance, names, runner, raised, refused } =
        coldBootHarness((now) => (now < 30_000 ? NO_RADIO_YET : RADIO_READY));
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner, clock });
      try {
        // Walk to the deadline one poll at a time, the way the daemon
        // actually experiences it.
        for (let i = 0; i < 31; i++) {
          advance(1_000);
          await flushMicrotasks();
        }
        expect(names.has("yonder-ap")).toBe(true);
        expect(raised()).toBeGreaterThanOrEqual(1);
        expect(refused()).toBe(0);
      } finally {
        await server.close();
      }
    } finally {
      unmute();
    }
  });

  /**
   * The radio wait is the second timer this daemon owns, and `close()` stops
   * it for the same reason it stops the watchdog. Deleting
   * `built?.renderer.cancelRadioWait()` survived the suite: nothing asked
   * what the poll loop did after the daemon it belongs to had gone.
   *
   * It does not merely keep asking NetworkManager questions. A wait that
   * succeeds calls `engine.renderCurrent()`, so a loop outliving its daemon
   * reconfigures a radio nobody is managing any more — on a board where the
   * next process may already be managing it — and does so through a daemon
   * whose socket is unlinked, where nothing can see it happen or stop it.
   */
  it("stops the radio wait when the server closes", async () => {
    const unmute = muted();
    try {
      const { clock, advance, calls, names, runner, raised } =
        coldBootHarness((now) => (now < 5_000 ? NO_RADIO_YET : RADIO_READY));
      const server = await startServer({ socketPath, configPath, journalPath, renderers: [noopRenderer], secretsPath: join(dir, "secrets.yaml"), runner, clock });
      await flushMicrotasks();
      // The wait is running: no radio was listed, so no profile was written
      // and the wait is what would eventually write one.
      expect(names.has("yonder-ap")).toBe(false);

      await server.close();
      await flushMicrotasks();
      const issued = calls.length;

      // The radio appears, well inside the wait's own 30 s bound — so a loop
      // that was not cancelled is still there to see it.
      advance(10_000);
      await flushMicrotasks();

      expect(calls.length).toBe(issued);
      expect(names.has("yonder-ap")).toBe(false);
      expect(raised()).toBe(0);
    } finally {
      unmute();
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
