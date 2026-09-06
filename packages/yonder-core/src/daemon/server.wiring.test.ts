// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers, consolePathsFromEnv, mavlinkFromEnv, startServer, SIGNAL_POLL_SECONDS } from "./server.js";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential, ADMIN_PASSWORD_SECRET } from "../console/credential.js";
import { hashPassword } from "../console/password.js";
import type { Clock, Renderer } from "../apply/types.js";
import { FAILURES_TO_STAND_DOWN, REACH_TICK_MS } from "../net/reach/standing.js";
import { PROBE_ADDRESSES } from "../net/reach/probe.js";
import type { CounterReader } from "../net/reach/counters.js";
import { createSocket } from "node:dgram";
import { heartbeatV2 } from "../mav/testing.js";
import type { MavlinkStateBody } from "./routes.js";
import type { OpenPort } from "../mav/detect.js";
import { SETTLE_MS } from "../mav/serial.js";

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
  AP_CONNECTION, ETHERNET_CONNECTION, MODEM_CONNECTION, DEFAULT_AP_PASSPHRASE, STOOD_DOWN_METRIC, metricFor,
} from "../net/profiles.js";
import { loadConfig } from "../config/load.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { CommandRunner } from "../net/runner.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-wire-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });


/**
 * The telemetry fixtures. **No test opens a serial port**, so the opener
 * throws; `MavlinkRenderer` treats a device that will not open as R-MAV-13's
 * silence for that device and carries on, which is what a board with nothing
 * plugged into it does too.
 */
const neverOpens: OpenPort = async () => { throw new Error("no test opens a serial port"); };

/** A vehicle's heartbeat: ArduPilot on a fixed wing, system 1. */
const HEARTBEAT = heartbeatV2(1, 1, 3);

/**
 * A UDP port on loopback that was free a moment ago.
 *
 * The listener's own tests bind `0` and read back what they got; a daemon
 * gives no such handle back, so a test that wants to send it a datagram has
 * to choose the number first. Asking the kernel for an ephemeral one and
 * letting it go is how that number is chosen rather than picked.
 */
async function freePort(): Promise<number> {
  const probe = createSocket({ type: "udp4" });
  const port = await new Promise<number>((resolve) => {
    probe.bind({ address: "127.0.0.1", port: 0 }, () => { resolve(probe.address().port); });
  });
  await new Promise<void>((resolve) => { probe.close(() => { resolve(); }); });
  return port;
}

/** One datagram, from a socket of the test's own, to a port on loopback. */
async function sendTo(port: number, bytes: Uint8Array): Promise<void> {
  const from = createSocket({ type: "udp4" });
  await new Promise<void>((resolve, reject) => {
    from.send(Buffer.from(bytes), port, "127.0.0.1", (error) => {
      if (error === null) resolve(); else reject(error);
    });
  });
  from.close();
}

/**
 * Read until the answer settles, **without consulting the wall clock**:
 * `setImmediate` spends a turn of the event loop, which is where a loopback
 * datagram is delivered, so this counts turns rather than milliseconds and
 * cannot be made to pass or fail by how fast the machine running it is.
 */
