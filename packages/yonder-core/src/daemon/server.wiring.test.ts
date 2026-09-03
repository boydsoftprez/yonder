// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers, consolePathsFromEnv, startServer, SIGNAL_POLL_SECONDS } from "./server.js";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential, ADMIN_PASSWORD_SECRET } from "../console/credential.js";
import { hashPassword } from "../console/password.js";
import type { Clock, Renderer } from "../apply/types.js";
import { FAILURES_TO_STAND_DOWN, REACH_TICK_MS } from "../net/reach/standing.js";
import { PROBE_ADDRESSES } from "../net/reach/probe.js";
import type { CounterReader } from "../net/reach/counters.js";

/**
 * The byte counters, injected — never `/sys`.
 *
 * `ReachMonitor` and `ReachWatch` both default to `readFileSync
 * ("/sys/class/net/…")`, so a `startServer` test that passes nothing is
 * asserting about whatever interfaces the machine running the suite happens
 * to have. It passed only because `wwan0` and `eth0` do not exist on the
 * hosts it has run on; on a Linux board that has one, the same test takes a
 * different branch of the watch. No test may reach a real `/sys`.
 */
const noCounters: CounterReader = () => null;

/** A link with bytes moving both ways, which is what a healthy one looks like. */
function movingCounters(): CounterReader {
  let seen = 0;
  return () => { seen += 4_000; return { rx: seen, tx: seen }; };
}
import type { CommandResult } from "../net/runner.js";
import {
  AP_CONNECTION, MODEM_CONNECTION, DEFAULT_AP_PASSPHRASE, STOOD_DOWN_METRIC, metricFor,
} from "../net/profiles.js";
import { loadConfig } from "../config/load.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { CommandRunner } from "../net/runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-wire-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("buildRenderers", () => {
  it("produces a network renderer", () => {
    saveConfig(join(dir, "config.yaml"), DEFAULT_CONFIG);
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { renderers } = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
    });
    expect(renderers.map((r) => r.name)).toEqual(["hostname", "network", "remote"]);
  });

  /**
   * Absent unless a caller says where the console is. That is what stops a
   * test — or a future call site that forgot an option — writing to
   * /opt/yonder on whatever machine it happens to run on. Production supplies
   * the paths from consolePathsFromEnv, in main().
   */
  it("produces no console renderer when nobody said where the console is", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
    });
    expect(built.consoleRenderer).toBeUndefined();
    expect(built.renderers.map((r) => r.name)).toEqual(["hostname", "network", "remote"]);
  });

  /**
   * Order is load-bearing. Renderers run in sequence, so the console goes
   * behind a network that has already settled: if the console then fails and
   * the apply rolls back, the rollback re-renders a network that was working.
   * The reverse order would let a console failure leave the access point
   * untouched by either pass, which is rule 6.
   */
  it("puts the console renderer after the network one", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      console: { settings: join(dir, "console", "settings.js") },
    });
    expect(built.renderers.map((r) => r.name)).toEqual(["hostname", "network", "remote", "console"]);
    expect(built.consoleRenderer).toBeDefined();
  });

  /**
   * In front of the network, and for the mirror image of the reason the
   * console is behind it. K-19: a failing renderer stops the ones behind it.
   * HostnameRenderer cannot fail, so nothing is put at risk by going first —
   * and a board whose NetworkManager is wedged still gets the name its
   * configuration gives it, which is the board most likely to be searched for
   * by name.
   */
  it("puts the hostname renderer in front of everything, because it cannot fail", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      console: { settings: join(dir, "console", "settings.js") },
    });
    expect(built.renderers[0]?.name).toBe("hostname");
  });
});

