// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";
import type { DeviceInfo } from "../nmcli/client.js";
import { wifiMode } from "../profiles.js";
import { movement, systemCounters, type CounterReader } from "./counters.js";
import type { Probe } from "./probe.js";
import {
  PATH_WORDS,
  type PathName,
  type PathReport,
  type ReachState,
  type Standing,
} from "./standing.js";

/** The paths this daemon knows how to test. */
const ALL_PATHS: PathName[] = ["ethernet", "modem", "wifi_client"];

export interface ReachMonitorOptions {
  standing: Standing;
  probe: Probe;
  /** Defaults to the kernel's own counters. Injected so a test reaches no /sys. */
  counters?: CounterReader;
  /** Which config path maps to which interface name, read fresh each time. */
  devices: () => Promise<Partial<Record<PathName, string>>>;
  /** The operator's order, from config.network.priority. */
  order: () => PathName[];
  /** Which path traffic is actually leaving by, or null. */
  inUse: () => Promise<PathName | null>;
  log?: (line: string) => void;
}

/**
 * The parts of `reach/` assembled into the two answers the daemon serves.
 *
 * Everything it reads is injected — the probe, the counters, the device map,
 * the operator's order, and which path holds the route — for the reason the
 * rest of this directory is built that way: no test may reach a real `curl`,
 * a real `/sys`, or a real `nmcli`, and a default that could would make that
 * a rule to remember rather than one that cannot be broken.
 *
 * It decides nothing about *preference*. `network.priority` is the only
 * statement of that and `config.yaml` remains its only writer (R-NET-13); all
 * this establishes is whether a path reaches anything, which is the question
 * an address cannot answer (K-33).
 */
export class ReachMonitor {
  private readonly standing: Standing;
  private readonly probe: Probe;
  private readonly counters: CounterReader;
  private readonly devices: () => Promise<Partial<Record<PathName, string>>>;
  private readonly order: () => PathName[];
  private readonly inUse: () => Promise<PathName | null>;
  private readonly log: (line: string) => void;

