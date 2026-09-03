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
  formatDb,
  formatDbm,
  formatTechnology,
  pathDetail,
  pathStatus,
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
 * otherwise is the mistake K-40 is about — a modem re-dialled onto a wrong
 * APN, untested, lighting up as ready.
 */
function pathTone(standing: PathStanding, evidence: PathEvidence): "good" | "bad" | "neutral" {
  // A path that is not on this board is not a fault. Asked before evidence,
  // because an absent path has none either way.
  if (standing === "absent") return "neutral";
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
  /** Every port with its kind, as the modem came up (R-CEL-03). */
  ports: string[];
  /** The same list as one line, so no flow has to join an array. */
  portSummary: string | null;
  /**
   * Whether this kind of modem reports signal at all (R-CEL-11).
   *
   * False is not "no signal": it is an appliance modem, which keeps operator,
   * technology and signal behind its own interface. The page says so in words
   * rather than drawing four dashes, which read as a fault.
   */
  reportsSignal: boolean;
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
  /** True while some path is carrying traffic. The watchdog's question (K-40). */
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
  // absence of it (K-40, R-NET-07). A route that reaches nothing is not a
  // way the device is reachable.
  const reachableBy =
    !reach.carrying || reach.inUse === null ? "NOTHING" : pathName(reach.inUse).toUpperCase();

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
      ports: modem.ports,
      portSummary: modem.ports.length === 0 ? null : modem.ports.join(" · "),
      reportsSignal: modem.reportsSignal,
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
        ports: payload.ports,
        portSummary: payload.portSummary,
        reportsSignal: payload.reportsSignal,
      },
    },
    // 2 — the signal readings: strings for the databar at the top level,
    // numbers and scales beside them for the gauges.
    {
      payload: {
        ...payload.signal,
        gauges: payload.gauges,
        bounds: payload.bounds,
        reportsSignal: payload.reportsSignal,
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
    // 4 — the Status panel: one word, and the same verdict the tab shows, so
    // the two pages cannot disagree about the modem.
    {
      payload: {
        reachableBy: payload.reachableBy,
        carrying: payload.carrying,
        verdict: payload.verdict,
        summary: payload.summary,
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
      const reject = (message: string): void => {
        node.status({ fill: "red", shape: "ring", text: "not answering" });
        const rejected: NodeMessage = { payload: null, yonder: readFailure(message, Date.now()) };
        send([rejected, rejected, rejected, rejected]);
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
