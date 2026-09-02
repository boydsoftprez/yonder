// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ReachMonitor, pathDevices, pathInUse, pathsHolding } from "./monitor.js";
import { FAILURES_TO_STAND_DOWN, Standing, type PathName } from "./standing.js";
import { DEFAULT_CONFIG, type Config } from "../../schema/config.js";
import type { DeviceInfo } from "../nmcli/client.js";

function fixedClock(start = 1_000) {
  let now = start;
  return {
    clock: { now: () => now, setTimer: () => 0, clearTimer: () => {} },
    advance: (ms: number) => { now += ms; },
  };
}

interface Built {
  monitor: ReachMonitor;
  standing: Standing;
  lines: string[];
  probed: string[];
}

/**
 * A monitor with every input injected. No probe runs, no counter is read from
 * /sys, and nothing asks NetworkManager anything — the whole point of the
 * options being what they are.
 */
function build(opts: {
  devices?: Partial<Record<PathName, string>>;
  inUse?: PathName | null;
  /** Every path holding an address. Defaults to just `inUse`. */
  holding?: PathName[];
  order?: PathName[];
  reaches?: (device: string) => boolean;
  probeThrows?: boolean;
  devicesThrows?: boolean;
  inUseThrows?: boolean;
  counters?: (device: string) => { rx: number; tx: number } | null;
} = {}): Built {
  const { clock } = fixedClock();
  const lines: string[] = [];
  const probed: string[] = [];
  const standing = new Standing({ clock, log: (l) => lines.push(l) });
  const monitor = new ReachMonitor({
    standing,
    probe: async (device) => {
      probed.push(device);
      if (opts.probeThrows === true) throw new Error("curl could not be started");
      return opts.reaches === undefined ? true : opts.reaches(device);
    },
    counters: opts.counters ?? (() => null),
    devices: async () => {
      if (opts.devicesThrows === true) throw new Error("NetworkManager is not answering");
      return opts.devices ?? { ethernet: "eth0", modem: "wwan0" };
    },
    order: () => opts.order ?? ["ethernet", "modem", "wifi_client"],
    holding: async () => {
      if (opts.inUseThrows === true) throw new Error("NetworkManager is not answering");
      if (opts.holding !== undefined) return opts.holding;
      const inUse = opts.inUse === undefined ? "modem" : opts.inUse;
      return inUse === null ? [] : [inUse];
    },
    log: (l) => lines.push(l),
  });
  return { monitor, standing, lines, probed };
}

describe("ReachMonitor.test", () => {
  it("probes the interface the path is on, not the routing table", async () => {
    // The question is whether *this* path works, and the default route is
    // usually another one.
    const { monitor, probed } = build({ devices: { modem: "wwan0" } });
    await monitor.test("modem");
    expect(probed).toEqual(["wwan0"]);
  });

  it("folds the result into standing", async () => {
    const { monitor, standing } = build({ reaches: () => false });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("modem");
    expect(standing.standingOf("modem")).toBe("no-route-out");
  });

  it("does not probe, or record anything, for a path this board does not have", async () => {
    // An absent path has no standing to change. Recording a failure against
    // one would be inventing evidence about hardware that is not there.
    const { monitor, standing, probed } = build({ devices: { ethernet: "eth0" } });
    expect(await monitor.test("modem")).toBe(false);
    expect(probed).toEqual([]);
    expect(standing.standingOf("modem")).toBe("standing-by");
  });

  it("counts a probe that could not run as a failure", async () => {
    // The same direction probe.ts takes about exit code 127: a board that
    // cannot establish that a path works must not report that it does.
    const { monitor, standing, lines } = build({ probeThrows: true });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("modem");
    expect(standing.standingOf("modem")).toBe("no-route-out");
    expect(lines.join("\n")).toMatch(/could not test cellular/);
  });

  it("says how many bytes went out and came back when a path fails", async () => {
    // The kernel's own counters, which cost nothing to read (R-CEL-09), are
    // what tell a bad APN — bytes leaving, nothing returning — from a link
    // that is merely idle.
    let call = 0;
    const { monitor, lines } = build({
      reaches: () => false,
      counters: () => { call += 1; return { rx: 100, tx: call === 1 ? 0 : 400 }; },
    });
    await monitor.test("modem");
    expect(lines.join("\n")).toMatch(/400 bytes left wwan0 and 0 came back/);
  });
});