  constructor(opts: ReachMonitorOptions) {
    this.standing = opts.standing;
    this.probe = opts.probe;
    this.counters = opts.counters ?? systemCounters;
    this.devices = opts.devices;
    this.order = opts.order;
    this.inUse = opts.inUse;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Probe one path and fold the result into standing.
   *
   * Returns whether the path reached anything. **False also means "there was
   * nothing to test"** — a board with no modem returns false for `modem` and
   * nothing is recorded against it, because an absent path has no standing to
   * change and a failure recorded against hardware that is not there is
   * invented evidence.
   *
   * A probe that throws counts as a failure, which is the direction probe.ts
   * already takes about exit code 127: a board that cannot establish that a
   * path works must not report that it does. The cost of being wrong that way
   * is one more probe; the cost of being wrong the other way is an aircraft.
   */
  async test(path: PathName): Promise<boolean> {
    const device = (await this.devices())[path];
    if (device === undefined) return false;

    const before = this.counters(device);
    let reached: boolean;
    try {
      reached = await this.probe(device);
    } catch (e) {
      this.log(
        `network: could not test ${PATH_WORDS[path]} on ${device} `
        + `(${(e as Error).message}); treating it as unreachable`,
      );
      reached = false;
    }

    // Free, and the difference between a link that is dead and one that is
    // merely idle: the kernel maintains these whether or not anything reads
    // them, so saying this about a metered cellular link costs the operator
    // nothing (R-CEL-09).
    if (!reached) {
      const after = this.counters(device);
      if (before !== null && after !== null) {
        const moved = movement(before, after);
        this.log(
          `network: testing ${PATH_WORDS[path]} — ${moved.tx} bytes left ${device} `
          + `and ${moved.rx} came back`,
        );
      }
    }

    this.standing.record(path, reached);
    return reached;
  }

  /** The record GET /reach/state serves. */
  async state(): Promise<ReachState> {
    const [devices, inUse] = await Promise.all([this.devices(), this.inUse()]);
    const order = this.order();
    // Every path, not only the configured ones. A page that listed only what
    // `network.priority` names would go quiet about the path an operator has
    // just taken out of that list, which is exactly when they are looking.
    const rank = (path: PathName): number => {
      const at = order.indexOf(path);
      return at === -1 ? order.length : at;
    };
    const paths = [...ALL_PATHS]
      .sort((a, b) => rank(a) - rank(b))
      .map((path) => this.report(path, devices[path] ?? null, inUse));
    // From the reading already taken, not by asking again: `inUse` reaches
    // NetworkManager, and a record that asked it twice would be a record
    // assembled from two different moments.
    return { paths, inUse, carrying: this.carryingOn(inUse) };
  }

  /**
   * The watchdog's question: is any path carrying traffic?
   *
   * **True on every doubt.** R-NET-07's guarantee is that a device can never
   * be configured into unreachability, and this answer feeds the one check
   * that decides whether the access point comes up. The two mistakes are not
   * symmetric: a false "no" raises an access point on a working device, which
   * costs an operator nothing; a false "yes" leaves an unreachable aircraft
   * unreachable. So a path that has never been probed, an address that
   * belongs to no path this monitor knows, and a question that could not be
   * asked at all all answer true — and the watchdog's own address check still
   * stands behind this one.
   */
  async carrying(): Promise<boolean> {
    try {
      return this.carryingOn(await this.inUse());
    } catch (e) {
      this.log(`network: cannot tell whether anything is carrying traffic (${(e as Error).message})`);
      return true;
    }
  }

  /** The same answer, about a path already read. See carrying(). */
  private carryingOn(inUse: PathName | null): boolean {
    // An address on something this monitor has no path for — a USB gadget, a
    // connection an operator added by hand. Not this check's to condemn.
    if (inUse === null) return true;
    return this.standing.standingOf(inUse) !== "no-route-out";
  }

  /**
   * One path, as an operator should read it.
   *
   * **Stood down beats in use, deliberately.** Those two are simultaneously
   * true in the case this whole milestone is about: a modem with the wrong
   * APN registers, attaches, takes an address and installs the default route
   * while completing no request. Reporting that as "in use — carrying
   * traffic" is a console reading healthy on a device that is not, which is
   * precisely what R-CEL-09 forbids.
   */
  private report(path: PathName, device: string | null, inUse: PathName | null): PathReport {
    const word = PATH_WORDS[path];
    if (device === null) {
      return { path, device: null, standing: "absent", since: null,
        detail: `No ${word} interface on this board` };
    }
    if (this.standing.standingOf(path) === "no-route-out") {
      return { path, device, standing: "no-route-out", since: this.standing.since(path),
        detail: "Reached nothing when tested and has been stood down" };
    }
    if (inUse === path) {
      return { path, device, standing: "in-use", since: null, detail: "Carrying traffic" };
    }
    return { path, device, standing: "standing-by", since: null,
      detail: `Ready — traffic is not going out over ${word}` };
  }
}

/**
 * Which interface each path is on, from NetworkManager's own device list.
 *
 * Pure, and separate from the monitor, so the mapping is testable without an
 * nmcli and so `daemon/server.ts` stays wiring rather than a second place
 * that decides what a modem is.
 *
 * A path that is absent here is a path with no interface, and the monitor
 * reports it as absent rather than probing it.
 */
export function pathDevices(
  config: Config,
  devices: DeviceInfo[],
): Partial<Record<PathName, string>> {
  const found: Partial<Record<PathName, string>> = {};

  const ethernet = devices.find((d) => d.type === "ethernet")?.device;
  if (ethernet !== undefined) found.ethernet = ethernet;

  // Only while the radio is meant to be on someone else's network. A radio
  // serving the access point is how the operator is talking to this device;
  // it is not a way out, and probing it would stand down the one path that
  // is doing its job.
  if (wifiMode(config) === "client") {
    const wifi = devices.find((d) => d.type === "wifi")?.device;
    if (wifi !== undefined) found.wifi_client = wifi;
  }

  const modem = config.network.modem;
  if (modem.enabled) {
    // The operator's word wins outright for an appliance (R-CEL-11).
    // Otherwise the `gsm` device, which is NetworkManager's own type for a
    // modem it reaches through ModemManager.
    const device = modem.mode === "appliance"
      ? modem.interface
      : devices.find((d) => d.type === "gsm")?.device ?? null;
    if (device !== null && device !== "") found.modem = device;
  }

  return found;
}

/**
 * The path traffic is leaving by: the first in the operator's order that
 * holds an address.
 *
 * Derived from `network.priority` rather than read out of a routing table
 * because the route metrics are *generated* from that order (see
 * `metricFor`), so the first path in it holding an address is the one
 * carrying the default route — from the same statement NetworkManager was
 * given, rather than from a second, parallel reading of the kernel.
 *
 * The access point's own address never counts. It is how an operator reaches
 * a device that has no way out, and counting it as a way out is how a board
 * reports itself healthy while sitting on its own fallback.
 */
export function pathInUse(
  order: PathName[],
  devices: Partial<Record<PathName, string>>,
  addresses: { device: string; address: string }[],
  apAddress: string,
): PathName | null {
  const holds = (device: string): boolean =>
    addresses.some((a) =>
      a.device === device
      && a.device !== "lo"
      && !a.address.startsWith("127.")
      && a.address.split("/")[0] !== apAddress);

  for (const path of order) {
    const device = devices[path];
    if (device !== undefined && holds(device)) return path;
  }
  return null;
}
