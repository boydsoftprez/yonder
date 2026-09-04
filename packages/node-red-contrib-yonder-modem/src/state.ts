// SPDX-License-Identifier: GPL-3.0-or-later
import { PATH_WORDS, clientFor, fetched, pollIntervalMs, readFailure } from "yonder-core";
import type {
  CommandStatus,
  DaemonClient,
  ModemState,
  PathEvidence,
  PathName,
  PathReport,
  PathStanding,
  ReachState,
  ReadingBounds,
} from "yonder-core";
import type { NodeMessage, RED, RedNode } from "./red.js";
import {
  QUALITY_BOUNDS,
  SIGNAL_BOUNDS,
  cannotTell,
  composition,
  formatDb,
  formatDbm,
  formatTechnology,
  pathDetail,
  pathStatus,
  reachStatus,
  reachWhy,
  verdict,
  verdictStatus,
} from "./format.js";

/**
 * What a path is called at the top of a row an operator reads.
 *
 * Derived from `PATH_WORDS` rather than written out again, because a second
 * table of operator-facing names is the one that stops matching the first —
 * the daemon's log lines and this console's rows have to call the same
 * interface the same thing. `PATH_WORDS` is written for the middle of a
 * sentence ("testing cellular on wwan0"); a row heading is the same word with
 * its first letter raised, which is why this is a transformation and not a
 * second list. "Wi-Fi" is already capitalised and survives unchanged.
 */
