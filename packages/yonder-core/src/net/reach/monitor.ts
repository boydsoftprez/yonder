// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";
import type { DeviceInfo } from "../nmcli/client.js";
import { wifiMode } from "../profiles.js";
import { movement, systemCounters, type CounterReader } from "./counters.js";
import type { Probe } from "./probe.js";
import {
  NOTHING_STOOD_DOWN,
  PATH_WORDS,
  type PathEvidence,
  type PathName,
  type PathReport,
  type ReachState,
  type Standing,
  type StandingView,
} from "./standing.js";

/** The paths this daemon knows how to test. */
const ALL_PATHS: PathName[] = ["ethernet", "modem", "wifi_client"];

export interface ReachMonitorOptions {
  routeDevice?: () => Promise<string | null>;
  standing: Standing;
  probe: Probe;
  /** Defaults to the kernel's own counters. Injected so a test reaches no /sys. */
  counters?: CounterReader;
  /** Which config path maps to which interface name, read fresh each time. */
  devices: () => Promise<Partial<Record<PathName, string>>>;
  /**
   * Which paths have an interface that is present and **not up**.
   *
   * Required, and deliberately so. Its absence is what let a board with an
   * unplugged ethernet port describe that port as "Up, and not yet tested"
   * (R-NET-14): `devices()` answers *whether there is an interface*, which is
   * a different question from *whether it is up*, and a monitor with only the
   * first has to guess at the second. An optional reading defaulting to "none
   * are down" would put that guess back, silently, for whoever next builds
   * one of these.
   *
   * It says only what has been established. `pathsDown` names a path only
   * when NetworkManager lists its interface in a state it knows to be not-up,
   * so a state word it does not recognise leaves the path exactly where it
   * was rather than being called down on a guess.
   */
  down: () => Promise<PathName[]>;
  /** The operator's order, from config.network.priority. */
  order: () => PathName[];
  /**
   * Every path holding an address, in the operator's order.
   *
   * **The whole list, and the head of it is not the answer to either
   * question.** `carrying` asks about all of them — a dead ethernet must not
   * read as a board with no way out while a Wi-Fi client link works beside it.
   * `activePath` picks the one carrying the default route out of them, which
   * needs standing as well as order: a stood-down path keeps its address, so
   * the head of this list is the path traffic has moved off.
   */
  holding: () => Promise<PathName[]>;
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
 * an address cannot answer (K-42).
 */
export class ReachMonitor {
  private readonly routeDevice: (() => Promise<string | null>) | undefined;
  private readonly standing: Standing;
  private readonly probe: Probe;
  private readonly counters: CounterReader;
  private readonly devices: () => Promise<Partial<Record<PathName, string>>>;
  private readonly down: () => Promise<PathName[]>;
  private readonly order: () => PathName[];
  private readonly holding: () => Promise<PathName[]>;
  private readonly log: (line: string) => void;