describe("consolePathsFromEnv", () => {
  it("uses the installed paths when the environment says nothing", () => {
    expect(consolePathsFromEnv({})).toEqual({
      settings: "/var/lib/yonder/console/settings.js",
      publicDir: "/var/lib/yonder/console/public",
      userDir: "/var/lib/yonder/console",
      socket: "/run/yonder/core.sock",
      coreTree: "/opt/yonder/packages/yonder-core",
      unit: "yonder-console.service",
    });
  });

  it("takes the socket from the same variable the daemon binds", () => {
    // One variable, so the daemon and the console cannot end up pointed at
    // two different sockets — which would be a console that can never
    // authenticate anyone and a device nobody can log in to.
    expect(consolePathsFromEnv({ YONDER_SOCKET: "/tmp/probe.sock" }).socket).toBe("/tmp/probe.sock");
  });

  it("lets the tree the console requires its wiring from be moved", () => {
    // The generated settings.js requires a module out of the daemon's own
    // installed tree, so an install with a different prefix has to be able to
    // say where that is. Same for the unit, which the renderer restarts.
    const paths = consolePathsFromEnv({
      YONDER_CONSOLE_CORE_TREE: "/srv/yonder/core",
      YONDER_CONSOLE_UNIT: "yonder-console-test.service",
    });
    expect(paths.coreTree).toBe("/srv/yonder/core");
    expect(paths.unit).toBe("yonder-console-test.service");
  });

  it("lets the settings path and userDir be moved", () => {
    const paths = consolePathsFromEnv({
      YONDER_CONSOLE_SETTINGS: "/srv/console/settings.js",
      YONDER_CONSOLE_USERDIR: "/srv/console/state",
    });
    expect(paths.settings).toBe("/srv/console/settings.js");
    expect(paths.userDir).toBe("/srv/console/state");
  });

  /**
   * ADR-0007. The passphrase used to be a random per-device value printed to
   * the journal — which only someone already on the device could read, and
   * joining this access point is how anyone gets on the device. It is now the
   * published default, identical everywhere and never called a secret.
   */
  it("seeds the access point with the published default passphrase", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, runner: run, remoteStatePath: join(dir, "remote.json"),
    });
    expect(secrets.get("ap_psk")).toBe(DEFAULT_AP_PASSPHRASE);
    expect(generated).toContain("ap_psk");
  });

  it("gives every device the same passphrase, not a random one each", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const one = buildRenderers({
      secretsPath: join(dir, "a.yaml"), runner: run, remoteStatePath: join(dir, "a-remote.json"),
    });
    const two = buildRenderers({
      secretsPath: join(dir, "b.yaml"), runner: run, remoteStatePath: join(dir, "b-remote.json"),
    });
    expect(one.secrets.get("ap_psk")).toBe(two.secrets.get("ap_psk"));
  });

  /**
   * R-SEC-09. The console's administrator password does not exist until the
   * operator sets it; a value seeded here would make the first-run setup step
   * a formality over a credential nobody chose.
   */
  it("does not seed an editor password", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, runner: run, remoteStatePath: join(dir, "remote.json"),
    });
    expect(secrets.get("editor_password")).toBeUndefined();
    expect(generated).not.toContain("editor_password");
  });

  it("does not re-seed a secret that already exists", () => {
    const secretsPath = join(dir, "secrets.yaml");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const first = buildRenderers({ secretsPath, runner: run, remoteStatePath: join(dir, "remote.json") });
    const value = first.secrets.get("ap_psk");
    const second = buildRenderers({ secretsPath, runner: run, remoteStatePath: join(dir, "remote.json") });
    expect(second.secrets.get("ap_psk")).toBe(value);
    expect(second.generated).toEqual([]);
  });

  it("keeps a passphrase the operator has changed", () => {
    const secretsPath = join(dir, "secrets.yaml");
    writeFileSync(secretsPath, "ap_psk: an-operator-chose-this\n", { mode: 0o600 });
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const { secrets, generated } = buildRenderers({
      secretsPath, runner: run, remoteStatePath: join(dir, "remote.json"),
    });
    // The published default is a starting point, never something the daemon
    // reasserts over a choice the operator has already made.
    expect(secrets.get("ap_psk")).toBe("an-operator-chose-this");
    expect(generated).toEqual([]);
  });
});

