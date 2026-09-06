// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CommandResult, CommandRunner } from "../net/runner.js";
import { ConfigSchema, type Config } from "../schema/config.js";
import type { OpenPort } from "./detect.js";
import { routerConfig } from "./router/config.js";
import { fakeClock, heartbeatV2, validSysStatusBytes } from "./testing.js";
import { MAVLINK_DEVICES, MavlinkRenderer, ROUTER_CONF_PATH, ROUTER_UNIT, linkFromConf } from "./renderer.js";

/**
 * Every command this renderer runs is answered by a fake, and every byte it
 * reads off a port comes from one: no test starts `mavlink-router`, reads a
 * real journal, or opens a real serial device (ADR-0006, and this milestone's
 * rule that time, processes and ports are all injected).
 */
type Reply = (argv: string[]) => CommandResult;

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };
/** What `systemctl is-active` says for a unit that is not running. */
const INACTIVE: CommandResult = { code: 3, stdout: "inactive\n", stderr: "" };
const ACTIVE: CommandResult = { code: 0, stdout: "active\n", stderr: "" };

/** `systemctl is-active` answers `state`; everything else succeeds silently. */
function serviceIs(state: "active" | "inactive", rest: Reply = () => OK): Reply {
  return (argv) => (argv[1] === "is-active" ? (state === "active" ? ACTIVE : INACTIVE) : rest(argv));
}

/**
 * A unit that remembers what was done to it: `start`/`restart` make it active
 * and `stop` makes it inactive, so a test can stop telemetry and then ask what
 * the next apply does about it. A fixed `serviceIs` cannot express that, and
 * the case it cannot express is the one where an apply put telemetry back on
 * the air by itself.
 */
function unit(start: "active" | "inactive" = "inactive", fail: (argv: string[]) => CommandResult | null = () => null) {
  let active = start === "active";
  const reply: Reply = (argv) => {
    if (argv[1] === "is-active") return active ? ACTIVE : INACTIVE;
    const refused = fail(argv);
    if (refused !== null) return refused;
    if (argv[1] === "start" || argv[1] === "restart") active = true;
    if (argv[1] === "stop") active = false;
    return OK;
  };
  return { reply, get active() { return active; } };
}

const config = (mavlink: Record<string, unknown> = {}, rest: Record<string, unknown> = {}): Config =>
  ConfigSchema.parse({
    version: 1,
    network: { ap: { psk: { secret: "ap_psk" } } },
    ui: { editor: {} },
    mavlink,
    ...rest,
  });

/** A device present on the board that never says anything. R-MAV-13's silence. */
const SILENT: Record<number, Uint8Array> = {};

/** Let every already-resolved promise in flight run to completion. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function seedConf(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const readConf = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** Every `systemctl <verb>` this renderer ran, in order. */
const systemctl = (calls: string[][]) => calls.filter((a) => a[0] === "systemctl").map((a) => a[1]);

/**
 * A renderer with fake everything and real files in a temp directory. The
 * serial table is mutable, so one test can unplug a flight controller between
 * two renders — which is the case a hint has to survive being wrong about.
 */
function harness(opts: { reply?: Reply; serial?: Record<string, Record<number, Uint8Array>> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yonder-mav-"));
  const confPath = join(dir, "etc", "main.conf");
  const hintPath = join(dir, "var", "mavlink-link.json");

  const calls: string[][] = [];
  const reply = opts.reply ?? serviceIs("inactive");
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return reply(argv);
  };

  const serial = opts.serial ?? {};
  /** Every (device, speed) the sweep asked for, whether or not it opened. */
  const opened: { device: string; baud: number }[] = [];
  const open: OpenPort = async (device, baud) => {
    opened.push({ device, baud });
    const ports = serial[device];
    // A node that is not there. The ordinary state of /dev/ttyACM0 on a board
    // with nothing plugged into it, and of /dev/ttyAMA0 before the UART role
    // has been rebooted into (Task 15).
    if (ports === undefined) throw new Error(`ENOENT: no such file or directory, open '${device}'`);
    return {
      settleAndFlush: async () => {},
      read: async () => ({ bytes: ports[baud] ?? new Uint8Array(0), framingErrors: 0 }),
      close: async () => {},
    };
  };

  const clock = fakeClock();
  const log = vi.fn();
  const make = () => new MavlinkRenderer({ run, open, confPath, hintPath, clock, log });

  return { dir, confPath, hintPath, calls, opened, serial, clock, log, make, renderer: make() };
}

const heartbeatAt = (device: string, baud: number) => ({ [device]: { [baud]: heartbeatV2(1, 1, 3) } });