async function eventually<T>(read: () => Promise<T>, settled: (value: T) => boolean): Promise<T> {
  let last = await read();
  for (let turn = 0; turn < 100 && !settled(last); turn += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    last = await read();
  }
  return last;
}

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
  /**
   * Last, and behind the console: telemetry rides on a network that has
   * already settled, and this is the renderer that can spend longest — a full
   * sweep is four speeds on each of two devices.
   */
  it("puts the telemetry renderer last, when it is given a way to open a serial port", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      console: { settings: join(dir, "console", "settings.js") },
      mavlink: {
        open: async () => { throw new Error("no test opens a serial port"); },
        confPath: join(dir, "mavlink", "main.conf"),
        hintPath: join(dir, "mavlink-link.json"),
      },
    });
    expect(built.renderers.map((r) => r.name)).toEqual(["hostname", "network", "remote", "console", "mavlink"]);
    expect(built.mavlinkRenderer).toBeDefined();
  });

  /**
   * And when it is not, the operator has to be told. `detect()` needs an
   * `OpenPort`; `mav/serial.ts` implements one against real hardware and
   * `main()` passes it, so anything reaching this branch is a caller that
   * supplied none — a test, or a new construction site that forgot.
   * Configuring no telemetry silently means an apply that sets three ground
   * stations succeeds, writes no main.conf, starts no router, and says
   * nothing anywhere about why the Telemetry page is empty.
   */
  it("says so when it has no way to configure telemetry at all", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const said: string[] = [];
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      log: (line) => { said.push(line); },
    });
    expect(built.mavlinkRenderer).toBeUndefined();
    expect(said.join("\n")).toMatch(/telemetry is not configured on this device/);
    expect(said.join("\n")).toMatch(/serial port/);
  });

  it("says nothing of the sort when telemetry is configured", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const said: string[] = [];
    buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      log: (line) => { said.push(line); },
      mavlink: {
        open: async () => { throw new Error("no test opens a serial port"); },
        confPath: join(dir, "mavlink", "main.conf"),
        hintPath: join(dir, "mavlink-link.json"),
      },
    });
    expect(said.join("\n")).not.toMatch(/telemetry is not configured/);
  });


  /**
   * R-MAV-05's other end. The generated router configuration always emits
   * `[UdpEndpoint yonder]` at `LOOPBACK_PORT`; this is the socket that reads
   * it. Assembled only alongside the renderer, because without one no
   * main.conf is written and no router is started, so nothing anywhere sends
   * to that port — a socket held for a feed that cannot exist.
   */
  it("produces a loopback listener exactly when it produces a telemetry renderer", () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const without = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
    });
    expect(without.mavlinkListener).toBeUndefined();

    const withOne = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      mavlink: {
        open: neverOpens,
        confPath: join(dir, "mavlink", "main.conf"),
        hintPath: join(dir, "mavlink-link.json"),
        loopbackPort: 0,
      },
    });
    expect(withOne.mavlinkListener).toBeDefined();
  });

  /**
   * **One tracker, two writers**, asserted by making one of them write.
   *
   * The renderer supplies the sweep's outcome and the router's counters; the
   * listener supplies heartbeats off the loopback copy. If they held trackers
   * of their own, `GET /mav/state` would have to stitch two halves together —
   * and a heartbeat sent here would reach a state object nothing serves.
   * Rather than compare object identity, this sends a real datagram and reads
   * the answer out of the *renderer*.
   */
  it("gives the listener and the telemetry renderer the same link tracker", async () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
      mavlink: {
        open: neverOpens,
        confPath: join(dir, "mavlink", "main.conf"),
        hintPath: join(dir, "mavlink-link.json"),
        loopbackPort: 0,
      },
    });
    const listener = built.mavlinkListener;
    const renderer = built.mavlinkRenderer;
    expect(listener).toBeDefined();
    expect(renderer).toBeDefined();
    if (listener === undefined || renderer === undefined) return;

    await listener.start();
    try {
      // R-MAV-07, at the one place production actually binds it.
      expect(listener.bound?.address).toBe("127.0.0.1");
      await sendTo(listener.bound?.port ?? 0, HEARTBEAT);
      const state = await eventually(
        async () => Promise.resolve(renderer.state()),
        (s) => s.lastHeardMs !== null,
      );
      expect(state.lastHeardMs).not.toBeNull();
    } finally {
      listener.close();
      renderer.close();
    }
  });

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