/**
 * The daemon's own wiring, over the socket.
 *
 * These exist for one reason: every layer below has its own tests, and all of
 * them keep passing if the line in `startServer` that connects one to the
 * socket is deleted. A modem this daemon can read but never serves, and a
 * reach monitor nothing asks, are both a green suite and a blank page.
 */
const FIXTURES = new URL("../net/modem/mmcli/fixtures/", import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), "utf8");
}

/** Talk to the daemon the way the console will: over the Unix socket. */
function call(socketPath: string, method: string, path: string): Promise<{ status: number; body: unknown }> {
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
    req.end();
  });
}

/**
 * A board with the measured modem on it, answered from the same fixtures the
 * mmcli client's own tests read. Nothing here reaches a real command: the
 * runner is the only way anything in this daemon shells out, and this is it.
 */
function boardRunner(seen: string[][]): CommandRunner {
  return async (argv): Promise<CommandResult> => {
    seen.push(argv);
    const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (argv[0] === "mmcli") {
      if (argv[1] === "-L") return ok(fixture("modem-list.txt"));
      if (argv[1] === "-m" && argv[2] === "/org/freedesktop/ModemManager1/Modem/0") {
        if (argv.includes("--signal-get")) return ok(fixture("signal-get.txt"));
        if (argv.some((a) => a.startsWith("--signal-setup"))) return ok("");
        return ok(fixture("modem-show.txt"));
      }
      if (argv[1] === "-b") {
        return ok(argv[2]?.endsWith("/1") === true
          ? fixture("bearer-connected.txt")
          : fixture("bearer-initial.txt"));
      }
    }
    if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
      return ok("eth0:ethernet:connected:yonder-eth\ncdc-wdm0:gsm:connected:yonder-modem\n");
    }
    return ok("");
  };
}