describe("ReachMonitor.state", () => {
  it("reports a path with no interface as absent", async () => {
    const { monitor } = build({ devices: { ethernet: "eth0" }, inUse: "ethernet" });
    const state = await monitor.state();
    const modem = state.paths.find((p) => p.path === "modem");
    expect(modem?.standing).toBe("absent");
    expect(modem?.device).toBeNull();
  });

  it("reports the path traffic is leaving by as in use", async () => {
    const { monitor } = build({ inUse: "modem" });
    const state = await monitor.state();
    expect(state.inUse).toBe("modem");
    expect(state.paths.find((p) => p.path === "modem")?.standing).toBe("in-use");
  });

  it("reports a path that has been stood down, and when", async () => {
    const { monitor, standing } = build({ inUse: "ethernet", reaches: () => false });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("modem");
    const report = (await monitor.state()).paths.find((p) => p.path === "modem");
    expect(report?.standing).toBe("no-route-out");
    expect(report?.since).toBe(standing.since("modem"));
    expect(report?.since).not.toBeNull();
  });

  /**
   * The whole claim of this milestone. A modem with the wrong APN registers,
   * attaches, takes an address and installs the default route while
   * completing no request — so it is simultaneously the path in use *and*
   * reaching nothing. Showing that as "in use, carrying traffic" is the
   * console reading healthy on a device that is not, which R-CEL-09 forbids.
   */
  it("shows a stood-down path as stood down even while it holds the route", async () => {
    const { monitor } = build({ inUse: "modem", reaches: () => false });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("modem");
    const state = await monitor.state();
    expect(state.inUse).toBe("modem");
    expect(state.paths.find((p) => p.path === "modem")?.standing).toBe("no-route-out");
    expect(state.carrying).toBe(false);
  });

  it("reports everything else as standing by", async () => {
    const { monitor } = build({ inUse: "modem" });
    const state = await monitor.state();
    expect(state.paths.find((p) => p.path === "ethernet")?.standing).toBe("standing-by");
  });

  it("reports every path, in the operator's order", async () => {
    // A page that showed only the configured paths would go quiet about the
    // one an operator has just unplugged from the priority list.
    const { monitor } = build({ order: ["modem", "ethernet"] });
    const state = await monitor.state();
    expect(state.paths.map((p) => p.path)).toEqual(["modem", "ethernet", "wifi_client"]);
  });

  it("gives every path a sentence", async () => {
    const { monitor } = build({ inUse: "modem" });
    for (const report of (await monitor.state()).paths) {
      expect(report.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("ReachMonitor.carrying", () => {
  /**
   * This answer arms the fallback watchdog, and the direction of a mistake is
   * not symmetric: a false "no" raises an access point on a working device,
   * which costs an operator a moment. A false "yes" leaves an unreachable
   * aircraft unreachable. Every "cannot tell" below therefore answers true —
   * the watchdog's own address check is what still stands behind it.
   */
  it("is true while the path in use has not been stood down", async () => {
    const { monitor } = build({ inUse: "modem" });
    expect(await monitor.carrying()).toBe(true);
  });

  it("is false once the path in use has been stood down", async () => {
    const { monitor } = build({ inUse: "modem", reaches: () => false });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("modem");
    expect(await monitor.carrying()).toBe(false);
  });

  it("is true when nothing can be attributed to a path", async () => {
    // An address on an interface this monitor has no path for — a USB gadget,
    // a connection an operator added. Not this check's business to condemn.
    const { monitor } = build({ inUse: null });
    expect(await monitor.carrying()).toBe(true);
  });

  it("is true when it cannot find out at all", async () => {
    const { monitor, lines } = build({ inUseThrows: true });
    expect(await monitor.carrying()).toBe(true);
    expect(lines.join("\n")).toMatch(/cannot tell/);
  });

  /**
   * `ReachState.carrying` says "some path is carrying traffic", and the
   * watchdog's own comment says a spurious access point costs an operator
   * nothing. Both stop being true if this answers about the top path alone.
   *
   * The board: an operator on the device over Wi-Fi client (so no access
   * point is up), and Ethernet plugged into a switch with no route out, which
   * takes a DHCP address and outranks the radio. Judging only Ethernet
   * answers false, the watchdog runs `nmcli connection up yonder-ap`, and one
   * radio cannot be both — so the operator loses the link they were using, on
   * a board that was reaching the internet the whole time.
   */
  it("is true while any path is reaching something, not only the top one", async () => {
    const { monitor, standing } = build({
      devices: { ethernet: "eth0", wifi_client: "wlan0" },
      order: ["ethernet", "wifi_client"],
      holding: ["ethernet", "wifi_client"],
      reaches: (d) => d !== "eth0",
    });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("ethernet");
    expect(standing.standingOf("ethernet")).toBe("no-route-out");
    expect(await monitor.carrying()).toBe(true);
    expect((await monitor.state()).carrying).toBe(true);
  });

  it("is false once every path holding an address has been stood down", async () => {
    const { monitor } = build({
      devices: { ethernet: "eth0", wifi_client: "wlan0" },
      order: ["ethernet", "wifi_client"],
      holding: ["ethernet", "wifi_client"],
      reaches: () => false,
    });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("ethernet");
    expect(await monitor.carrying()).toBe(true);
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("wifi_client");
    expect(await monitor.carrying()).toBe(false);
  });

  it("has not been told anything before a probe has ever run", async () => {
    // A daemon assembled with a monitor nothing has driven yet must behave
    // exactly as one assembled without one. This is the property that stops
    // wiring the monitor in from being the thing that takes devices off the
    // air.
    const { monitor, probed } = build({ reaches: () => false });
    expect(await monitor.carrying()).toBe(true);
    expect(probed).toEqual([]);
  });

  /**
   * K-33 by a different route, and the reason "not yet condemned" is not
   * "working".
   *
   * The board: a LAN cable into a switch with no route out, and an `auto`
   * modem on a wrong APN that registers around 45 s in. The fallback
   * watchdog fires **once**, and by the time it does ethernet has three
   * failures and is stood down while the modem, which took its address late,
   * has only two. Deferring to the modem because nothing has finished
   * condemning it answers "something is carrying traffic" about a board that
   * reaches nothing — the access point never comes up, and nothing looks
   * again.
   */
  it("is false while every path holding an address is failing, before the last is condemned", async () => {
    const { monitor, standing } = build({
      devices: { ethernet: "eth0", modem: "wwan0" },
      order: ["ethernet", "modem"],
      holding: ["ethernet", "modem"],
      reaches: () => false,
    });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await monitor.test("ethernet");
    for (let i = 0; i < FAILURES_TO_STAND_DOWN - 1; i++) await monitor.test("modem");

    expect(standing.standingOf("ethernet")).toBe("no-route-out");
    expect(standing.standingOf("modem")).not.toBe("no-route-out");
    expect(await monitor.carrying()).toBe(false);
  });

  /**
   * The other half, and why this cannot simply demand a success.
   *
   * A single-radio board in client mode, working, at a fallback deadline the
   * watch has not yet reached its first probe by. Answering false here brings
   * the access point up on the one radio and tears down the link the operator
   * is talking over — one bricking traded for another. Silence is not
   * evidence, and with no evidence the answer is the one an address alone has
   * always given.
   */
  it("is true when nothing holding an address has been probed yet", async () => {
    const { monitor, probed } = build({
      devices: { wifi_client: "wlan0" },
      order: ["wifi_client"],
      holding: ["wifi_client"],
      reaches: () => false,
    });
    expect(await monitor.carrying()).toBe(true);
    expect(probed).toEqual([]);
  });
});

/** The device list, in the shape the monitor asks for. */
function devices(): DeviceInfo[] {
  return [
    { device: "lo", type: "loopback", state: "connected", connection: "lo" },
    { device: "eth0", type: "ethernet", state: "connected", connection: "yonder-eth" },
    { device: "wlan0", type: "wifi", state: "connected", connection: "yonder-ap" },
    { device: "cdc-wdm0", type: "gsm", state: "connected", connection: "yonder-modem" },
  ];
}

function withModem(mode: "auto" | "appliance", iface: string | null = null): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.network.modem.enabled = true;
  c.network.modem.mode = mode;
  c.network.modem.interface = iface;
  return c;
}

describe("pathDevices", () => {
  it("names the ethernet and the modem interfaces", () => {
    expect(pathDevices(withModem("auto"), devices())).toEqual({
      ethernet: "eth0",
      modem: "cdc-wdm0",
    });
  });

  it("leaves the modem out when configuration does not ask for one", () => {
    expect(pathDevices(DEFAULT_CONFIG, devices()).modem).toBeUndefined();
  });

  /**
   * The design spec's first "name that is not the obvious one". `cdc-wdm0` is
   * what NetworkManager lists and binds a connection to; `wwan0` is what holds
   * the address and carries every byte, and is the only one with an entry
   * under /sys/class/net. This map is used to probe an interface and to read
   * its counters, so it must be the second — `curl --interface cdc-wdm0`
   * fails on a perfectly good link, and three of those stand a working modem
   * down.
   */
  it("uses the modem's data port, not the port the connection is bound to", () => {
    expect(pathDevices(withModem("auto"), devices(), "wwan0").modem).toBe("wwan0");
  });

  it("falls back to the device NetworkManager lists when nothing knows better", () => {
    expect(pathDevices(withModem("auto"), devices(), null).modem).toBe("cdc-wdm0");
  });

  it("takes the operator's word for an appliance", () => {
    // R-CEL-11: a modem that dials for itself is an adapter, and no amount of
    // device-type inspection improves on having been told which one.
    expect(pathDevices(withModem("appliance", "eth1"), devices()).modem).toBe("eth1");
  });

  it("counts the radio as a path only while it is joining a network", () => {
    // A radio serving the access point is how the operator is talking to the
    // device; it is not a way out, and probing it would stand it down.
    expect(pathDevices(DEFAULT_CONFIG, devices()).wifi_client).toBeUndefined();
    const joined = structuredClone(DEFAULT_CONFIG);
    joined.network.client.ssid = "HomeNetwork";
    expect(pathDevices(joined, devices()).wifi_client).toBe("wlan0");
  });
});

describe("pathsHolding", () => {
  it("names every path holding an address, in the operator's order", () => {
    // `carrying` asks about all of them: a dead path at the head of the order
    // must not be allowed to speak for a working one behind it.
    expect(pathsHolding(
      ["ethernet", "wifi_client", "modem"],
      { ethernet: "eth0", wifi_client: "wlan0", modem: "wwan0" },
      [
        { device: "eth0", address: "192.168.1.40/24" },
        { device: "wlan0", address: "192.168.8.22/24" },
      ],
      "192.168.77.1",
    )).toEqual(["ethernet", "wifi_client"]);
  });

  it("is empty when only the access point and loopback hold addresses", () => {
    expect(pathsHolding(
      ["ethernet", "wifi_client"],
      { ethernet: "eth0", wifi_client: "wlan0" },
      [
        { device: "lo", address: "127.0.0.1/8" },
        { device: "wlan0", address: "192.168.77.1/24" },
      ],
      "192.168.77.1",
    )).toEqual([]);
  });
});

describe("pathInUse", () => {
  const addresses = [
    { device: "lo", address: "127.0.0.1/8" },
    { device: "eth0", address: "192.168.1.40/24" },
    { device: "wwan0", address: "10.31.95.33/30" },
  ];

  it("is the first path in the operator's order that holds an address", () => {
    // Route metrics are generated from network.priority, so the first path in
    // that order holding an address is the one carrying the default route.
    expect(pathInUse(
      ["ethernet", "modem", "wifi_client"],
      { ethernet: "eth0", modem: "wwan0" },
      addresses,
      "10.42.0.1",
    )).toBe("ethernet");
  });

  it("follows the order the operator wrote", () => {
    expect(pathInUse(
      ["modem", "ethernet"],
      { ethernet: "eth0", modem: "wwan0" },
      addresses,
      "10.42.0.1",
    )).toBe("modem");
  });

  it("is null when no path holds an address", () => {
    expect(pathInUse(["ethernet"], { ethernet: "eth0" }, [], "10.42.0.1")).toBeNull();
  });

  it("never counts the access point's own address", () => {
    // The access point is how an operator reaches a device that has no way
    // out. Counting it as a way out is how a board reports itself healthy
    // while sitting on its own fallback.
    expect(pathInUse(
      ["wifi_client"],
      { wifi_client: "wlan0" },
      [{ device: "wlan0", address: "10.42.0.1/24" }],
      "10.42.0.1",
    )).toBeNull();
  });

  it("accepts either of a path's two names when looking for its address", () => {
    // Which name an address arrives under depends on which tool was asked, so
    // the modem is not read as "not in use" because NetworkManager reported
    // against the control port.
    expect(pathInUse(
      ["modem"],
      { modem: "wwan0" },
      [{ device: "cdc-wdm0", address: "10.31.95.33/30" }],
      "10.42.0.1",
      { modem: "cdc-wdm0" },
    )).toBe("modem");
  });

  it("never counts loopback", () => {
    expect(pathInUse(
      ["ethernet"],
      { ethernet: "lo" },
      [{ device: "lo", address: "127.0.0.1/8" }],
      "10.42.0.1",
    )).toBeNull();
  });
});