describe("MavlinkRenderer — adopt, then act only on difference", () => {
  /**
   * The property the whole class exists for. The apply engine calls every
   * renderer on every apply and again when the daemon starts, so a render
   * that probed unconditionally would take the serial port off a router that
   * is already using it — dropping every ground station mid-flight for a
   * change that had nothing to do with telemetry.
   */
  it("adopts a running router whose configuration already matches, and probes nothing", async () => {
    const h = harness({ reply: serviceIs("active"), serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    const c = config();
    seedConf(h.confPath, routerConfig(c.mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));

    await h.renderer.render(c);

    expect(h.opened).toEqual([]);
    expect(systemctl(h.calls)).toEqual(["is-active"]);
  });

  it("does not restart the service when an unrelated setting changed", async () => {
    const h = harness({ reply: serviceIs("active"), serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    const before = config({}, { ui: { editor: {}, theme: "day" } });
    seedConf(h.confPath, routerConfig(before.mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));

    await h.renderer.render(before);
    await h.renderer.render(config({}, { ui: { editor: {}, theme: "night" }, system: { hostname: "elsewhere" } }));

    expect(systemctl(h.calls)).not.toContain("restart");
    expect(systemctl(h.calls)).not.toContain("start");
  });

  it("restarts only when the rendered configuration actually differs", async () => {
    const h = harness({ reply: serviceIs("active"), serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    seedConf(h.confPath, routerConfig(config().mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));
    const withStation = config({ endpoints: [{ name: "gcs0", host: "10.0.0.9", port: 14550 }] });

    await h.renderer.render(config());
    await h.renderer.render(withStation);
    await h.renderer.render(withStation);

    expect(systemctl(h.calls).filter((verb) => verb === "restart")).toHaveLength(1);
    expect(readConf(h.confPath)).toContain("Address = 10.0.0.9");
  });

  /**
   * The one route by which the port is taken from a working router — an
   * operator asking for it, with the interruption stated on the page first
   * (§4). Never a side effect of an apply.
   */
  it("re-probes on an explicit request even though a router is running", async () => {
    const h = harness({ reply: serviceIs("active"), serial: heartbeatAt("/dev/ttyAMA0", 115200) });
    const c = config();
    seedConf(h.confPath, routerConfig(c.mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));
    await h.renderer.render(c);
    expect(h.opened).toEqual([]);

    const outcome = await h.renderer.detectNow();

    expect(outcome).toMatchObject({ kind: "found", device: "/dev/ttyAMA0", baud: 115200 });
    expect(h.opened.length).toBeGreaterThan(0);
    const verbs = systemctl(h.calls).filter((v) => v === "stop" || v === "start" || v === "restart");
    expect(verbs[0]).toBe("stop");
    expect(verbs.slice(1)).toContain("start");
    // And it said so before it did it: an interruption an operator did not
    // expect is the thing R-NET-12's instinct exists to prevent.
    expect(h.log).toHaveBeenCalledWith(expect.stringMatching(/interrupt/i));
  });
});

describe("MavlinkRenderer — the boot order, because the port is contended", () => {
  it("detects before it starts the router, because they contend for the port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-mav-order-"));
    // One ordered list across both fakes, so "before" is a fact about the
    // sequence rather than two counts that happen to agree.
    const order: string[] = [];
    const renderer = new MavlinkRenderer({
      run: async (argv) => {
        order.push(`run:${argv[0]} ${argv[1]}`);
        return serviceIs("inactive")(argv);
      },
      open: async (device, baud) => {
        order.push(`open:${device}@${baud}`);
        return {
          settleAndFlush: async () => {},
          read: async () => ({ bytes: heartbeatV2(1, 1, 3), framingErrors: 0 }),
          close: async () => {},
        };
      },
      confPath: join(dir, "etc", "main.conf"),
      hintPath: join(dir, "var", "hint.json"),
      clock: fakeClock(),
    });

    await renderer.render(config());

    const started = order.indexOf("run:systemctl start");
    expect(started).toBeGreaterThan(-1);
    const opens = order.map((e, i) => [e, i] as const).filter(([e]) => e.startsWith("open:"));
    expect(opens.length).toBeGreaterThan(0);
    for (const [, index] of opens) expect(index).toBeLessThan(started);
  });

  it("writes the router's configuration with the speed detection settled on", async () => {
    const h = harness({ serial: heartbeatAt("/dev/ttyAMA0", 230400) });
    const c = config({ endpoints: [{ name: "gcs0", host: "192.168.2.10", port: 14550 }] });

    await h.renderer.render(c);

    expect(readConf(h.confPath)).toBe(routerConfig(c.mavlink, { device: "/dev/ttyAMA0", baud: 230400 }));
    expect(systemctl(h.calls)).toContain("start");
  });

  // §3: the retry is free precisely because the router is not running while
  // nothing has been found — there is no traffic to interrupt and no port
  // being held.
  it("does not start the router when nothing was found, so retrying stays free (§3)", async () => {
    const h = harness({ serial: { "/dev/ttyAMA0": SILENT } });

    await h.renderer.render(config());

    expect(systemctl(h.calls)).not.toContain("start");
    expect(systemctl(h.calls)).not.toContain("restart");
    // And nothing was written: routerConfig has no link to render.
    expect(readConf(h.confPath)).toBeNull();
    expect(h.renderer.state()).toMatchObject({ phase: "silent" });
    h.renderer.close();
  });

  it("looks again thirty seconds later, because a board is routinely powered before the aircraft", async () => {
    const h = harness({ serial: { "/dev/ttyAMA0": SILENT } });

    await h.renderer.render(config());
    expect(h.renderer.state().phase).toBe("silent");

    // The autopilot is powered up, and nobody applies anything.
    h.serial["/dev/ttyAMA0"] = { 57600: heartbeatV2(1, 1, 3) };
    h.clock.advance(30_000);
    await settle();

    expect(h.renderer.state()).toMatchObject({ phase: "linked", device: "/dev/ttyAMA0", baud: 57600 });
    expect(systemctl(h.calls)).toContain("start");
    h.renderer.close();
  });

  it("remembers a found port and speed, and forgets one that stopped answering", async () => {
    const h = harness({ serial: { "/dev/ttyAMA0": { 921600: heartbeatV2(1, 1, 3) } } });

    await h.renderer.render(config());
    expect(JSON.parse(readFileSync(h.hintPath, "utf8"))).toEqual({ device: "/dev/ttyAMA0", baud: 921600 });

    // The flight controller is unplugged. R-MAV-13: a hint that fails is
    // discarded, so replacing a flight controller heals on the next boot.
    h.serial["/dev/ttyAMA0"] = SILENT;
    await h.renderer.render(config());

    expect(existsSync(h.hintPath)).toBe(false);
    h.renderer.close();
  });

  it("tries the remembered port and speed before the sweep", async () => {
    const h = harness({ serial: { "/dev/ttyACM0": { 921600: heartbeatV2(1, 1, 3) } } });
    await h.renderer.render(config());
    expect(JSON.parse(readFileSync(h.hintPath, "utf8"))).toEqual({ device: "/dev/ttyACM0", baud: 921600 });

    // A second daemon, sharing only the hint file, as after a restart.
    h.opened.length = 0;
    await h.make().render(config());

    expect(h.opened[0]).toEqual({ device: "/dev/ttyACM0", baud: 921600 });
  });

  // R-MAV-02: a USB CDC-ACM device is as legitimate a home for an autopilot as
  // the header UART, and `device: auto` is the shipped default — so a sweep
  // that only ever looked at one node would leave that requirement unmet.
  it("sweeps the USB device too when the header UART says nothing", async () => {
    const h = harness({
      serial: { "/dev/ttyAMA0": SILENT, "/dev/ttyACM0": { 115200: heartbeatV2(1, 2, 3) } },
    });

    await h.renderer.render(config());

    expect(h.renderer.state()).toMatchObject({ phase: "linked", device: "/dev/ttyACM0", baud: 115200 });
  });

  /**
   * Task 15's post-condition says physical availability is checked after a
   * reboot, by the daemon, and reported as part of R-MAV-13's silent case
   * rather than as an install failure. A `/dev` node that is not there yet —
   * the UART overlay written but not rebooted into — must therefore read as
   * silence, not as an exception thrown out of the middle of an apply.
   */
  it("reports a device node that will not open as silence, not as a crash", async () => {
    const h = harness({ serial: {} });

    await expect(h.renderer.render(config())).resolves.toBeUndefined();

    expect(h.renderer.state().phase).toBe("silent");
    h.renderer.close();
  });

  it("skips detection entirely when the operator pinned a device and baud", async () => {
    const h = harness({ serial: heartbeatAt("/dev/ttyAMA0", 57600) });

    await h.renderer.render(config({ serial: { device: "/dev/ttyS0", baud: 115200 } }));

    expect(h.opened).toEqual([]);
    expect(readConf(h.confPath)).toContain("Device = /dev/ttyS0");
    expect(readConf(h.confPath)).toContain("Baud = 115200");
    expect(systemctl(h.calls)).toContain("start");
  });

  it("sweeps only the pinned speed when just the baud is pinned", async () => {
    const h = harness({ serial: { "/dev/ttyAMA0": { 230400: heartbeatV2(1, 1, 3) } } });

    await h.renderer.render(config({ serial: { device: "/dev/ttyAMA0", baud: 230400 } }));

    expect(h.opened).toEqual([]);
    await h.make().render(config({ serial: { device: "auto", baud: 230400 } }));
    expect(h.opened.every((o) => o.baud === 230400)).toBe(true);
  });
});

describe("MavlinkRenderer — what it says, and what it refuses to do", () => {
  // R-MAV-07. The sockets this opens bind every interface, and MAVLink is
  // bidirectional, so anything that reaches them can command the vehicle. The
  // requirement's own words are "and is logged".
  it("logs the moment ingest is opened to the network (R-MAV-07)", async () => {
    const h = harness({ serial: heartbeatAt("/dev/ttyAMA0", 57600) });

    await h.renderer.render(config({ ingest: { loopback_only: false } }));

    const said = h.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toMatch(/ingest/i);
    expect(said).toMatch(/network|off-device|every interface/i);
    expect(said).toMatch(/command/i);
  });

  it("says nothing about ingest while it is closed", async () => {
    const h = harness({ serial: heartbeatAt("/dev/ttyAMA0", 57600) });

    await h.renderer.render(config());

    expect(h.log.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/ingest/i);
  });

  // R-MAV-08's switch. `autocast: false` is "do not start telemetry by
  // itself"; R-MAV-09's runtime start is the operator's own action and
  // arrives on its own route.
  it("does not start the router at all when autocast is off (R-MAV-08, R-MAV-09)", async () => {
    const h = harness({ serial: heartbeatAt("/dev/ttyAMA0", 57600) });

    await h.renderer.render(config({ autocast: false }));

    expect(systemctl(h.calls)).not.toContain("start");
    expect(systemctl(h.calls)).not.toContain("restart");
  });

  /**
   * And the other half of it: autocast decides whether telemetry starts on
   * its own, never whether a link already carrying it is torn down. Turning
   * "start at boot" off must not be a way to drop every ground station in
   * flight.
   */
  it("never stops a router that is already running because autocast was turned off", async () => {
    const h = harness({ reply: serviceIs("active"), serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    seedConf(h.confPath, routerConfig(config().mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));

    await h.renderer.render(config({ autocast: false }));

    expect(systemctl(h.calls)).not.toContain("stop");
  });

  /**
   * K-19: renderers run in sequence and one that throws stops the ones behind
   * it. Beyond that, nothing about telemetry is worth failing an apply for —
   * the whole configuration would be reverted, and a change that moves the
   * radio reverted *and rebooted*, on an aircraft, because a router would not
   * start. §5 makes exactly that argument about the confirmation window.
   *
   * It is also the ordinary state of every board built before the offline
   * payload carried `mavlink-router` at all: the unit is simply not there,
   * and a renderer that threw would fail every apply on every one of them.
   */
  it("never throws, whatever systemd says", async () => {
    const h = harness({
      reply: serviceIs("inactive", () => ({ code: 5, stdout: "", stderr: "Unit mavlink-router.service not found." })),
      serial: heartbeatAt("/dev/ttyAMA0", 57600),
    });

    await expect(h.renderer.render(config())).resolves.toBeUndefined();

    expect(h.log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/not found/);
  });

  it("never throws when the configuration cannot be written", async () => {
    const h = harness({ serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    // A directory where the file should be: writeFileDurable cannot replace it.
    mkdirSync(h.confPath, { recursive: true });

    await expect(h.renderer.render(config())).resolves.toBeUndefined();

    // And nothing was started against a file that was never written.
    expect(systemctl(h.calls)).not.toContain("start");
  });

  it("rewrites nothing and restarts nothing when the file already says what it should", async () => {
    const h = harness({ reply: serviceIs("active"), serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    seedConf(h.confPath, routerConfig(config().mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));
    const before = readFileSync(h.confPath, "utf8");

    await h.renderer.render(config());
    await h.renderer.render(config());

    expect(readFileSync(h.confPath, "utf8")).toBe(before);
    expect(systemctl(h.calls)).toEqual(["is-active", "is-active"]);
  });

  /**
   * The ordinary boot: `mavlink-router` outlives a `yonder-core` restart by
   * design (R-MAV-06), so a fresh daemon routinely meets a router that has
   * been carrying telemetry for hours. Nothing in this process has probed
   * anything, and reporting `searching` would draw a page hunting for an
   * autopilot whose telemetry is flowing past it.
   */
  it("reports the port and speed of a router it adopted, rather than searching", async () => {
    const h = harness({ reply: serviceIs("active") });
    seedConf(h.confPath, routerConfig(config().mavlink, { device: "/dev/ttyAMA0", baud: 230400 }));

    await h.renderer.render(config());

    expect(h.renderer.state()).toMatchObject({
      phase: "linked",
      device: "/dev/ttyAMA0",
      baud: 230400,
      // Never invented: a vehicle name and a system id come from a heartbeat,
      // and adoption has not read one.
      vehicle: null,
      system: null,
    });
  });

  /**
   * `LinkState` says nothing about whether the service is running — every
   * field there is a measurement about the autopilot, and this is a fact
   * about the device. The page needs both, and this is the only object that
   * knows: ADR-0006 puts every `systemctl` behind a renderer, and Task 11's
   * routes are not one.
   */
  it("says whether telemetry is actually on the air, which the link state cannot", async () => {
    const h = harness({ serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    expect(h.renderer.telemetryRunning).toBe(false);

    await h.renderer.render(config());
    expect(h.renderer.telemetryRunning).toBe(true);

    // A link that was found while telemetry is deliberately off reads
    // `linked` and is not flowing — which is exactly the pair a page has to
    // be able to tell apart.
    const off = harness({ serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    await off.renderer.render(config({ autocast: false }));
    expect(off.renderer.state().phase).toBe("linked");
    expect(off.renderer.telemetryRunning).toBe(false);
  });

  it("leaves a running router alone when its file names no link it can read", async () => {
    const h = harness({ reply: serviceIs("active"), serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    seedConf(h.confPath, "[General]\nReportStats = true\n");

    await h.renderer.render(config());

    // Probing would seize the port from a router that is working.
    expect(h.opened).toEqual([]);
    expect(systemctl(h.calls)).toEqual(["is-active"]);
  });
});

/**
 * `device` and `baud` are independent schema fields, and half-pinning one of
 * them is the natural way to say "I know the port, find the speed" — the two
 * device values `docs/configuration.md` documents are exactly that case.
 *
 * Adoption used to require *both* to be pinned before it would honour either,
 * so a half-pinned link was compared against nothing: the running link was
 * adopted, the rendered file matched, and the operator's explicit instruction
 * was discarded in silence on every apply from then on, with the page still
 * reporting the old device as linked. That is the mirror image of the bug
 * adoption exists to prevent.
 */
describe("MavlinkRenderer — a pinned field the router is not honouring", () => {
  /** The file a router on the header UART at 57 600 would be running under. */
  const onTheUart = () => routerConfig(config().mavlink, { device: "/dev/ttyAMA0", baud: 57600 });

  it("moves to a pinned device the router is not on, without stopping the link to find out", async () => {
    const u = unit("active");
    const h = harness({ reply: u.reply, serial: { "/dev/ttyACM0": { 115200: heartbeatV2(1, 1, 3) } } });
    seedConf(h.confPath, onTheUart());

    await h.renderer.render(config({ serial: { device: "/dev/ttyACM0", baud: "auto" } }));

    // The pinned port is by definition not the one the router is holding, so
    // the sweep costs the running link nothing and only the switch interrupts.
    expect(systemctl(h.calls)).not.toContain("stop");
    expect(systemctl(h.calls).filter((v) => v === "restart")).toHaveLength(1);
    expect(h.opened.every((o) => o.device === "/dev/ttyACM0")).toBe(true);
    expect(readConf(h.confPath)).toContain("Device = /dev/ttyACM0");
    expect(readConf(h.confPath)).toContain("Baud = 115200");
    expect(h.renderer.state()).toMatchObject({ phase: "linked", device: "/dev/ttyACM0", baud: 115200 });
  });

  it("keeps the working link when nothing answers on the pinned device", async () => {
    const u = unit("active");
    const h = harness({ reply: u.reply, serial: { "/dev/ttyAMA0": SILENT, "/dev/ttyACM0": SILENT } });
    seedConf(h.confPath, onTheUart());

    await h.renderer.render(config({ serial: { device: "/dev/ttyACM0", baud: "auto" } }));

    // Taking the running link down would answer a question nobody asked.
    expect(systemctl(h.calls)).toEqual(["is-active"]);
    expect(readConf(h.confPath)).toBe(onTheUart());
    expect(u.active).toBe(true);
    // And it said so, rather than discarding the instruction in silence.
    const said = h.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toMatch(/\/dev\/ttyACM0/);
    expect(said).toMatch(/still carrying telemetry/);
    h.renderer.close();
  });

  it("moves to a pinned speed the router is not running at, without opening anything", async () => {
    const u = unit("active");
    const h = harness({ reply: u.reply, serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    seedConf(h.confPath, onTheUart());

    await h.renderer.render(config({ serial: { device: "auto", baud: 230400 } }));

    // Both halves are known without a sweep: the port the router is already
    // on, at the speed the operator pinned.
    expect(h.opened).toEqual([]);
    expect(systemctl(h.calls).filter((v) => v === "restart")).toHaveLength(1);
    expect(readConf(h.confPath)).toBe(routerConfig(config().mavlink, { device: "/dev/ttyAMA0", baud: 230400 }));
  });

  it("does nothing at all when the pinned field is the one the router is already honouring", async () => {
    const h = harness({ reply: serviceIs("active"), serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    seedConf(h.confPath, onTheUart());

    await h.renderer.render(config({ serial: { device: "/dev/ttyAMA0", baud: "auto" } }));
    await h.renderer.render(config({ serial: { device: "auto", baud: 57600 } }));

    expect(h.opened).toEqual([]);
    expect(systemctl(h.calls)).toEqual(["is-active", "is-active"]);
  });
});

/**
 * R-MAV-09. Stopping telemetry is an operator's decision about routing, and an
 * apply that has nothing to do with telemetry must not overturn it — which is
 * what happened while `settle()` consulted only `autocast`: the stopped router
 * left the port free, the next render swept it, and `autocast` started it
 * again because somebody changed the palette.
 */
describe("MavlinkRenderer — telemetry stopped at runtime", () => {
  it("stays stopped through an apply that has nothing to do with it", async () => {
    const u = unit("inactive");
    const h = harness({ reply: u.reply, serial: heartbeatAt("/dev/ttyAMA0", 57600) });

    await h.renderer.render(config({}, { ui: { editor: {}, theme: "day" } }));
    expect(systemctl(h.calls).filter((v) => v === "start")).toHaveLength(1);

    await h.renderer.stopTelemetry();
    const before = h.calls.length;

    await h.renderer.render(config({}, { ui: { editor: {}, theme: "night" } }));

    const after = systemctl(h.calls.slice(before));
    expect(after).not.toContain("start");
    expect(after).not.toContain("restart");
    expect(u.active).toBe(false);
    expect(h.renderer.telemetryRunning).toBe(false);
    expect(h.renderer.state().phase).toBe("stopped");
    h.renderer.close();
  });

  it("comes back when the operator says so, whatever autocast says", async () => {
    const u = unit("inactive");
    const h = harness({ reply: u.reply, serial: heartbeatAt("/dev/ttyAMA0", 57600) });

    // autocast off: nothing starts on its own (R-MAV-08) …
    await h.renderer.render(config({ autocast: false }));
    expect(systemctl(h.calls)).not.toContain("start");

    // … and an operator starting it by hand is not "on its own" (R-MAV-09).
    await h.renderer.startTelemetry();

    expect(systemctl(h.calls)).toContain("start");
    expect(h.renderer.telemetryRunning).toBe(true);
    expect(h.renderer.state().phase).toBe("linked");
  });

  it("refuses to be restarted by a sweep it had already scheduled", async () => {
    // Nothing found, so a retry is armed; the operator then stops telemetry
    // before it fires. The retry must not be what puts the router back.
    const u = unit("inactive");
    const h = harness({ reply: u.reply, serial: { "/dev/ttyAMA0": SILENT } });

    await h.renderer.render(config());
    await h.renderer.stopTelemetry();

    h.serial["/dev/ttyAMA0"] = { 57600: heartbeatV2(1, 1, 3) };
    const commands = h.calls.length;
    const opens = h.opened.length;
    h.clock.advance(30_000);
    await settle();

    expect(systemctl(h.calls)).not.toContain("start");
    expect(u.active).toBe(false);
    // Two independent guards, asserted independently. The sweep is cancelled,
    // so nothing runs at all — a device an operator switched off must not go
    // on opening its serial port every thirty seconds for ever …
    expect(h.calls).toHaveLength(commands);
    expect(h.opened).toHaveLength(opens);
    // … and `settle()` would refuse to start it even if one did fire, which is
    // what protects a sweep that was armed by some other path.
    await h.renderer.render(config());
    expect(systemctl(h.calls)).not.toContain("start");
    h.renderer.close();
  });
});

describe("MavlinkRenderer — failures that must not be the end of it", () => {
  /**
   * R-MAV-08 is a P1, and a single `systemctl` that would not run should not
   * be able to defeat it until the next apply. A failed *start* has the same
   * property a failed *sweep* has — nothing is flowing and nothing holds the
   * port — so it is retried on the same cadence.
   */
  it("tries again when the router would not start", async () => {
    let refuse = true;
    const u = unit("inactive", (argv) =>
      refuse && argv[1] === "start" ? { code: 1, stdout: "", stderr: "Job for mavlink-router.service failed" } : null);
    const h = harness({ reply: u.reply, serial: heartbeatAt("/dev/ttyAMA0", 57600) });

    await h.renderer.render(config());
    expect(systemctl(h.calls).filter((v) => v === "start")).toHaveLength(1);
    expect(h.renderer.telemetryRunning).toBe(false);

    refuse = false;
    h.clock.advance(30_000);
    await settle();

    expect(systemctl(h.calls).filter((v) => v === "start")).toHaveLength(2);
    expect(h.renderer.telemetryRunning).toBe(true);
    h.renderer.close();
  });

  it("tries again when the configuration could not be written", async () => {
    const h = harness({ serial: heartbeatAt("/dev/ttyAMA0", 57600) });
    mkdirSync(h.confPath, { recursive: true });

    await h.renderer.render(config());
    expect(systemctl(h.calls)).not.toContain("start");

    // A directory that an installer role creates a minute later, or a full
    // disk that empties, both heal here rather than at the next apply.
    rmSync(h.confPath, { recursive: true });
    h.clock.advance(30_000);
    await settle();

    expect(systemctl(h.calls)).toContain("start");
    h.renderer.close();
  });

  /**
   * Nobody awaits the stats tick, so a rejection inside it has no handler and
   * takes the daemon down under Node's default. `systemRunner` never rejects,
   * but `buildRenderers` accepts whatever runner a caller hands it.
   */
  it("survives a runner that rejects on the stats tick, rather than taking the daemon down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-mav-reject-"));
    const log = vi.fn();
    const clock = fakeClock();
    const renderer = new MavlinkRenderer({
      run: async (argv) => {
        if (argv[0] === "journalctl") throw new Error("spawn journalctl ENOENT");
        return serviceIs("active")(argv);
      },
      open: async () => { throw new Error("a running router is never re-probed"); },
      confPath: join(dir, "main.conf"),
      hintPath: join(dir, "hint.json"),
      clock, log, statsIntervalMs: 1_000,
    });
    seedConf(join(dir, "main.conf"), routerConfig(config().mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));
    await renderer.render(config());

    const unhandled: unknown[] = [];
    const watch = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", watch);
    try {
      renderer.startSampling();
      clock.advance(1_000);
      await settle();
      await settle();
    } finally {
      process.off("unhandledRejection", watch);
      renderer.close();
    }

    expect(unhandled).toEqual([]);
    // Caught and said once, on the same path a non-zero exit takes.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("spawn journalctl ENOENT"));
  });

  /**
   * `running` was refreshed only by an apply, so a router that died between
   * two of them left the page reporting a link that was not flowing — for as
   * long as nobody applied anything. R-MAV-10 names telemetry-running as a
   * thing to report.
   */
  it("notices a router that died between applies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-mav-died-"));
    const calls: string[][] = [];
    const clock = fakeClock();
    let alive = true;
    const renderer = new MavlinkRenderer({
      run: async (argv) => {
        calls.push(argv);
        if (argv[1] === "is-active") return alive ? ACTIVE : INACTIVE;
        if (argv[0] === "journalctl") return { code: 0, stdout: "", stderr: "" };
        return OK;
      },
      open: async () => { throw new Error("a running router is never re-probed"); },
      confPath: join(dir, "main.conf"),
      hintPath: join(dir, "hint.json"),
      clock, statsIntervalMs: 1_000,
    });
    seedConf(join(dir, "main.conf"), routerConfig(config().mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));

    await renderer.render(config());
    expect(renderer.telemetryRunning).toBe(true);
    renderer.startSampling();

    alive = false;
    const before = calls.filter((a) => a[0] === "journalctl").length;
    clock.advance(1_000);
    await settle();

    expect(renderer.telemetryRunning).toBe(false);
    // And it stopped differencing a journal tail that has stopped growing.
    expect(calls.filter((a) => a[0] === "journalctl")).toHaveLength(before);
    renderer.close();
  });
});

/**
 * `LinkState.groundStations`, `.traffic` and `.tcpClients` are measurements
 * only `mavlink-router` holds. It prints them to stdout once a second with
 * `ReportStats = true`, systemd puts stdout in the journal, and this renderer
 * owns that process — so this is where the journal is read and handed to
 * `parseStats` (§6, §10.3, and `docs/hardware/an-autopilot-on-the-uart.md`).
 */
describe("MavlinkRenderer — the router's own statistics", () => {
  const block = (
    kind: "UDP" | "UART",
    index: number,
    name: string,
    handled: number,
    total: number,
  ) =>
    [
      `${kind} Endpoint [${index}]${name} {`,
      "\tReceived messages {",
      "\t\tCRC error: 0 0% 0KB",
      "\t\tSequence lost: 0 0%",
      `\t\tHandled: ${handled} ${handled}KB`,
      `\t\tTotal: ${handled}`,
      "\t}",
      "\tTransmitted messages {",
      `\t\tTotal: ${total} ${total}KB`,
      "\t}",
      "}",
    ].join("\n");

  /** One statistics dump: the UART, the control plane's own copy, two stations. */
  const dump = (gcs0: number, gcs1: number, yonder: number) =>
    [
      block("UART", 6, "autopilot", 955, 0),
      block("UDP", 7, "yonder", yonder, 954),
      block("UDP", 8, "gcs0", gcs0, 954),
      block("UDP", 9, "gcs1", gcs1, 954),
    ].join("\n") + "\n";

  const twoStations = config({
    endpoints: [
      { name: "gcs0", host: "10.0.0.9", port: 14550 },
      { name: "gcs1", host: "10.0.0.10", port: 14551 },
    ],
  });

  function statsHarness(journal: () => string) {
    const dir = mkdtempSync(join(tmpdir(), "yonder-mav-stats-"));
    const confPath = join(dir, "etc", "main.conf");
    const calls: string[][] = [];
    const clock = fakeClock();
    const run: CommandRunner = async (argv) => {
      calls.push(argv);
      if (argv[0] !== "journalctl") return serviceIs("active")(argv);
      // The real journal answers in whichever format it was asked for. Without
      // `-o cat` every line arrives behind a syslog prefix, so nothing this
      // renderer reads back would match a block header at all — which is a
      // consequence worth reproducing here rather than a spelling worth
      // asserting.
      const raw = journal();
      const plain = argv.includes("cat") && argv.includes("-o");
      return {
        code: 0,
        stdout: plain
          ? raw
          : raw.split("\n").map((line) => (line === "" ? line : `Sep 05 23:00:00 yonder mavlink-routerd[413]: ${line}`)).join("\n"),
        stderr: "",
      };
    };
    const renderer = new MavlinkRenderer({
      run,
      open: async () => {
        throw new Error("a running router is never re-probed");
      },
      confPath,
      hintPath: join(dir, "var", "hint.json"),
      clock,
      statsIntervalMs: 1_000,
    });
    seedConf(confPath, routerConfig(twoStations.mavlink, { device: "/dev/ttyAMA0", baud: 57600 }));
    return { renderer, calls, clock };
  }

  it("reads the router's statistics out of the journal, through the runner", async () => {
    const h = statsHarness(() => dump(1, 0, 1));
    await h.renderer.render(twoStations);
    h.renderer.startSampling();
    h.clock.advance(1_000);
    await settle();

    const journal = h.calls.filter((a) => a[0] === "journalctl");
    expect(journal).toHaveLength(1);
    expect(journal[0]).toContain("-u");
    expect(journal[0]).toContain(ROUTER_UNIT);
    // And it asked for the format it can actually parse: the harness prefixes
    // every line the way journald's default output does unless `-o cat` was
    // asked for, so a reading that arrives behind a syslog prefix produces no
    // ground stations at all rather than a subtly wrong number.
    expect(h.renderer.state().groundStations.map((s) => s.name)).toEqual(["gcs0", "gcs1"]);
    h.renderer.close();
  });

  // The measurement §6 was reversed by: the answering endpoint's own counter
  // moves and the silent one stays at zero. A counter has to be seen to
  // *increase*, so two readings are what it takes.
  it("names which ground station is answering, from the counter that moved", async () => {
    let gcs0 = 1;
    const h = statsHarness(() => dump(gcs0, 0, 40));
    await h.renderer.render(twoStations);
    h.renderer.startSampling();

    h.clock.advance(1_000);
    await settle();
    gcs0 = 2;
    h.clock.advance(1_000);
    await settle();

    expect(h.renderer.state().groundStations).toEqual([
      { name: "gcs0", answering: true, lastHeardMs: expect.any(Number) },
      { name: "gcs1", answering: false, lastHeardMs: null },
    ]);
    h.renderer.close();
  });

  /**
   * `yonder` is the control plane's own loopback copy (R-MAV-05) and is a
   * `UdpEndpoint` exactly like a real ground station, whose counter moves
   * whenever telemetry flows at all. Filtering the router's blocks by kind
   * would report Yonder's own feed as a permanently-answering ground station
   * on every device — which is why `sampled()` takes the configured names.
   */
  it("never counts the control plane's own loopback copy as a ground station", async () => {
    let yonder = 100;
    const h = statsHarness(() => dump(0, 0, yonder));
    await h.renderer.render(twoStations);
    h.renderer.startSampling();

    h.clock.advance(1_000);
    await settle();
    yonder += 900;
    h.clock.advance(1_000);
    await settle();

    const state = h.renderer.state();
    expect(state.groundStations.map((s) => s.name)).toEqual(["gcs0", "gcs1"]);
    expect(state.groundStations.every((s) => !s.answering)).toBe(true);
    h.renderer.close();
  });

  it("samples on its own clock rather than when a console happens to ask", async () => {
    const h = statsHarness(() => dump(1, 0, 1));
    await h.renderer.render(twoStations);
    h.renderer.startSampling();

    for (let i = 0; i < 3; i++) {
      h.clock.advance(1_000);
      await settle();
    }
    h.renderer.state();
    h.renderer.state();

    expect(h.calls.filter((a) => a[0] === "journalctl")).toHaveLength(3);
    h.renderer.close();
  });

  it("stops sampling when it is closed", async () => {
    const h = statsHarness(() => dump(1, 0, 1));
    await h.renderer.render(twoStations);
    h.renderer.startSampling();
    h.clock.advance(1_000);
    await settle();

    h.renderer.close();
    h.clock.advance(5_000);
    await settle();

    expect(h.calls.filter((a) => a[0] === "journalctl")).toHaveLength(1);
  });

  it("reads nothing while no router is running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-mav-idle-"));
    const calls: string[][] = [];
    const clock = fakeClock();
    const renderer = new MavlinkRenderer({
      run: async (argv) => {
        calls.push(argv);
        return serviceIs("inactive")(argv);
      },
      open: async () => {
        throw new Error("ENOENT: no such file or directory");
      },
      confPath: join(dir, "etc", "main.conf"),
      hintPath: join(dir, "var", "hint.json"),
      clock,
      statsIntervalMs: 1_000,
    });

    await renderer.render(config());
    renderer.startSampling();
    clock.advance(3_000);
    await settle();

    expect(calls.filter((a) => a[0] === "journalctl")).toEqual([]);
    renderer.close();
  });
});

/**
 * How a running router's own port and speed are recovered without asking the
 * port — the whole mechanism adoption rests on.
 */
describe("linkFromConf", () => {
  it("reads the autopilot's own section and no other", () => {
    // §4 says an edit to this file survives until the next apply, so a second
    // UART section is a state a running router can genuinely be under. Taking
    // the wrong one would restart the router onto a port nothing chose.
    // A decoy on each side, deliberately: with only one *above* the autopilot's
    // section an unscoped parser still ends on the right values, and the test
    // would pass while proving nothing.
    const text = [
      "[General]",
      "ReportStats = true",
      "",
      "[UartEndpoint earlier]",
      "Device = /dev/ttyS0",
      "Baud = 921600",
      "",
      "[UartEndpoint autopilot]",
      "Device = /dev/ttyAMA0",
      "Baud = 57600",
      "",
      "[UartEndpoint later]",
      "Device = /dev/ttyUSB3",
      "Baud = 115200",
      "",
      "[UdpEndpoint gcs0]",
      "Address = 10.0.0.9",
      "Port = 14550",
      "",
    ].join("\n");

    expect(linkFromConf(text)).toEqual({ device: "/dev/ttyAMA0", baud: 57600 });
  });

  it("reads what routerConfig writes", () => {
    // The pair that has to agree. Two literals for one section name is how
    // they stop agreeing, which is why the name is imported rather than typed
    // out again in the renderer.
    const text = routerConfig(config().mavlink, { device: "/dev/ttyACM0", baud: 230400 });
    expect(linkFromConf(text)).toEqual({ device: "/dev/ttyACM0", baud: 230400 });
  });

  it("answers with nothing for half a link, or none at all", () => {
    expect(linkFromConf(null)).toBeNull();
    expect(linkFromConf("[General]\nReportStats = true\n")).toBeNull();
    // Truncated mid-section: a device with no speed is not a link, and
    // rendering against one would restart the router onto a guess.
    expect(linkFromConf("[UartEndpoint autopilot]\nDevice = /dev/ttyAMA0\n")).toBeNull();
  });
});

/**
 * R-MAV-13's whole point: *which* kind of nothing. With `device: auto` two
 * devices are swept and they can fail differently, so the outcome reported is
 * the one that tells an operator the most about what to go and look at.
 */
describe("MavlinkRenderer — choosing between two kinds of nothing", () => {
  it("reports bytes on a pin over silence on another, because they send the operator to different places", async () => {
    const h = harness({
      serial: {
        // Nothing whatever at any speed — R-MAV-13 sends this operator to the
        // pins.
        "/dev/ttyAMA0": SILENT,
        // Bytes at every speed that never resolve to a frame: the wiring is
        // ruled out and the autopilot's own protocol and baud settings are
        // what to check.
        "/dev/ttyACM0": {
          57600: Uint8Array.from([1, 2, 3, 4]),
          115200: Uint8Array.from([1, 2, 3, 4]),
          230400: Uint8Array.from([1, 2, 3, 4]),
          921600: Uint8Array.from([1, 2, 3, 4]),
        },
      },
    });

    await h.renderer.render(config());

    expect(h.renderer.state()).toMatchObject({ phase: "noise", device: "/dev/ttyACM0" });
    h.renderer.close();
  });

  it("reports the device it actually swept over one it could not open at all", async () => {
    // /dev/ttyACM0 is not there, which is the ordinary state of a board with
    // nothing plugged into it. Naming it as the silent one would send an
    // operator to check a port that does not exist.
    const h = harness({ serial: { "/dev/ttyAMA0": SILENT } });

    await h.renderer.render(config());

    expect(h.renderer.state()).toMatchObject({ phase: "silent", device: "/dev/ttyAMA0" });
    expect(h.renderer.state().triedBauds).toEqual([57600, 115200, 230400, 921600]);
    h.renderer.close();
  });
});

describe("MavlinkRenderer — the constants it publishes", () => {
  it("names the unit and the one generated file", () => {
    expect(ROUTER_UNIT).toBe("mavlink-router");
    expect(ROUTER_CONF_PATH).toBe("/etc/mavlink-router/main.conf");
  });

  // R-MAV-02, and the values docs/configuration.md documents for `device`.
  it("sweeps the header UART and a USB CDC-ACM device", () => {
    expect([...MAVLINK_DEVICES]).toEqual(["/dev/ttyAMA0", "/dev/ttyACM0"]);
  });

  it("reads past ordinary traffic at the right rate rather than settling for it", async () => {
    // A right-rate port mostly carries frames that are not heartbeats. The
    // multi-device loop must not turn "valid MAVLink, no heartbeat yet" into
    // an outcome of its own.
    const h = harness({
      serial: { "/dev/ttyAMA0": { 57600: validSysStatusBytes(), 115200: heartbeatV2(1, 10, 3) } },
    });

    await h.renderer.render(config());

    expect(h.renderer.state()).toMatchObject({ phase: "linked", baud: 115200 });
  });
});