function pathName(path: PathName): string {
  const word = PATH_WORDS[path];
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The lamp beside a Way out row (R-UI-11).
 *
 * Three answers, because the panel exists to draw three states. `standing`
 * alone cannot give them: `standing-by` covers a path that is reaching
 * something, one whose probes are failing but which has not run out the three
 * that condemn it, and one nothing has ever looked at — so this asks
 * `evidence`, which the daemon fills from the same reading of `Standing` that
 * writes the row's sentence.
 *
 * An untested path is neutral and never good. Nothing has established that it
 * reaches anything, and a green lamp on the strength of nobody having shown
 * otherwise is the mistake K-42 is about — a modem re-dialled onto a wrong
 * APN, untested, lighting up as ready.
 */
function pathTone(standing: PathStanding, evidence: PathEvidence): "good" | "bad" | "neutral" {
  // A path that is not on this board is not a fault. Asked before evidence,
  // because an absent path has none either way.
  if (standing === "absent") return "neutral";
  // Also neutral, and for the same reason: an aircraft flies with its
  // ethernet unplugged. A path that is not up is a known condition, not a
  // fault, and a red lamp on every flight would teach an operator to ignore
  // the row (R-NET-14).
  if (standing === "down") return "neutral";
  if (standing === "no-route-out") return "bad";
  if (evidence === "reaching") return "good";
  if (evidence === "not-reaching") return "bad";
  // Untested, including the path currently holding the default route: holding
  // it is not evidence that anything completes over it, which is the whole of
  // what a wrong APN looks like from here (R-CEL-09).
  return "neutral";
}

/** One row of the Way out panel, with nothing left for a flow to work out. */
export interface PathRow {
  /** The configuration's key, for anything that has to match one. */
  path: PathName;
  /** Yonder's word for it: `Ethernet`, `Cellular`, `Wi-Fi`. */
  name: string;
  device: string | null;
  standing: PathStanding;
  /**
   * What is actually known about this path, as evidence and not as prose.
   *
   * Carried through to the page as well as used for `tone`, so an instrument
   * that wants to say something the lamp cannot has the fact rather than a
   * sentence to match against.
   */
  evidence: PathEvidence;
  /** True for the one path traffic is actually leaving by. */
  inUse: boolean;
  /** When it was stood down, epoch ms; null when it has not been. */
  since: number | null;
  detail: string;
  tone: "good" | "bad" | "neutral";
}

/**
 * A row as the panel receives it: everything in `PathRow`, and the lamp.
 *
 * `status` is not on `PathRow` itself because `messageFor` is pure and takes
 * no clock — a `CommandStatus` carries `at`, and inventing one inside a pure
 * shaping function is how a test starts depending on the wall clock.
 */
export interface ShownPathRow extends PathRow {
  status: CommandStatus;
}

/**
 * A row for a panel whose tick failed: a name, a lamp and a sentence, and
 * nothing that pretends to be a reading.
 *
 * It is a narrower type than `ShownPathRow` on purpose. A failed read knows
 * no standing, no evidence and no device, and inventing plausible values for
 * those so the shapes matched would put fiction where the panel expects fact.
 * The three fields here are the three the row draws.
 */
export interface UnreadablePathRow {
  path: PathName;
  name: string;
  detail: string;
  status: CommandStatus;
}

/**
 * Every path, saying that nothing can be told about it (R-UI-05).
 *
 * When a tick fails there is no list of paths to pick a row out of, and a
 * `change` node picking from nothing removes `msg.yonder` — which drops each
 * lamp to the shared idle label `Ready`, in grey, at the one moment an
 * operator most needs the word to be true.
 *
 * The rows are rebuilt here rather than the flow being taught a conditional,
 * because "if the daemon did not answer, say this instead" is a decision, and
 * a decision serialised beside wire coordinates cannot be reviewed
 * (CLAUDE.md rule 2). It is also the only fix that leaves the row's *name*
 * on screen: a panel of three blank rows with three red lamps says less than
 * three named paths that each say why they are blank.
 *
 * The path list comes from `PATH_WORDS` rather than from a second list
 * written here — the same reason `pathName` derives its words from it.
 * Naming a path is not a claim that this board has one; the whole message is
 * that nothing is known either way.
 */
export function unreadableRows(message: string, at: number): UnreadablePathRow[] {
  return (Object.keys(PATH_WORDS) as PathName[]).map((path) => ({
    path,
    name: pathName(path),
    detail: message,
    status: cannotTell(at),
  }));
}

export interface StatePayload {
  mode: ModemState["mode"];
  summary: string;
  operator: string | null;
  /** The radio technology as it is shown — `LTE`, not `lte`. See formatTechnology. */
  technology: string | null;
  registration: string | null;
  apn: string | null;
  address: string | null;
  mtu: number | null;
  /**
   * Which mode the modem came up in — `MBIM`, `QMI` — or null (R-CEL-03).
   *
   * This is the fact `COMPOSITION` shows, and `ports` below is not. See
   * `composition` in format.ts for what the port list did to that cell.
   */
  composition: string | null;
  /**
   * Every port with its kind, as the modem came up.
   *
   * Diagnostic detail, and deliberately still carried: it is the raw material
   * `composition` is read from, and the thing to look at when a modem came up
   * in an arrangement nobody expected. It is not a fact cell on a page an
   * operator glances at.
   */
  ports: string[];
  /** The same list as one line, so nothing reading it has to join an array. */
  portSummary: string | null;
  /**
   * Whether this kind of modem reports signal at all (R-CEL-11).
   *
   * False is not "no signal": it is an appliance modem, which keeps operator,
   * technology and signal behind its own interface. The page says so in words
   * rather than drawing four dashes, which read as a fault.
   */
  reportsSignal: boolean;
  /**
   * Whether there is a signal reading to draw at all (R-UI-05).
   *
   * **Not the same question as `reportsSignal`, and this is why both exist.**
   * `reportsSignal` is a property of the *kind* of modem — false only for an
   * appliance, which keeps its radio behind its own interface. A board with
   * no modem in it at all has no kind, so `reportsSignal` there is true, and
   * a panel that hid its gauges on that field alone would draw two empty
   * gauges on exactly the board the design says must not have any.
   *
   * A gauge with no needle reads as a fault, and *there is no modem* is not a
   * fault. So the Status panel asks this, which is both: a modem that can
   * report a signal, and a modem that is there.
   */
  showsSignal: boolean;
  /** The one line at the top of the Cellular tab, already judged. */
  verdict: { text: string; tone: "good" | "bad" | "neutral" };
  /** The readings as a databar shows them: a number and its unit, or an em dash. */
  signal: { strength: string; quality: string; rssi: string; rsrq: string };
  /**
   * The same two readings as bare numbers, for the gauges.
   *
   * Not redundant with `signal` above, and this is the reason both exist: a
   * gauge places a pointer, which needs a number, and a databar prints a
   * fact, which needs the unit with it. Deriving either from the other would
   * mean a `function` node in a flow, which CLAUDE.md rule 2 forbids — so
   * both are computed here, once, from the same reading.
   *
   * `null`, never 0, for a reading that was not taken: 0 dBm is a real and
   * extraordinary value, and the gauge draws `null` as absent (R-UI-05).
   */
  gauges: { strength: number | null; quality: number | null };
  /** The scales those gauges are drawn against (R-UI-09). */
  bounds: { strength: ReadingBounds; quality: ReadingBounds };
  /** Every path this board knows, in the operator's order. */
  paths: PathRow[];
  /**
   * One word for the Status panel: `ETHERNET`, `CELLULAR`, `WI-FI`, `NOTHING`.
   */
  reachableBy: string;
  /**
   * Whether a named path is actually carrying traffic — the fact
   * `reachableBy` was chosen from, carried so that the lamp beside the word
   * is lit from the same reading the word came out of.
   *
   * **Not `carrying`.** That one is the watchdog's question and is
   * deliberately optimistic: it answers true when nothing holds an address at
   * all, because an address on an interface the monitor has no path for is
   * not its to condemn. Lighting the lamp from it drew a green `NOTHING`.
   */
  reachable: boolean;
  /** What changed and when, for the line under that word. See `reachWhy`. */
  why: string;
  /** True while some path is carrying traffic. The watchdog's question (K-42). */
  carrying: boolean;
}

/**
 * Both routes, read once, shaped into everything three surfaces need.
 *
 * Pure, and exported for that reason: every judgement the Cellular tab, the
 * Way out panel and the Status panel make is taken here, where it is tested
 * without a Node-RED and without a daemon. The node below carries the answer
 * and decides nothing.
 *
 * No threshold and no unit is worked out in this file. `SIGNAL_BOUNDS`,
 * `QUALITY_BOUNDS`, `formatDbm`, `formatDb`, `verdict` and `pathDetail` all
 * come from `format.ts`, so a scale changed there changes everywhere at once.
 */
export function messageFor(modem: ModemState, reach: ReachState): { payload: StatePayload } {
  // RSRP and SINR, named rather than chosen at display time. There is
  // deliberately no fallback to RSSI when RSRP is absent: the gauge is drawn
  // against SIGNAL_BOUNDS, and quietly substituting a different quantity
  // behind the same scale is how a reading stops meaning what it says.
  const strength = modem.signal.rsrp;
  const quality = modem.signal.snr;

  const paths: PathRow[] = reach.paths.map((p: PathReport) => ({
    path: p.path,
    name: pathName(p.path),
    device: p.device,
    standing: p.standing,
    evidence: p.evidence,
    inUse: p.path === reach.inUse,
    since: p.since,
    detail: pathDetail(p),
    tone: pathTone(p.standing, p.evidence),
  }));

  // The in-use path's name, in the one word the Status panel has room for.
  //
  // `carrying` false is taken as NOTHING even when a path still holds the
  // default route, because `carrying` is deliberately optimistic — the
  // monitor answers true on every doubt, so false is evidence rather than
  // absence of it (K-42, R-NET-07). A route that reaches nothing is not a
  // way the device is reachable.
  //
  // One expression, two fields. The lamp on Status is lit from `reachable`
  // and the word is chosen from it, so they cannot disagree — which they did:
  // lighting the lamp from `carrying` alone put a green lamp on the word
  // NOTHING, because `carrying` is also true when no path holds an address.
  const reachable = reach.carrying && reach.inUse !== null;
  const reachableBy = reachable ? pathName(reach.inUse as PathName).toUpperCase() : "NOTHING";

  return {
    payload: {
      mode: modem.mode,
      summary: modem.summary,
      operator: modem.operator,
      technology: formatTechnology(modem.technology),
      registration: modem.registration,
      apn: modem.apn,
      address: modem.address,
      mtu: modem.mtu,
      composition: composition(modem.ports),
      ports: modem.ports,
      portSummary: modem.ports.length === 0 ? null : modem.ports.join(" · "),
      reportsSignal: modem.reportsSignal,
      // See `showsSignal` above. `mode` is the only field that says whether
      // there is a modem at all; `reportsSignal` says what kind it is.
      showsSignal: modem.reportsSignal && modem.mode !== "absent",
      verdict: verdict(reach),
      signal: {
        strength: formatDbm(strength),
        quality: formatDb(quality),
        rssi: formatDbm(modem.signal.rssi),
        rsrq: formatDb(modem.signal.rsrq),
      },
      gauges: { strength, quality },
      bounds: { strength: SIGNAL_BOUNDS, quality: QUALITY_BOUNDS },
      paths,
      reachableBy,
      reachable,
      why: reachWhy(paths),
      carrying: reach.carrying,
    },
  };
}

/**
 * One reading, split across the four outputs.
 *
 * The split is here and not in a flow for the same reason the shaping is: a
 * `switch` or a `change` node deciding which fields belong to which surface
 * is logic serialised into `flows.json`. Each output carries a payload its
 * widgets can key straight off — a databar names keys in the object it is
 * given, so the signal output's strings sit at the top level of output 2
 * rather than nested one deeper.
 */
export function fanOut(payload: StatePayload, at: number = Date.now()): NodeMessage[] {
  return [
    // 1 — the Cellular tab: what the modem is and what it is doing.
    //
    // The verdict travels twice, and both are used: as `{ text, tone }` in the
    // payload for anything that wants the words, and on `msg.yonder` as a
    // `CommandStatus` for `ui-yonder-annunciator`, which renders that shape
    // and only that shape. The alternative was a `change` node in the flows
    // mapping one to the other, which is a decision serialised beside wire
    // coordinates (CLAUDE.md rule 2).
    {
      yonder: verdictStatus(payload.verdict, at),
      payload: {
        mode: payload.mode,
        summary: payload.summary,
        verdict: payload.verdict,
        operator: payload.operator,
        technology: payload.technology,
        registration: payload.registration,
        apn: payload.apn,
        address: payload.address,
        mtu: payload.mtu,
        composition: payload.composition,
        ports: payload.ports,
        portSummary: payload.portSummary,
        reportsSignal: payload.reportsSignal,
      },
    },
    // 2 — the signal readings: strings for the databar at the top level,
    // numbers and scales beside them for the gauges.
    //
    // `showsSignal` travels with them for the same reason it travels on
    // output 4: the Cellular tab's gauges are *absent* on a board with no
    // modem rather than empty. This output carried only `reportsSignal` when
    // the tab was built, which is a property of the kind of modem and true on
    // a board that has none — so the tab drew two gauge tracks with their
    // bands and no needle beside a `NO MODEM` lamp. A gauge with no needle
    // reads as a fault, and there being no modem is not one.
    {
      payload: {
        ...payload.signal,
        gauges: payload.gauges,
        bounds: payload.bounds,
        reportsSignal: payload.reportsSignal,
        showsSignal: payload.showsSignal,
      },
    },
    // 3 — the Way out panel: one row per path, in the operator's order, each
    // carrying the lamp beside it already lit.
    //
    // The status is attached here rather than in `messageFor` because it
    // needs `at`, and here rather than in a `change` node because turning a
    // tone into a command state is a decision (CLAUDE.md rule 2). A flow
    // picks one row and hands the widgets its fields; it works nothing out.
    { payload: payload.paths.map((p) => ({ ...p, status: pathStatus(p, at) })) },
    // 4 — the Status panel: one word, the facts that identify it, and the
    // same readings the Cellular tab draws, so the two pages cannot disagree
    // about one modem.
    //
    // `Reachable by` is built in the idiom of `This board` — gauges over a
    // labelled strip — so it needs what a strip prints (`operator`,
    // `technology`, `address`, already formatted) and what a gauge places
    // (`gauges`, `bounds`, bare numbers). Both are taken from the fields
    // above rather than recomputed: one reading, shown twice.
    //
    // `showsSignal` travels with them because the gauges are *absent* on a
    // board with no modem rather than empty, and a flow binding a widget's
    // `visible` to a field is a wire; working out which field that should be
    // is a decision, and it is taken in `messageFor`.
    {
      yonder: reachStatus(payload.reachableBy, payload.reachable, at),
      payload: {
        reachableBy: payload.reachableBy,
        reachable: payload.reachable,
        carrying: payload.carrying,
        why: payload.why,
        verdict: payload.verdict,
        summary: payload.summary,
        operator: payload.operator,
        technology: payload.technology,
        address: payload.address,
        gauges: payload.gauges,
        bounds: payload.bounds,
        reportsSignal: payload.reportsSignal,
        showsSignal: payload.showsSignal,
      },
    },
  ];
}

interface StateNode extends RedNode {
  client: DaemonClient;
  intervalMs: number;
}

/**
 * `yonder-modem-state` — the cellular link, on every surface that shows it
 * (R-CEL-09, R-CEL-11, R-UI-05).
 *
 * **One node with four outputs, not four nodes.** Both routes are read once
 * per tick and fanned out, so the Cellular tab, the Way out panel and the
 * Status panel are always describing the same moment. Four nodes polling
 * separately would land on different ticks, and the first thing an operator
 * would see is a Status panel saying CELLULAR beside a Cellular tab that has
 * not noticed yet — the disagreement being the one thing they cannot check.
 *
 * A failed read is never a silent nothing. Both routes are asked together and
 * either one failing rejects the whole tick, on all four outputs, with a
 * `CommandStatus` in `msg.yonder`: a blank panel cannot be told from one that
 * never loaded, and only one of those needs acting on.
 *
 * `export default` rather than `export =`: this file also carries named
 * exports, and TypeScript does not allow the two forms together. Node-RED's
 * loader unwraps a `__esModule` default export, which is what
 * `esModuleInterop` produces here, so this registers the same way `export =`
 * does in the sibling packages.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-modem-state", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as StateNode;
    node.client = clientFor(RED.settings);
    node.intervalMs = pollIntervalMs(config.interval);

    const once = async (send: (m: NodeMessage[]) => void): Promise<void> => {
      // Together, not one after the other: two awaits in sequence would build
      // one record out of two different moments, which is the disagreement
      // this node exists to prevent.
      const [modemReply, reachReply] = await Promise.all([
        node.client.request({ method: "GET", path: "/modem/state" }),
        node.client.request({ method: "GET", path: "/reach/state" }),
      ]);
      const modem = fetched(modemReply);
      const reach = fetched(reachReply);

      // One tick is one answer, so a failure on either route rejects the
      // whole tick on all four outputs. Half a record would leave one surface
      // showing a reading from a moment the others never saw.
      //
      // Output 3 is the exception in shape and not in meaning. Its widgets
      // are picked out of a list by name, and a pick from a null payload
      // removes `msg.yonder` — which drops a `Way out` lamp to the shared
      // idle label `Ready`, in grey, on a tick where nothing is known at all.
      // So the rows are rebuilt saying so. See `unreadableRows`.
      const reject = (message: string): void => {
        node.status({ fill: "red", shape: "ring", text: "not answering" });
        const at = Date.now();
        const rejected: NodeMessage = { payload: null, yonder: readFailure(message, at) };
        const rows: NodeMessage = {
          payload: unreadableRows(message, at),
          yonder: readFailure(message, at),
        };
        send([rejected, rejected, rows, rejected]);
      };
      // The modem's message first when both failed: it names the thing the
      // operator was looking at.
      if (!modem.ok) { reject(modem.message); return; }
      if (!reach.ok) { reject(reach.message); return; }

      const shaped = messageFor(modem.value as ModemState, reach.value as ReachState);
      node.status({ fill: "green", shape: "dot", text: shaped.payload.mode });
      send(fanOut(shaped.payload, Date.now()));
    };

    // `void`, not `await`: this runs off a timer, and an unhandled rejection
    // in a Node-RED node takes the runtime down. `DaemonClient.request` never
    // rejects — asserted in yonder-core's client tests — so there is nothing
    // to catch here.
    const timer = setInterval(() => { void once((m) => { node.send(m); }); }, node.intervalMs);

    node.on("input", (_msg, send, done) => {
      void once(send).then(() => { done(); });
    });

    // A timer outliving its deployment is a node still asking a daemon
    // questions on behalf of a flow that no longer exists.
    node.on("close", (done) => {
      clearInterval(timer);
      done();
    });

    // One read immediately, so a page shows something before the first tick.
    void once((m) => { node.send(m); });
  });
}