  constructor(opts: ReachMonitorOptions) {
    this.routeDevice = opts.routeDevice;
    this.standing = opts.standing;
    this.probe = opts.probe;
    this.counters = opts.counters ?? systemCounters;
    this.devices = opts.devices;
    this.down = opts.down;
    this.order = opts.order;
    this.holding = opts.holding;
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
   *
   * `stillWanted` is asked between the probe answering and the answer being
   * recorded, and is where a caller says "the question I asked this for has
   * been given up on". A probe is not cancellable — a `curl` that has not
   * come back is still out there — so the only place an abandoned answer can
   * be stopped is on its way into standing, and it has to be here rather than
   * in the caller because recording happens inside this call.
   */
  async test(path: PathName, stillWanted: () => boolean = () => true): Promise<boolean> {
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

    // Evidence about a moment that has passed. `SUCCESSES_TO_RETURN` is 1, so
    // one stale success clears `no-route-out` and moves the default route
    // back onto a path newer probes have called dead.
    if (!stillWanted()) {
      this.log(
        `network: the test of ${PATH_WORDS[path]} on ${device} answered after it `
        + `was given up on; not recording it`,
      );
      return reached;
    }

    this.standing.record(path, reached);
    return reached;
  }

  /** The record GET /reach/state serves. */
  async state(): Promise<ReachState> {
    // One moment, three readings, taken together. A device map fetched before
    // a separate reading of which interfaces are up describes a board that
    // existed between the two.
    const [devices, holding, down] = await Promise.all([
      this.devices(), this.holding(), this.down(),
    ]);
    // Not `holding[0]`. See `activePath`: a stood-down path keeps its address,
    // so the head of this list is the path traffic moved *off*.
    const inUse = await this.observedPath(devices, holding);
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
      .map((path) => this.report(path, devices[path] ?? null, inUse, down.includes(path)));
    // From the reading already taken, not by asking again: `holding` reaches
    // NetworkManager, and a record that asked it twice would be a record
    // assembled from two different moments.
    return { paths, inUse, carrying: this.carryingOn(holding) };
  }

  /**
   * The watchdog's question: is **some** path carrying traffic?
   *
   * **Some path, not the top one.** Asking only about the path holding the
   * default route reads a dead Ethernet as "this board reaches nothing" while
   * a Wi-Fi client link beside it is working — and the watchdog's answer to
   * that is `nmcli connection up yonder-ap` on the one radio, which drops the
   * client connection the operator is talking over. The watchdog's premise
   * that "a spurious access point costs an operator nothing" holds only while
   * this question is about every path (R-NET-07).
   *
   * **True on every doubt.** R-NET-07's guarantee is that a device can never
   * be configured into unreachability, and this answer feeds the one check
   * that decides whether the access point comes up. The two mistakes are not
   * symmetric: a false "no" raises an access point on a working device, which
   * costs an operator a moment; a false "yes" leaves an unreachable aircraft
   * unreachable. So a path that has never been probed, an address that
   * belongs to no path this monitor knows, and a question that could not be
   * asked at all all answer true — and the watchdog's own address check still
   * stands behind this one.
   *
   * **A doubt is not the same as evidence against.** A path whose probes are
   * failing is evidence, whether or not it has run out the three failures
   * that stand it down, and when every path holding an address is failing
   * this answers false. See `carryingOn`.
   */
  async carrying(readHolding: () => Promise<PathName[]> = this.holding): Promise<boolean> {
    try {
      return this.carryingOn(await readHolding());
    } catch (e) {
      this.log(`network: cannot tell whether anything is carrying traffic (${(e as Error).message})`);
      return true;
    }
  }

  /**
   * The operator's order, as this monitor was told it.
   *
   * For the watch that drives `test()`: when the path in use reaches nothing,
   * the alternatives are tested so that standing reflects which of them can
   * take over, and that is the list of them.
   */
  priority(): PathName[] {
    return this.order();
  }

  /**
   * The path carrying traffic and the interface it is on, in one reading.
   *
   * One call rather than two so that the watch judges a single moment: a
   * device name fetched after a separate reading of which path is in use can
   * belong to a path that is no longer the one in use.
   *
   * Standing is folded in here, not only in `state()`. The watch reads the
   * counters of whatever this names and probes it when they stop moving, so
   * naming a demoted path made a working board pay a `curl` per path per tick
   * for as long as the dead cable stayed plugged in — see `activePath`.
   */
  async inUseNow(): Promise<{ path: PathName; device: string } | null> {
    // Independent and taken together. In production `holding()` needs the
    // same device observation to attribute addresses to paths; the
    // observation runner shares that pending command, so this is one device
    // snapshot rather than a second subprocess after the first settles.
    const [holding, devices] = await Promise.all([this.holding(), this.devices()]);
    const path = await this.observedPath(devices, holding);
    if (path === null) return null;
    const device = devices[path];
    return device === undefined ? null : { path, device };
  }

  private async observedPath(devices: Partial<Record<PathName, string>>, holding: PathName[]): Promise<PathName | null> {
    if (!this.routeDevice) return activePath(holding, this.standing);
    const device = await this.routeDevice();
    return ALL_PATHS.find(path => devices[path] === device) ?? null;
  }

  /**
   * Fold in evidence that cost nothing: traffic moved both ways on this path.
   *
   * The counters are maintained by the kernel whether or not anything reads
   * them, so a working device establishes that it is working without sending
   * a byte of its own (R-CEL-09). This is how a path returns from being stood
   * down without a probe ever running.
   */
  carried(path: PathName): void {
    this.standing.record(path, true);
  }

  /**
   * The same answer, about a reading already taken. See carrying().
   *
   * **Three states, not two.** "Not stood down" is not "working": it also
   * covers a path that has failed twice of the three that condemn it, and a
   * path nothing has ever probed. Deferring to either of those is how a board
   * with a dead LAN and a modem on a wrong APN answered "something is
   * carrying traffic" at the fallback deadline — and that deadline is checked
   * exactly once, so the answer was final and the board stayed unreachable
   * (K-42, by a different route than the one this milestone closed).
   *
   * So evidence may overturn the address test only where there is evidence:
   *
   *  - **Any path reaching something** — true, and the reason this asks about
   *    every path rather than the top one. A dead Ethernet outranking a
   *    working Wi-Fi client link must not raise an access point on the one
   *    radio the operator is talking over.
   *  - **Every path failing** — false, and the access point comes up. Being
   *    part-way to condemned is still evidence against.
   *  - **Otherwise** — true. Nothing has been probed yet, so there is nothing
   *    to overturn the answer an address alone has always given (see
   *    `FallbackWatchdogOptions.carrying`). Raising the access point on a
   *    working single-radio board because the watch has not got round to its
   *    first probe would trade one unreachable device for another.
   */
  private carryingOn(holding: PathName[]): boolean {
    // Addresses on things this monitor has no path for — a USB gadget, a
    // connection an operator added by hand. Not this check's to condemn.
    if (holding.length === 0) return true;
    const evidence = holding.map((path) => this.standing.evidenceFor(path));
    if (evidence.includes("reaching")) return true;
    return !evidence.every((e) => e === "not-reaching");
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
   *
   * **And a path standing by only says it is ready if something established
   * that it is.** "Ready" is a claim about reachability, and `standing-by`
   * covers three quite different situations: a path whose last probe reached
   * something, a path whose probes are failing but which has not yet run out
   * the three that condemn it, and a path nothing has ever looked at. This is
   * the same distinction `evidenceFor` draws for the fallback watchdog —
   * *not yet condemned* is not *working* — arriving at the display layer,
   * and it is the half of the observed defect an operator actually reads: a
   * modem re-dialled onto a wrong APN, untested, describing itself as ready.
   *
   * The record carries that distinction as `evidence` as well as in the
   * sentence, so a console can draw the three states without reading prose.
   *
   * **And a path only says it is up if it is.** `standing-by` used to be
   * reached by any path with an interface, so a board with an ethernet port
   * and no cable — NetworkManager reporting it `unavailable`, no carrier, no
   * address — described itself as "Up, and not yet tested". Its condition was
   * not unknown; it was known and unavailable, which is what `down` says now
   * (R-NET-14). Three conditions that were two: no interface, an interface
   * that is not up, and an interface that is up and untested.
   */
  private report(
    path: PathName,
    device: string | null,
    inUse: PathName | null,
    down: boolean,
  ): PathReport {
    const word = PATH_WORDS[path];

    // Read once, and the only reading in this method. Both `evidence` and the
    // sentence in `detail` come from this one value, so the field a console
    // reads and the sentence an operator reads cannot drift apart — which is
    // what they would do the first time somebody worked one of them out a
    // second way.
    //
    // A path with no interface has no evidence about it, whatever a record
    // left over from before it was unplugged still says: `test()` never
    // records against a path it cannot find, and a success from before the
    // modem was pulled is not evidence about a board that no longer has one.
    //
    // A path whose interface is down is in the same position for the same
    // reason: a success recorded while the cable was in says nothing about a
    // port that now has no carrier.
    const evidence: PathEvidence =
      device === null || down ? "untested" : this.standing.evidenceFor(path);

    if (device === null) {
      return { path, device: null, standing: "absent", since: null, evidence,
        detail: `No ${word} interface on this board` };
    }
    // Before every question about reaching anything, because none of them
    // applies: an interface that is not up is not carrying traffic, is not
    // standing by, and has not been tested. It is not a fault either — an
    // aircraft flies with its ethernet unplugged — so this says what is true
    // and stops (R-NET-14).
    if (down) {
      return { path, device, standing: "down", since: null, evidence,
        detail: "Down — the interface is there and it has no connection on it" };
    }
    if (this.standing.standingOf(path) === "no-route-out") {
      return { path, device, standing: "no-route-out", since: this.standing.since(path), evidence,
        detail: "Reached nothing when tested and has been stood down" };
    }
    if (inUse === path) {
      return { path, device, standing: "in-use", since: null, evidence, detail: "Carrying traffic" };
    }
    return { path, device, standing: "standing-by", since: null, evidence,
      detail: standingByDetail(evidence, word) };
  }
}

/**
 * What a path that is up but not carrying traffic says about itself.
 *
 * Three answers, because there are three states and only one of them is
 * "ready". Yonder does not report the indicators and leave the operator to
 * conclude (R-CEL-09), and it does not claim a link works on the strength of
 * nobody having shown that it does not.
 */
function standingByDetail(evidence: PathEvidence, word: string): string {
  // Every branch here is about a path that is **up**. A path whose interface
  // is not up never reaches this function — see the `down` branch in
  // `report` — which is what makes "Up, and not yet tested" true again.

  switch (evidence) {
    case "reaching":
      return `Ready — traffic is not going out over ${word}`;
    case "not-reaching":
      return "Reached nothing when it was last tested, and is still in the running";
    // Not "ready". Nothing has sent a packet over this path, so nothing can
    // say whether one would arrive — which is the whole of what a wrong APN
    // looks like from here.
    case "untested":
      return "Up, and not yet tested — nothing has established that it reaches anything";
  }
}

/**
 * Which interface each path **carries traffic on**, from NetworkManager's own
 * device list and, for a modem, from what ModemManager says its data port is.
 *
 * Pure, and separate from the monitor, so the mapping is testable without an
 * nmcli and so `daemon/server.ts` stays wiring rather than a second place
 * that decides what a modem is.
 *
 * **A modem has two names and neither is right for both questions.** The
 * measured board binds its connection to the control port `cdc-wdm0`, which
 * is what NetworkManager lists and reports state for — and which has no
 * entry under `/sys/class/net` at all. `wwan0` is what holds the address and
 * carries every byte. This map is used to probe an interface and to read its
 * byte counters, so it is the *net* port that belongs in it: probing
 * `cdc-wdm0` fails on a perfectly good link, and three of those stand a
 * working modem down. `modemNet` is that name, from ModemManager, which is
 * the only thing that knows it; without it this falls back to the device
 * NetworkManager lists, which is better than nothing on a board where the
 * two coincide.
 *
 * A path that is absent here is a path with no interface, and the monitor
 * reports it as absent rather than probing it.
 */
export function pathDevices(
  config: Config,
  devices: DeviceInfo[],
  modemNet: string | null = null,
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
    // An appliance is already named as the adapter it is, and that adapter
    // is where its bytes go — there is no second name to reconcile.
    const device = modem.mode === "appliance"
      ? modem.interface
      : modemNet ?? devices.find((d) => d.type === "gsm")?.device ?? null;
    if (device !== null && device !== "") found.modem = device;
  }

  return found;
}

/**
 * The device states NetworkManager reports for an interface that is not up.
 *
 * A list of what is recognised, rather than "anything that is not
 * `connected`", and the difference is the whole of the safety here. A state
 * word this does not know — a NetworkManager that grew one, an nmcli
 * answering in a language nobody here read — leaves a path exactly where it
 * was. Being wrong in that direction costs the old sentence; being wrong the
 * other way would print `DOWN` beside a working ethernet port.
 *
 * Two words, and each is chosen because it is unambiguous. `unavailable` is
 * a device that cannot carry a connection — no carrier, rfkilled, no SIM — and
 * is what a real board reported for an `eth0` with nothing plugged into it.
 * `disconnected` is a device that could and has none.
 *
 * Three words are deliberately not here. `connecting` and `deactivating` are
 * transitions rather than conditions, and an interface caught mid-dial is not
 * a port with no cable in it. `unmanaged` is a device NetworkManager is not
 * looking after, which says nothing about whether it works — an address
 * configured outside NetworkManager is still an address — so it is left
 * exactly where it was rather than being described from a tool that has
 * disclaimed it.
 */
const NOT_UP = ["unavailable", "disconnected"];

/**
 * Which paths have an interface that is present and not up (R-NET-14).
 *
 * Pure, and separate from the monitor for the same reason `pathDevices` is:
 * the decision about what NetworkManager's words mean is testable without an
 * nmcli, and `daemon/server.ts` stays wiring.
 *
 * **A path is named here only on positive evidence.** It has to have an
 * interface, that interface has to be one NetworkManager lists, and the state
 * it lists has to be one of `NOT_UP`. A path whose interface NetworkManager
 * does not list at all is not called down — it is not established either way,
 * and this file does not invent the difference.
 *
 * `alsoKnownAs` is the second name a path answers to, exactly as in
 * `pathsHolding`: a modem carries its bytes on `wwan0`, which NetworkManager
 * has no entry for, while the connection is bound to the control port
 * `cdc-wdm0`, which is the one it reports a state for. Looking up only the
 * first name would find nothing, and a working modem would be reported down
 * on every board where the two differ — which is every board this was
 * measured on. Either name being connected is enough.
 */
export function pathsDown(
  devices: DeviceInfo[],
  found: Partial<Record<PathName, string>>,
  alsoKnownAs: Partial<Record<PathName, string>> = {},
): PathName[] {
  const stateOf = (device: string | undefined): string | undefined =>
    device === undefined ? undefined : devices.find((d) => d.device === device)?.state;

  const out: PathName[] = [];
  for (const path of Object.keys(found) as PathName[]) {
    const states = [stateOf(found[path]), stateOf(alsoKnownAs[path])]
      .filter((s): s is string => s !== undefined);
    if (states.length === 0) continue;
    if (states.some((s) => !NOT_UP.includes(s))) continue;
    out.push(path);
  }
  return out;
}

/**
 * Every path holding an address, in the operator's order.
 *
 * The whole list rather than only the head, because two different questions
 * are asked of it. The watch judges *the path in use*, which is the head. The
 * fallback watchdog asks whether **some** path is carrying traffic, and
 * answering that from the head alone reads a dead Ethernet as a board with no
 * way out while a working Wi-Fi client link sits beside it — then raises an
 * access point on the one radio and drops the connection the operator is on.
 *
 * The access point's own address never counts. It is how an operator reaches
 * a device that has no way out, and counting it as a way out is how a board
 * reports itself healthy while sitting on its own fallback.
 *
 * `alsoKnownAs` is the second name a path can appear under — for a modem, the
 * control port NetworkManager lists, against the data port that holds the
 * address. Which of the two an address arrives under depends on which tool
 * was asked, so both are accepted here rather than guessing; anywhere that
 * has to *act* on an interface uses the one `pathDevices` gives.
 */
export function pathsHolding(
  order: PathName[],
  devices: Partial<Record<PathName, string>>,
  addresses: { device: string; address: string }[],
  apAddress: string,
  alsoKnownAs: Partial<Record<PathName, string>> = {},
): PathName[] {
  const holds = (device: string | undefined): boolean =>
    device !== undefined && addresses.some((a) =>
      a.device === device
      && a.device !== "lo"
      && !a.address.startsWith("127.")
      && a.address.split("/")[0] !== apAddress);

  return order.filter((path) => holds(devices[path]) || holds(alsoKnownAs[path]));
}

/**
 * Which of the paths holding an address is carrying the default route.
 *
 * Derived rather than read out of a routing table, because the metrics that
 * decide it are *generated* here: `metricFor` gives each path a number from
 * its rank in `network.priority`, and adds `STOOD_DOWN_METRIC` to it while the
 * path is stood down. So the path with the lowest metric — the one the kernel
 * picks — is the first path in the operator's order that is not stood down,
 * and this is that same arithmetic read back.
 *
 * **Standing has to be in it.** Without it this was `holding[0]`, and the head
 * of that list is exactly the path traffic has moved *off*: `remetric` raises
 * a demoted path's metric and takes nothing down, deliberately, so that an
 * operator sitting on a stood-down ethernet cable is not cut off. The address
 * stays, the path stays at the head of the order, and reading the head named
 * a dead cable as the one carrying traffic for as long as it was plugged in.
 *
 * **And when every path holding an address is stood down, the head is still
 * the answer.** `STOOD_DOWN_METRIC` is *added* rather than substituted, so
 * condemned paths keep their order relative to each other and the route stays
 * on the first of them. Answering null there would be wrong about the routing
 * table, and it would cost more than a word: the watch would stop looking at
 * that path, so nothing would probe it, so `SUCCESSES_TO_RETURN` could never
 * be reached and a board whose only link is bad would never notice it had
 * come good.
 *
 * Pure, and separate from the monitor, for the reason everything else in this
 * file is: the decision is testable without an nmcli.
 */
export function activePath(holding: PathName[], standing: StandingView): PathName | null {
  return holding.find((path) => !standing.isStoodDown(path)) ?? holding[0] ?? null;
}

/**
 * The path traffic is leaving by, from a reading of the addresses.
 *
 * `pathsHolding` and `activePath` in one call, for a caller that has the
 * addresses rather than the list. The standing defaults to a board where
 * nothing has been stood down — the same default `metricFor` takes, and for
 * the same reason: a caller that does not know about standing gets exactly
 * the answer `network.priority` alone has always given.
 */
export function pathInUse(
  order: PathName[],
  devices: Partial<Record<PathName, string>>,
  addresses: { device: string; address: string }[],
  apAddress: string,
  alsoKnownAs: Partial<Record<PathName, string>> = {},
  standing: StandingView = NOTHING_STOOD_DOWN,
): PathName | null {
  return activePath(pathsHolding(order, devices, addresses, apAddress, alsoKnownAs), standing);
}