describe("the daemon serves what M3a assembles", () => {
  let socketPath: string, configPath: string, journalPath: string, secretsPath: string;
  const noop: Renderer = { name: "noop", async render() {} };

  beforeEach(() => {
    socketPath = join(dir, "core.sock");
    configPath = join(dir, "config.yaml");
    journalPath = join(dir, "apply.json");
    secretsPath = join(dir, "secrets.yaml");
    saveConfig(configPath, DEFAULT_CONFIG);
    new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"));
  });

  async function serve(seen: string[][]): Promise<{ close(): Promise<void> }> {
    return startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: boardRunner(seen), counters: noCounters,
    });
  }

  it("serves GET /modem/state from ModemManager", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      const res = await call(socketPath, "GET", "/modem/state");
      expect(res.status).toBe(200);
      // Read from the device, not from the configuration: the APN comes off
      // the *connected* bearer, so this is what the link is using rather than
      // what was asked for.
      expect(res.body).toMatchObject({ operator: "Dark Star", technology: "lte", apn: "ereseller" });
    } finally {
      await server.close();
    }
  });

  it("serves GET /reach/state", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      const res = await call(socketPath, "GET", "/reach/state");
      expect(res.status).toBe(200);
      const state = res.body as { paths: { path: string }[]; carrying: boolean };
      expect(state.paths.map((p) => p.path)).toContain("modem");
      // Nothing has probed anything, so nothing is stood down and the answer
      // is the safe one. See ReachMonitor.carrying.
      expect(state.carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  /**
   * R-CEL-10. Without this the modem reports only a coarse quality
   * percentage, which on the measured board read 60 and then 29 while the
   * real numbers moved three dB — so a page bound to it would show a signal
   * halving that had not.
   */
  it("arms detailed signal reporting, once, on the modem it read", async () => {
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      await call(socketPath, "GET", "/modem/state");
      await call(socketPath, "GET", "/modem/state");
      const armed = seen.filter((a) => a.some((w) => w.startsWith("--signal-setup")));
      expect(armed).toHaveLength(1);
      expect(armed[0]).toContain(`--signal-setup=${SIGNAL_POLL_SECONDS}`);
    } finally {
      await server.close();
    }
  });

  it("never lets arming signal fail a read", async () => {
    // A modem that has just appeared may not be ready, and the numbers a page
    // does get are worth more than a 500 saying it could not have more.
    const seen: string[][] = [];
    const failing: CommandRunner = async (argv) => {
      if (argv.some((a) => a.startsWith("--signal-setup"))) {
        return { code: 1, stdout: "", stderr: "error: operation not allowed" };
      }
      return boardRunner(seen)(argv);
    };
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath, runner: failing,
    });
    try {
      const res = await call(socketPath, "GET", "/modem/state");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ operator: "Dark Star" });
    } finally {
      await server.close();
    }
  });

  it("puts no credential in either record", async () => {
    // R-SEC-10, asserted at the socket rather than trusted. `gsm.password` is
    // written to a NetworkManager profile and has no field to arrive back in.
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      for (const path of ["/modem/state", "/reach/state"]) {
        const res = await call(socketPath, "GET", path);
        expect(JSON.stringify(res.body)).not.toMatch(/password|passphrase|secret/i);
      }
    } finally {
      await server.close();
    }
  });

  it("reaches no real command for any of it", async () => {
    // Every subprocess this daemon runs goes through the injected runner. A
    // test that reached a real mmcli would answer whatever the machine
    // running it happens to have plugged in.
    const seen: string[][] = [];
    const server = await serve(seen);
    try {
      await call(socketPath, "GET", "/modem/state");
      await call(socketPath, "GET", "/reach/state");
      expect(seen.some((a) => a[0] === "mmcli")).toBe(true);
      expect(seen.every((a) => ["mmcli", "nmcli", "rfkill", "hostnamectl", "curl"].includes(a[0] ?? ""))).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("buildRenderers and the modem", () => {
  /**
   * One runner, for the reason NmcliClient records about rfkill: two runners
   * that must agree can stop agreeing, and the failure mode is a test
   * reaching a real mmcli on the machine running it.
   */
  it("builds the mmcli client on the same runner as the nmcli one", async () => {
    const seen: string[][] = [];
    const run: CommandRunner = async (argv) => {
      seen.push(argv);
      return { code: 0, stdout: "modem-list.length   : 0\n", stderr: "" };
    };
    const built = buildRenderers({ secretsPath: join(dir, "secrets.yaml"), runner: run });
    expect(built.modemClient).toBeDefined();
    await built.modemClient.modems();
    expect(seen.some((a) => a[0] === "mmcli")).toBe(true);
  });
});

/**
 * The reach watch, at the socket.
 *
 * Its own tests prove it decides correctly; these prove the daemon actually
 * starts it and actually stops it. A watch that is constructed and never
 * started is a green suite, a `/reach/state` that says `standing-by` for
 * ever, and the K-40 board still unreachable — which is precisely the class
 * of defect this file exists to catch.
 */
describe("the daemon drives the reach watch", () => {
  let socketPath: string, configPath: string, journalPath: string, secretsPath: string;
  const noop: Renderer = { name: "noop", async render() {} };

  beforeEach(() => {
    socketPath = join(dir, "core.sock");
    configPath = join(dir, "config.yaml");
    journalPath = join(dir, "apply.json");
    secretsPath = join(dir, "secrets.yaml");
    saveConfig(configPath, DEFAULT_CONFIG);
    new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"));
  });

  /** A clock the test drives by hand; the same shape as the one in server.test.ts. */
  function handClock() {
    let t = 0;
    let next = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: Clock = {
      now: () => t,
      setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
      clearTimer: (h) => { timers.delete(h as number); },
    };
    return {
      clock,
      armed: () => timers.size,
      async advance(ms: number) {
        t += ms;
        for (const [h, timer] of [...timers]) if (timer.at <= t) { timers.delete(h); timer.fn(); }
        for (let i = 0; i < 200; i++) await Promise.resolve();
      },
    };
  }

  /**
   * A board with a modem holding the default route and reaching nothing: the
   * wrong APN, in a runner. `curl` on the modem's interface always fails.
   */
  function deadModemRunner(seen: string[][], reaches: () => boolean = () => false): CommandRunner {
    // The connections NetworkManager holds, remembered rather than replayed.
    // A fake that forgets what it was told cannot say whether a profile the
    // start-up render created is there to have its route metric rewritten —
    // and `remetric` deliberately writes only to connections that exist.
    const names = new Set<string>();
    return async (argv): Promise<CommandResult> => {
      seen.push(argv);
      if (argv[0] === "curl") return { code: reaches() ? 0 : 7, stdout: "", stderr: "" };
      if (argv[0] === "nmcli" && argv.includes("NAME,UUID,TYPE,DEVICE")) {
        return {
          code: 0,
          stdout: [...names].map((n) => `${n}:u-${n}:gsm:cdc-wdm0\n`).join(""),
          stderr: "",
        };
      }
      if (argv[0] === "nmcli" && argv[1] === "connection" && argv[2] === "add") names.add(argv[4]!);
      if (argv[0] === "nmcli" && argv[1] === "connection" && argv[2] === "delete") names.delete(argv[3]!);
      // The board's own two names: the connection is bound to the control
      // port, and every byte goes out of the net port (design spec, "three
      // names that are not the obvious ones").
      if (argv[0] === "mmcli" && argv[1] === "-L") return { code: 0, stdout: fixture("modem-list.txt"), stderr: "" };
      if (argv[0] === "mmcli" && argv[1] === "-m") {
        return { code: 0, stdout: fixture("modem-show.txt"), stderr: "" };
      }
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
        return { code: 0, stdout: "cdc-wdm0:gsm:connected:yonder-modem\n", stderr: "" };
      }
      if (argv[0] === "nmcli" && argv.some((a) => a.includes("IP4.ADDRESS"))) {
        return { code: 0, stdout: "GENERAL.DEVICE:wwan0\nIP4.ADDRESS[1]:10.31.95.33/30\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  /** config.yaml asking for the modem, which is what puts it on a path. */
  function withModem(): void {
    const config = structuredClone(DEFAULT_CONFIG);
    config.network.modem.enabled = true;
    config.network.modem.apn = "nxtgenphone";
    saveConfig(configPath, config);
  }

  it("probes on its own, and stands a modem that reaches nothing down", async () => {
    // K-40 end to end, through the socket: a link with an address, a route
    // and no way out, and nothing but this loop to notice.
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen), clock: hand.clock, counters: noCounters,
    });
    try {
      for (let i = 0; i < FAILURES_TO_STAND_DOWN + 1; i++) await hand.advance(REACH_TICK_MS);
      // The net port, never the control port. `curl --interface cdc-wdm0`
      // fails on a perfectly good link, and three of those would stand a
      // working modem down.
      expect(seen.filter((a) => a[0] === "curl").map((a) => a[a.indexOf("--interface") + 1]))
        .toContain("wwan0");

      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { carrying: boolean; paths: { path: string; standing: string }[] };
      expect(state.paths.find((p) => p.path === "modem")?.standing).toBe("no-route-out");
      // The answer the fallback watchdog reads. Before this loop existed it
      // was true for ever, and the board stayed unreachable.
      expect(state.carrying).toBe(false);
    } finally {
      await server.close();
    }
  });

  /**
   * The injection point itself, at the socket — and the property it makes
   * testable, which is the one the whole design rests on: a board that is
   * working spends nothing on establishing that (R-CEL-09, R-NET-13).
   *
   * With bytes moving both ways the watch tests once, when the link comes up,
   * and never again. Without a way to inject the reader these tests read the
   * host's real `/sys`, got null for every device, and could only ever
   * exercise the branch where the counters say nothing.
   */
  it("takes the byte counters it was given, and probes nothing while they move", async () => {
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen), clock: hand.clock, counters: movingCounters(),
    });
    try {
      await hand.advance(REACH_TICK_MS);
      // One probe, which is one *or more* requests: a probe tries a second
      // address before it will call a path dead, so this dead link's single
      // link-up probe costs up to PROBE_ADDRESSES.length of them. What this
      // test is about is unchanged — that nothing probes *again* while the
      // counters move.
      const afterLinkUp = seen.filter((a) => a[0] === "curl").length;
      expect(afterLinkUp).toBeGreaterThan(0);
      expect(afterLinkUp).toBeLessThanOrEqual(PROBE_ADDRESSES.length);
      for (let i = 0; i < FAILURES_TO_STAND_DOWN + 2; i++) await hand.advance(REACH_TICK_MS);
      expect(seen.filter((a) => a[0] === "curl").length).toBe(afterLinkUp);

      // Traffic in both directions is evidence, and it costs nothing: the
      // modem is not stood down, and the watchdog's question answers true.
      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { carrying: boolean; paths: { path: string; standing: string }[] };
      expect(state.paths.find((p) => p.path === "modem")?.standing).not.toBe("no-route-out");
      expect(state.carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("moves traffic off the path it stood down, and puts it back when it returns", async () => {
    // R-NET-13's second half, at the socket. `Standing` worked out that the
    // modem reached nothing long before anything acted on it: the path kept
    // its winning route metric and the default route indefinitely while the
    // log line said traffic had moved. This is the assertion that would have
    // caught that absence.
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    let reaches = false;
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen, () => reaches), clock: hand.clock, counters: noCounters,
    });
    try {
      const metricsWritten = (): number[] =>
        seen
          .filter((a) => a[1] === "connection" && a[2] === "modify" && a[3] === MODEM_CONNECTION)
          .map((a) => Number(a[a.indexOf("ipv4.route-metric") + 1]));

      // Nothing has been stood down yet, so nothing has been re-metricked.
      expect(metricsWritten()).toEqual([]);

      for (let i = 0; i < FAILURES_TO_STAND_DOWN + 1; i++) await hand.advance(REACH_TICK_MS);

      const configured = metricFor(loadConfig(configPath), "modem");
      expect(metricsWritten()).toEqual([configured + STOOD_DOWN_METRIC]);
      // The stored profile said one thing and the running device another
      // until this. The net port is where the bytes go, but the connection is
      // bound to the control port, and that is the device to reapply.
      expect(seen.some((a) => a.join(" ") === "nmcli device reapply cdc-wdm0")).toBe(true);
      // Nothing was taken down and the access point was not disturbed: an
      // operator may be reaching this board over the very path that failed.
      expect(seen.some((a) => a[1] === "connection" && a[2] === "down")).toBe(false);
      expect(seen.some((a) => a[1] === "connection" && a[2] === "modify" && a[3] === AP_CONNECTION))
        .toBe(false);

      // Quick to return: the APN is fixed, the probe succeeds, and the
      // configured metric comes straight back.
      reaches = true;
      await hand.advance(REACH_TICK_MS);
      expect(metricsWritten()).toEqual([configured + STOOD_DOWN_METRIC, configured]);

      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { carrying: boolean };
      expect(state.carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("stops the watch when the daemon closes", async () => {
    // A tick loop outliving its daemon would go on running curl on somebody's
    // metered link on behalf of a process that has let go of its socket.
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen), clock: hand.clock, counters: noCounters,
    });
    await hand.advance(REACH_TICK_MS);
    await server.close();
    const before = seen.length;
    await hand.advance(REACH_TICK_MS * 5);
    expect(seen.length).toBe(before);
  });

  it("spends nothing on a device that has no path in use", async () => {
    // No modem configured and no address anywhere: there is no subject to
    // test, and a tick must not manufacture one.
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: async (argv) => { seen.push(argv); return { code: 0, stdout: "", stderr: "" }; },
      clock: hand.clock, counters: noCounters,
    });
    try {
      for (let i = 0; i < 5; i++) await hand.advance(REACH_TICK_MS);
      expect(seen.some((a) => a[0] === "curl")).toBe(false);
    } finally {
      await server.close();
    }
  });
});