describe("mavlinkFromEnv", () => {
  /**
   * **This block is what makes telemetry happen at all.** Before it, every
   * caller of `buildRenderers` passed no `mavlink`, so a real board assembled
   * no `MavlinkRenderer`, answered 503 on every `/mav/*` route and started no
   * router. `main()` cannot be called from a test, so the values it decides
   * are asserted here instead — the same reason `consolePathsFromEnv` exists.
   */
  it("names the installed router configuration and puts the hint beside the journal", () => {
    const { confPath, hintPath } = mavlinkFromEnv(async () => ({ code: 0, stdout: "", stderr: "" }), {});
    expect(confPath).toBe("/etc/mavlink-router/main.conf");
    expect(hintPath).toBe("/var/lib/yonder/mavlink-link.json");
  });

  it("keeps the hint with the journal when the state directory is moved", () => {
    // One variable for the daemon's state, so a board running out of an
    // alternate directory does not leave the hint behind in /var/lib/yonder,
    // where nothing would ever read it and every boot would sweep afresh.
    const { hintPath } = mavlinkFromEnv(
      async () => ({ code: 0, stdout: "", stderr: "" }),
      { YONDER_JOURNAL: "/srv/yonder/apply.json" },
    );
    expect(hintPath).toBe("/srv/yonder/mavlink-link.json");
  });

  it("hands back an opener that runs stty through the runner it was given", async () => {
    // The ADR-0006 seam, asserted where it is actually established: the
    // opener `main()` builds shells out only through the injected runner, so
    // a test that hands it a fake reaches no real `stty` and no real /dev.
    const calls: string[][] = [];
    const { open } = mavlinkFromEnv(async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; }, {});
    // A path that is not there: the opener fails before it ever runs the
    // command, which is itself the assertion that nothing here touches /dev.
    await expect(open(join(dir, "ttyNOPE"), 115200)).rejects.toThrow(/ENOENT/);
    expect(calls).toEqual([]);
  });

  /**
   * **The clock and the journal reach the opener too, or nothing can test it.**
   *
   * `openPortWith` settles for 50 ms and polls every 10 ms *on an injected
   * clock*, and it has one thing to say — a flush that hit its bound, which
   * means bytes from the previous speed surviving into this speed's window.
   * With no way through this function, the first test that wires the
   * production opener up sleeps on real time and hears none of that. `main()`
   * passes the daemon's own.
   */
  it("passes the clock and the journal down to the opener it builds", async () => {
    const waits: number[] = [];
    const said: string[] = [];
    const clock: Clock = {
      now: () => 0,
      setTimer: (ms, fn) => { waits.push(ms); queueMicrotask(fn); return waits.length; },
      clearTimer: () => {},
    };
    const path = join(dir, "ttyFAKE0");
    // More than the flush's 64 x 8 KiB bound, so the one line the opener has
    // to say is actually said and the journal seam is proven, not assumed.
    writeFileSync(path, "x".repeat(600 * 1024));

    const { open } = mavlinkFromEnv(
      async () => ({ code: 0, stdout: "", stderr: "" }),
      {},
      { clock, log: (line) => { said.push(line); } },
    );
    const port = await open(path, 115200);
    await port.settleAndFlush();
    await port.close();

    // The settle came off this clock and not the wall clock.
    expect(waits[0]).toBe(SETTLE_MS);
    expect(said.join("\n")).toMatch(/would not go quiet/);
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
   * R-CEL-13, at the socket rather than in the unit that decides it.
   *
   * The daemon used to remember the modem's net port for the life of the
   * process, so a board whose modem had been unplugged went on being handed
   * `wwan0` — a name NetworkManager never reports — and `/reach/state` kept
   * serving a cellular path standing by on hardware that was gone. A console
   * reading that path drew a ready lamp over the words "No modem found".
   *
   * This is here as well as in netport.test.ts because the defect was in the
   * *wiring*: the unit can be right while the daemon holds the answer.
   */
  it("stops reporting a cellular path once the modem is unplugged", async () => {
    let plugged = true;
    const seen: string[][] = [];
    const withModem = boardRunner(seen);
    const unpluggable: CommandRunner = async (argv) => {
      if (plugged) return withModem(argv);
      seen.push(argv);
      // Both tools agree the modem has gone: ModemManager claims none, and
      // NetworkManager lists no `gsm` device. `wwan0` can then only come from
      // something the daemon is remembering.
      if (argv[0] === "mmcli" && argv[1] === "-L") {
        return { code: 0, stdout: "modem-list.length   : 0\n", stderr: "" };
      }
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
        return { code: 0, stdout: "eth0:ethernet:connected:yonder-eth\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    saveConfig(configPath, {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        modem: { ...DEFAULT_CONFIG.network.modem, enabled: true, mode: "auto", apn: "ereseller" },
      },
    });
    const server = await startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: unpluggable, counters: noCounters,
    });
    try {
      const modemPath = async () => {
        const res = await call(socketPath, "GET", "/reach/state");
        const state = res.body as { paths: { path: string; device: string | null; standing: string }[] };
        return state.paths.find((p) => p.path === "modem");
      };

      // The net port, not the control port NetworkManager binds: probing
      // cdc-wdm0 fails on a working link and stands the modem down.
      expect(await modemPath()).toMatchObject({ device: "wwan0", standing: "standing-by" });

      plugged = false;
      // No interface, so nothing to probe and nothing to stand down — the
      // path is absent, which is what the board is.
      expect(await modemPath()).toMatchObject({ device: null, standing: "absent" });
    } finally {
      await server.close();
    }
  });

  /**
   * Rule 6, asserted rather than reasoned about. Forgetting the modem must not
   * make the board less likely to raise its access point: `carrying` is a
   * question about paths *holding addresses*, and a departed modem holds none
   * either way — so the answer cannot move in the direction that leaves an
   * unreachable aircraft unreachable.
   */
  it("still answers that something is carrying traffic once the modem has gone", async () => {
    const seen: string[][] = [];
    const gone: CommandRunner = async (argv) => {
      seen.push(argv);
      if (argv[0] === "mmcli" && argv[1] === "-L") {
        return { code: 0, stdout: "modem-list.length   : 0\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const server = await startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: gone, counters: noCounters,
    });
    try {
      const res = await call(socketPath, "GET", "/reach/state");
      expect((res.body as { carrying: boolean }).carrying).toBe(true);
    } finally {
      await server.close();
    }
  });

  /**
   * The defect, at the socket, on the board it was found on (R-NET-14).
   *
   * `eth0` in `unavailable`: no carrier, no address, nothing plugged into it.
   * What `GET /reach/state` answered was
   *
   *     "standing":"standing-by","evidence":"untested",
   *     "detail":"Up, and not yet tested — nothing has established that it
   *               reaches anything"
   *
   * — a sentence asserting a state the daemon had not established, about an
   * interface whose condition it could read directly from the device list it
   * had already fetched.
   */
  it("does not say a port with no cable in it is up", async () => {
    const seen: string[][] = [];
    const unplugged: CommandRunner = async (argv) => {
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
        seen.push(argv);
        return { code: 0, stdout: "eth0:ethernet:unavailable:\n", stderr: "" };
      }
      return boardRunner(seen)(argv);
    };
    const server = await startServer({
      socketPath, configPath, journalPath,
      renderers: [noop], secretsPath, runner: unplugged, counters: noCounters,
    });
    try {
      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { paths: { path: string; device: string | null; standing: string; detail: string }[] };
      const ethernet = state.paths.find((p) => p.path === "ethernet");
      expect(ethernet?.standing).toBe("down");
      expect(ethernet?.detail).not.toMatch(/\bUp\b/);
      // And still not `absent`: the port is on the board. The three
      // conditions are three.
      expect(ethernet?.device).toBe("eth0");
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
    // `remoteStatePath` is required and was missing here: test files are
    // excluded from tsconfig.json and vitest does not typecheck, so the call
    // ran with `undefined` for a path the remote renderer records into.
    const built = buildRenderers({
      secretsPath: join(dir, "secrets.yaml"),
      runner: run,
      remoteStatePath: join(dir, "remote.json"),
    });
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
 * ever, and the K-42 board still unreachable — which is precisely the class
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
    // K-42 end to end, through the socket: a link with an address, a route
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

  /**
   * **A re-dial is a link coming up, and it must be tested** (R-CEL-09).
   *
   * The wire from the renderer, which is the only component that knows a
   * re-dial happened, to the watch that tests. Measured on the board: the
   * APN was changed to a wrong one, the modem re-dialled correctly onto a
   * new bearer and a new address, `curl --interface wwan0` came back exit 28
   * — and no `testing cellular` line was ever written, because the interface
   * name did not change and cellular was not the path carrying traffic.
   *
   * The board here is that one: ethernet in use, a modem standing by, and a
   * profile dialled on an APN the configuration no longer asks for. The
   * start-up render finds the difference and cycles the link.
   */
  function twoPathRunner(seen: string[][], dialled: string): CommandRunner {
    const names = new Set<string>([ETHERNET_CONNECTION, MODEM_CONNECTION]);
    return async (argv): Promise<CommandResult> => {
      seen.push(argv);
      // Ethernet works and the modem does not — the board in §2, one layer
      // up. Ethernet reaching something is what keeps the alternatives loop
      // out of this: any `curl` on wwan0 below is there because of a re-dial
      // and for no other reason.
      if (argv[0] === "curl") {
        return { code: argv.includes("wwan0") ? 7 : 0, stdout: "", stderr: "" };
      }
      if (argv[0] === "mmcli" && argv[1] === "-L") return { code: 0, stdout: fixture("modem-list.txt"), stderr: "" };
      if (argv[0] === "mmcli" && argv[1] === "-m") return { code: 0, stdout: fixture("modem-show.txt"), stderr: "" };
      if (argv[0] === "nmcli" && argv.includes("NAME,UUID,TYPE,DEVICE")) {
        return { code: 0, stdout: [...names].map((n) => `${n}:u-${n}:gsm:cdc-wdm0\n`).join(""), stderr: "" };
      }
      if (argv[0] === "nmcli" && argv[1] === "connection" && argv[2] === "add") names.add(argv[4]!);
      if (argv[0] === "nmcli" && argv[1] === "connection" && argv[2] === "delete") names.delete(argv[3]!);
      // What the modem is *already dialled on*, which is the one reading the
      // renderer's comparison rests on.
      if (argv[0] === "nmcli" && argv[1] === "-t" && argv[5] === "show" && argv[6] === MODEM_CONNECTION) {
        return { code: 0, stdout: `gsm.apn:${dialled}\n`, stderr: "" };
      }
      if (argv[0] === "nmcli" && argv.includes("device") && argv.includes("status")) {
        return {
          code: 0,
          stdout: `eth0:ethernet:connected:${ETHERNET_CONNECTION}\ncdc-wdm0:gsm:connected:${MODEM_CONNECTION}\n`,
          stderr: "",
        };
      }
      if (argv[0] === "nmcli" && argv.some((a) => a.includes("IP4.ADDRESS"))) {
        return {
          code: 0,
          stdout: "GENERAL.DEVICE:eth0\nIP4.ADDRESS[1]:192.168.1.20/24\n"
            + "GENERAL.DEVICE:wwan0\nIP4.ADDRESS[1]:10.230.244.138/30\n",
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  /** Which interfaces `curl` was pointed at, in order. */
  const probedInterfaces = (seen: string[][]): string[] =>
    seen.filter((a) => a[0] === "curl").map((a) => a[a.indexOf("--interface") + 1]!);

  it("tests a re-dialled modem that is standing by rather than in use", async () => {
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      // Dialled on one APN, configured for another: the start-up render
      // cycles the link, and that is the event nothing could see before.
      runner: twoPathRunner(seen, "ereseller"), clock: hand.clock, counters: noCounters,
    });
    try {
      expect(seen.some((a) => a[1] === "connection" && a[2] === "up" && a[3] === MODEM_CONNECTION))
        .toBe(true);
      await hand.advance(REACH_TICK_MS);
      // The net port, which is where a modem's bytes go — and the path that
      // is *not* carrying traffic, which is the whole of the defect.
      expect(probedInterfaces(seen)).toContain("wwan0");

      const res = await call(socketPath, "GET", "/reach/state");
      const state = res.body as { inUse: string; paths: { path: string; detail: string }[] };
      expect(state.inUse).toBe("ethernet");
      expect(state.paths.find((p) => p.path === "modem")?.detail).not.toMatch(/ready/i);
    } finally {
      await server.close();
    }
  });

  it("tests nothing extra when the render re-dialled nothing", async () => {
    // The same board with the modem already dialled on what the
    // configuration asks for. Ethernet is tested because it has just started
    // carrying traffic; the modem is not tested at all.
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: twoPathRunner(seen, "nxtgenphone"), clock: hand.clock, counters: noCounters,
    });
    try {
      expect(seen.some((a) => a[1] === "connection" && a[2] === "up" && a[3] === MODEM_CONNECTION))
        .toBe(false);
      await hand.advance(REACH_TICK_MS);
      expect(probedInterfaces(seen)).not.toContain("wwan0");
    } finally {
      await server.close();
    }
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

  /**
   * `POST /reach/test`, at the socket — the wiring `testPath` exists for.
   * This is not a unit test of the route handler, which would pass with
   * `testPath` left disconnected in `server.ts`: it asserts that asking
   * through the socket reaches the injected probe on the modem's own
   * device, the same way the automatic loop above does.
   */
  it("reaches the injected probe for an operator-requested test of the modem", async () => {
    withModem();
    const seen: string[][] = [];
    const hand = handClock();
    const server = await startServer({
      socketPath, configPath, journalPath, renderers: [noop], secretsPath,
      runner: deadModemRunner(seen, () => true), clock: hand.clock, counters: noCounters,
    });
    try {
      const res = await call(socketPath, "POST", "/reach/test", { path: "modem" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ path: "modem", reached: true });
      // The net port, not the control port — see the automatic-probe test
      // above for why that distinction is the one that matters here.
      expect(probedInterfaces(seen)).toContain("wwan0");
    } finally {
      await server.close();
    }
  });
});

/**
 * The whole telemetry path, at the socket: a datagram on the loopback feed,
 * through the listener, into the one `LinkTracker`, out of the renderer and
 * onto `GET /mav/state` over the Unix socket the console talks to.
 *
 * Task 10 left this untestable — `buildRenderers` needed an `OpenPort` and no
 * test could hand it one usefully — and it is the assertion that says the
 * pieces are joined rather than merely present.
 */
describe("the daemon serves the telemetry it measures", () => {
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

  /** Every command answers, and none of them is real. */
  const quiet: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });

  async function serveTelemetry(loopbackPort: number): Promise<{ close(): Promise<void> }> {
    return startServer({
      socketPath, configPath, journalPath, secretsPath,
      renderers: [noop], runner: quiet, counters: noCounters,
      mavlink: {
        open: neverOpens,
        confPath: join(dir, "mavlink", "main.conf"),
        hintPath: join(dir, "mavlink-link.json"),
        loopbackPort,
      },
    });
  }

  it("carries a heartbeat off the loopback feed all the way to GET /mav/state", async () => {
    const port = await freePort();
    const server = await serveTelemetry(port);
    try {
      await sendTo(port, HEARTBEAT);
      const res = await eventually(
        async () => call(socketPath, "GET", "/mav/state"),
        (r) => (r.body as MavlinkStateBody | undefined)?.link.lastHeardMs != null,
      );
      expect(res.status).toBe(200);
      const body = res.body as MavlinkStateBody;
      expect(body.link.lastHeardMs).not.toBeNull();
      // R-MAV-10's other half, and the field a flat body would have dropped.
      expect(typeof body.telemetryRunning).toBe("boolean");
    } finally {
      await server.close();
    }
  });

  it("serves the path check beside it (R-DIA-04)", async () => {
    const port = await freePort();
    const server = await serveTelemetry(port);
    try {
      const res = await call(socketPath, "GET", "/mav/check");
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual(["autopilot", "inbound", "outbound"]);
    } finally {
      await server.close();
    }
  });

  /**
   * Rule 6, and the one thing this route must never do: a daemon that cannot
   * do telemetry at all — every device built to date — still serves, still
   * has a console, and says plainly why the Telemetry page is empty.
   */
  it("says so, and serves anyway, on a device with no way to do telemetry", async () => {
    const server = await startServer({
      socketPath, configPath, journalPath, secretsPath,
      renderers: [noop], runner: quiet, counters: noCounters,
    });
    try {
      const res = await call(socketPath, "GET", "/mav/state");
      expect(res.status).toBe(503);
      expect((await call(socketPath, "GET", "/config")).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  /**
   * A listener outliving its daemon would hold `:14559` against the next one
   * to start — which, under `Restart=always`, is a restart loop with a
   * Telemetry page that never fills in again.
   */
  it("lets go of the loopback socket when the daemon closes", async () => {
    const port = await freePort();
    const server = await serveTelemetry(port);
    await server.close();

    const after = createSocket({ type: "udp4" });
    const bound = await new Promise<boolean>((resolve) => {
      after.once("error", () => { resolve(false); });
      after.bind({ address: "127.0.0.1", port }, () => { resolve(true); });
    });
    if (bound) after.close();
    expect(bound).toBe(true);
  });
});
