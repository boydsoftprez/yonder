// SPDX-License-Identifier: GPL-3.0-or-later
import { clientFor, fetched, readFailure, HEARTBEAT_STALE_MS } from "yonder-core";
import type { CommandState, DaemonClient, LinkState, MavlinkStateBody } from "yonder-core";
import type { RED, RedNode } from "./red.js";
import { formatBaud, formatKbRate, formatSeconds, formatSpan } from "./format.js";

/**
 * `yonder-mav-state` — the Telemetry page's live reading (R-MAV-10).
 *
 * `GET /mav/state` answers with `MavlinkStateBody` — `{ link, telemetryRunning,
 * routerRunning }` — not a bare `LinkState`. Everything in this file that can
 * be decided from `link` alone lives in `messageFor(state, now)`; everything
 * that also needs one of the two booleans is its own small function, because
 * `messageFor`'s signature is exactly `(state: LinkState, now?: number)` and
 * must stay that way. `stateMessage` at the bottom is what the node actually
 * calls: it combines all of them into the one payload the page receives, and
 * it is also what `yonder-mav-run` calls after start/stop/detect, since those
 * routes answer with the same `MavlinkStateBody` shape "reflecting the action
 * just taken".
 *
 * **No decision here that `yonder-core` has not already made.** `link.ts`
 * measured every field; this only says the words. Where a question needs
 * `telemetryRunning` specifically and not `routerRunning` (or the reverse),
 * that is because the two come apart exactly while telemetry is stopped —
 * see each function's own comment for which one it reads and why.
 */

/** `{state, message}` — the shape `ui-yonder-annunciator` reads off `msg.payload` (R-UI-11). */
export interface Annunciator {
  state: CommandState;
  message: string;
}

/** One place in the Status page's flow strip. A dashed, grey arrow when `absent`. */
export interface FlowPlace {
  label: string;
  detail: string;
  absent: boolean;
}

/**
 * One leg between two places. A dashed, grey arrow when `absent`.
 *
 * **`rate` is `null` whenever there is no figure to print, which is more
 * often than `absent`.** Every absent leg has a null rate, but so does a
 * present one whose rate is not known yet: `flowFor` yields `{ rate: null,
 * caption: "answering", absent: false }` for the whole of every telemetry
 * start, because `telemetryRunning` is true from the first reply while
 * `traffic` stays null until the router's own counters have been read twice.
 * That draws a dash on a solid arrow, which is right — the link is there and
 * the number is not — and it is what the strip does today. The comment here
 * used to claim the two were the same condition.
 */
export interface FlowLeg {
  rate: string | null;
  caption: string;
  absent: boolean;
}

export interface FlowStrip {
  from: FlowPlace;
  through: FlowPlace;
  to: FlowPlace;
  legs: [FlowLeg, FlowLeg];
}

/** The sparkline's payload (R-UI-09): the raw series, plus the ceiling and span already in words. */
export interface SparkPayload {
  series: { rx: number[]; tx: number[] };
  peak: string | null;
  span: string | null;
  known: boolean;
}

/** Three rows, always — the page has three ground-station slots whether or not all are configured. */
const GROUND_STATION_ROWS = 3;

/**
 * A count of things, in words, so no page has to pluralise.
 *
 * The same rule `mav/check.ts`'s own (private) `stations()` helper follows,
 * for client counts rather than ground stations.
 */
function count(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${String(n)} ${plural}`;
}

/** Presence is a recent arrival, independent of discovery and routing state. */
function hasHeartbeat(state: LinkState): boolean {
  return state.lastHeardMs !== null && state.lastHeardMs < HEARTBEAT_STALE_MS;
}

/**
 * One ground-station row, named by its position (0, 1, 2) rather than by
 * `state.groundStations[i].name`.
 *
 * The node carries no label of its own (Task 2 removed the rows' `ui-text`
 * labels when the router started attributing traffic per endpoint), so the
 * message is the whole caption and has to name the row — and the row an
 * operator reads is "the first ground-station field on the page", not
 * whatever free-text name they typed into `mavlink.endpoints[i].name`. `GCS
 * 0`/`GCS 1`/`GCS 2` is that position, not the configured name.
 *
 * `entry` is `undefined` both for a slot nothing has configured and for one
 * `LinkTracker` has not sampled yet — `mav/check.ts`'s own docstring makes
 * the same accepted approximation for the same reason: `LinkState.groundStations`
 * cannot tell the two apart, and only the configuration (which this route does
 * not carry) can. Both read as "not set", never as a cross.
 */
function groundStationRow(i: number, entry: LinkState["groundStations"][number] | undefined): Annunciator {
  const label = `GCS ${String(i)}`;
  if (entry === undefined) return { state: "idle", message: `${label} · not set` };
  if (entry.answering) return { state: "confirmed", message: `${label} · answering` };
  // Answered before and has gone quiet — a measurement about something that
  // used to work, not a fault reported as one.
  if (entry.lastHeardMs !== null) return { state: "pending", message: `${label} · silent` };
  return { state: "idle", message: `${label} · no reply` };
}

/**
 * The diagnosis band (R-MAV-13): what to check, in the two failure phases
 * that have something to check. `null` once linked, once stopped, and while
 * still searching — there is nothing to diagnose yet in any of those three.
 *
 * Not currently wired to a widget in `flows/flows.json` — the built page's
 * Autopilot group has no `.yonder-warning` row yet, only the six readings
 * `mock-tel-*` already covers. It is carried here anyway, because R-MAV-13
 * and the design's own mockups (`docs/console/design/telemetry/`) call for
 * it and this is where the words belong once a row exists to show them; a
 * field a flow does not yet read costs nothing sitting on the payload.
 */
function diagnosisFor(state: LinkState): string[] | null {
  if (state.phase === "silent") {
    if (state.triedBauds.length === 0) {
      return [`${state.device ?? "The serial port"} could not be opened.`];
    }
    const tried = state.triedBauds.map((b) => formatBaud(b) ?? String(b)).join(", ");
    return [
      "Nothing is transmitting on that wire.",
      `Tried ${tried}. No bytes arrived at any of them — not even malformed ones, `
      + "which is what a wrong speed looks like.",
      "Check pin 8 to the autopilot's RX, pin 10 to its TX, and a shared ground on "
      + "pin 6. A swapped pair looks exactly like this.",
    ];
  }
  if (state.phase === "noise") {
    return [
      "Something is transmitting, but it isn't MAVLink.",
      "Bytes arrived and none of them formed a valid frame. Something is reaching "
      + "the receive pin — its port may be set to another protocol, or to a rate "
      + "outside the ones tried, and a wiring fault that corrupts rather than "
      + "silences would look the same. Nothing here has exercised the transmit wire.",
      "Check its SERIALn_PROTOCOL and SERIALn_BAUD for whichever port you wired.",
    ];
  }
  return null;
}

/**
 * Everything the Telemetry page can read from `LinkState` alone.
 *
 * `now` is a parameter rather than a call to `Date.now()` in here, so a test
 * holds time still — the same reasoning `node-red-contrib-yonder-remote`'s
 * own `messageFor` gives. It is currently unused (nothing here ages by wall
 * clock the way the mesh tab's `lastHeard` does — a MAVLink reading is
 * already "milliseconds since the last heartbeat", not "milliseconds since
 * this sample was taken") but is kept on the signature because the plan
 * fixes it there and a later field may need it.
 */
export function messageFor(state: LinkState, _now: number = Date.now()): {
  payload: {
    port: string | null;
    speed: string | null;
    vehicle: string | null;
    vehicleShort: string | null;
    heartbeat: string | null;
    heard: string | null;
    answered: string | null;
    groundStations: Annunciator[];
    tcpClients: string;
    spark: SparkPayload;
    diagnosis: string[] | null;
  };
} {
  const baud = formatBaud(state.baud);
  const speed = baud === null ? null : `${baud} baud`;
  const vehicle = state.vehicle === null || state.system === null
    ? null
    : `${state.vehicle} · system ${String(state.system)}`;
  const vehicleShort = state.vehicle === null || state.system === null
    ? null
    : `${state.vehicle} · sys ${String(state.system)}`;
  const heartbeat = hasHeartbeat(state) && typeof state.heartbeatHz === "number" && Number.isFinite(state.heartbeatHz)
    ? `${state.heartbeatHz.toFixed(1)} Hz`
    : null;
  const heardSeconds = formatSeconds(state.lastHeardMs);
  const heard = heardSeconds === null ? null : `${heardSeconds} ago`;

  const groundStations = Array.from(
    { length: GROUND_STATION_ROWS },
    (_, i) => groundStationRow(i, state.groundStations[i]),
  );

  // "Last answered" now names the row (it replaced the rows' own `ui-text`
  // label), and it reads the past — the most recent reply on record — rather
  // than "who is answering right now", which the per-row annunciators above
  // already say. A row that has since gone quiet still answers this question.
  const heardFrom = state.groundStations
    .map((s, i) => ({ i, lastHeardMs: s.lastHeardMs }))
    .filter((s): s is { i: number; lastHeardMs: number } => s.lastHeardMs !== null)
    .sort((a, b) => a.lastHeardMs - b.lastHeardMs)[0];
  const answered = heardFrom === undefined
    ? "Nothing has answered yet"
    : `GCS ${String(heardFrom.i)} · ${String(formatSeconds(heardFrom.lastHeardMs))} ago`;

  const tcpClients = state.tcpClients === null ? "no clients" : count(state.tcpClients, "client", "clients");

  const spark: SparkPayload = state.traffic === null
    ? { series: { rx: [], tx: [] }, peak: null, span: null, known: false }
    : {
      series: { rx: state.traffic.rx, tx: state.traffic.tx },
      peak: formatKbRate(state.traffic.peak),
      // `windowMs` is the tracker's own retention window for this exact
      // reading, not a sample count times an assumed interval — the two
      // agree only if nothing has ever changed either constant, and reading
      // the field directly cannot drift from what actually produced this
      // series. (`LinkTracker`'s default is 5 s sampled every 2 s, so a real
      // series today is two or three points, nowhere near a span of
      // minutes — a question for whoever next widens the window, not
      // something to paper over here.)
      span: formatSpan(state.traffic.windowMs),
      known: true,
    };

  return {
    payload: {
      port: state.device,
      speed,
      vehicle,
      vehicleShort,
      heartbeat,
      heard,
      answered,
      groundStations,
      tcpClients,
      spark,
      diagnosis: diagnosisFor(state),
    },
  };
}

/**
 * The Autopilot panel's headline annunciator (`tel-ann-link`).
 *
 * Reads `routerRunning`, never `telemetryRunning`: this row is measured on
 * the loopback copy the router carries whether or not the ground stations
 * are being sent to (`mav/check.ts`'s `autopilotLink` makes the identical
 * choice, for the identical reason). `linked` and `stopped` read the same —
 * *Connected* while heartbeats are fresh, because stopping the broadcast
 * does not stop listening (R-MAV-09). A discovered port and a running router
 * alone cannot confirm that a GPIO lead is still attached. A remembered
 * link also cannot confirm presence while its router is not running.
 *
 * **`silent` shares `searching`'s waiting tone — it is not its own failure
 * state.** The captured mockup for this exact phase
 * (`docs/console/design/telemetry/telemetry-nothing-on-the-wire.html`) shows
 * the Link annunciator as `tone-waiting` / "Searching", with "Connected" and
 * "Not MAVLink" both hidden; the design spec's own list of the page's six
 * mutually exclusive states — linked, searching, not-MAVLink, stopped,
 * ingest open, a change pending — has no separate silent state either. A
 * sweep that heard nothing on the wire is still the sweep looking, from this
 * annunciator's point of view; what tells `silent` apart from `searching`
 * for an operator is the diagnosis panel underneath, which is where the
 * wiring case names pins 6, 8 and 10 (`diagnosisFor`, R-MAV-13) — `rejected`
 * here would paint a sweep still running as a fault the operator caused.
 *
 * A simpler, faster-glance question than `mav/check.ts`'s `pathCheck` — this
 * is a live reading refreshed on every poll, and the nuanced, on-demand
 * verification is exactly what the separate "Check the path" panel is for.
 */
export function linkFor(state: LinkState, routerRunning: boolean): Annunciator {
  if (state.phase === "searching" || state.phase === "silent") {
    return { state: "pending", message: "Searching" };
  }
  if (state.phase === "noise") return { state: "rejected", message: "Not MAVLink" };
  // linked or stopped.
  if (!routerRunning) return { state: "idle", message: "Not checked" };
  if (state.lastHeardMs === null) return { state: "pending", message: "Waiting" };
  if (!hasHeartbeat(state)) return { state: "pending", message: "No heartbeat" };
  return { state: "confirmed", message: "Connected" };
}

/**
 * The Ground stations panel's headline annunciator (`tel-ann-recv`).
 *
 * Aggregates the per-row measurement above: *answering* the moment any row
 * is, regardless of phase or the two booleans, because that is a fact no
 * other signal can override. Short of that it reads `telemetryRunning` —
 * not `routerRunning` — because "is anything being sent to ground stations"
 * is exactly what `telemetryRunning` means and `routerRunning` does not: a
 * link the tracker remembers while telemetry has not actually started
 * sending yet must not read as *nothing configured*, and must not read as
 * *answering* either.
 */
export function receivingFor(state: LinkState, telemetryRunning: boolean): Annunciator {
  if (state.groundStations.some((s) => s.answering)) return { state: "confirmed", message: "Answering" };
  if (state.phase === "stopped") return { state: "idle", message: "Not sending" };
  if (!telemetryRunning) return { state: "idle", message: "Nothing to send" };
  return { state: "idle", message: "Nothing has answered yet" };
}

/**
 * The rail's State annunciator (`tel-ann-state`) — R-MAV-09's own running
 * state, not the autopilot's.
 *
 * `telemetryRunning` decides it, with `phase` used only to choose the words
 * for "not running": *Stopped by you* when the operator's own stop put it
 * there (`phase === "stopped"` is `MavlinkRenderer`'s own overlay for
 * exactly that, and nothing else produces it), *Waiting* otherwise — no
 * link yet, or a link found but telemetry not yet started sending, which is
 * the same trap `linkFor` and `receivingFor` each name in their own words.
 */
export function runStateFor(state: LinkState, telemetryRunning: boolean): Annunciator {
  if (telemetryRunning) return { state: "confirmed", message: "Running" };
  if (state.phase === "stopped") return { state: "idle", message: "Stopped by you" };
  return { state: "pending", message: "Waiting" };
}

/** The Status page's compact Feed annunciator (`stat-ann-feed`) — `telemetryRunning`, in two words. */
export function feedFor(telemetryRunning: boolean): Annunciator {
  return telemetryRunning ? { state: "confirmed", message: "Flowing" } : { state: "idle", message: "Not flowing" };
}

/**
 * The Status page's flow strip (`stat-flow`): from the autopilot, through
 * Yonder, to the ground stations, each leg carrying its own rate.
 *
 * **The destination is named by count, not by address.** The built mock's
 * own example bakes in a ground station's host and port, but `LinkState`
 * carries neither — `mavlink.endpoints[i].host`/`.port` is configuration,
 * read by `yonder-mav-endpoints`, not by this route (the same boundary the
 * plan draws between `tel-atboot`/`tel-ingest` and `/mav/state`). Naming the
 * destination by how many ground stations are configured, from
 * `LinkState.groundStations.length`, is what this route can say honestly;
 * an address belongs to whoever joins this with the endpoints node's own
 * reading.
 *
 * "The first cell names what is missing, the arrows go dashed and grey, and
 * the legs read 'no heartbeat' and 'nothing to send'" — the design's own
 * words (§8), reused here rather than re-derived.
 */
export function flowFor(
  state: LinkState, telemetryRunning: boolean, routerRunning: boolean, _now: number = Date.now(),
): FlowStrip {
  const hasLink = state.phase === "linked" || state.phase === "stopped";
  const speed = formatBaud(state.baud);

  const from: FlowPlace = hasLink
    ? {
      label: state.vehicle ?? "Autopilot",
      detail: `${state.device ?? ""} · ${speed ?? "?"} baud`,
      absent: false,
    }
    : { label: "No autopilot", detail: linkFor(state, routerRunning).message, absent: true };

  // The built mock's own example reads "mavlink-router · up 16 min" — an
  // uptime `LinkState` has no field for and `MavlinkControl` does not expose
  // either, so it is not reproduced here rather than approximated. The same
  // honest-gap treatment as the destination's dropped address above.
  const through: FlowPlace = {
    label: "Yonder",
    detail: routerRunning ? "mavlink-router" : "mavlink-router not running",
    absent: false,
  };

  const stationCount = state.groundStations.length;
  const tcpDetail = state.tcpClients === null ? "no TCP clients" : count(state.tcpClients, "TCP client", "TCP clients");
  const to: FlowPlace = stationCount === 0
    ? { label: "No ground stations", detail: "None configured", absent: true }
    : { label: count(stationCount, "ground station", "ground stations"), detail: tcpDetail, absent: false };

  const heartbeatOk = routerRunning && hasHeartbeat(state);
  const heartbeatRate = typeof state.heartbeatHz === "number" && Number.isFinite(state.heartbeatHz)
    ? `${state.heartbeatHz.toFixed(1)} Hz`
    : null;
  const heartbeatLeg: FlowLeg = heartbeatOk
    ? { rate: heartbeatRate, caption: "heartbeat", absent: false }
    : { rate: null, caption: "no heartbeat", absent: true };

  // The peak across the window, deliberately — the same read
  // `mav/check.ts`'s own `outboundLink` takes of this identical
  // `traffic.tx` field, and for its stated reason: the router's KB figure
  // is a coarse integer, so a healthy slow link genuinely reads zero for
  // whole samples between movements (`link.ts` says so at length), and the
  // newest point alone would blink this leg between a rate and "nothing to
  // send" while telemetry is working. Reading the same field two different
  // ways in two widgets would be a second, disagreeing opinion about one
  // measurement — exactly what this package's own `check.ts` node refuses
  // to do by printing `pathCheck`'s sentence unchanged.
  const outboundKb = state.traffic === null || state.traffic.tx.length === 0
    ? null
    : Math.max(...state.traffic.tx);
  const outboundLeg: FlowLeg = telemetryRunning
    ? { rate: formatKbRate(outboundKb), caption: "answering", absent: false }
    : { rate: null, caption: "nothing to send", absent: true };

  return { from, through, to, legs: [heartbeatLeg, outboundLeg] };
}

/**
 * The one payload the node actually sends: `messageFor`'s state-only fields,
 * combined with the four booleans-dependent annunciators, into the shape
 * `flows/flows.json`'s Telemetry and Status pages read.
 *
 * Takes a whole `MavlinkStateBody` — `{ link, telemetryRunning, routerRunning
 * }` — because that is what `GET /mav/state` and both of `POST /mav/start`/
 * `/mav/stop` answer with (`MavlinkDetectBody` is the same body plus
 * `outcome`, which `yonder-mav-run` reads separately). Reused by
 * `yonder-mav-run` after every action, so the page updates on the reply
 * rather than waiting for the next poll.
 */
export function stateMessage(body: MavlinkStateBody, now: number = Date.now()): {
  payload: ReturnType<typeof messageFor>["payload"] & {
    link: Annunciator;
    receiving: Annunciator;
    running: Annunciator;
    feed: Annunciator;
    flow: FlowStrip;
  };
} {
  const { link, telemetryRunning, routerRunning } = body;
  return {
    payload: {
      ...messageFor(link, now).payload,
      link: linkFor(link, routerRunning),
      receiving: receivingFor(link, telemetryRunning),
      running: runStateFor(link, telemetryRunning),
      feed: feedFor(telemetryRunning),
      flow: flowFor(link, telemetryRunning, routerRunning, now),
    },
  };
}

interface StateNode extends RedNode {
  client: DaemonClient;
}

/**
 * `export default` rather than `export =`, matching
 * `node-red-contrib-yonder-remote`'s own `state.ts`: this file also carries
 * named exports, and TypeScript does not allow both export forms together.
 */
export default function register(RED: RED): void {
  RED.nodes.registerType("yonder-mav-state", function registered(this: RedNode, config) {
    RED.nodes.createNode(this, config);
    const node = this as StateNode;
    node.client = clientFor(RED.settings);

    node.on("input", (_msg, send, done) => {
      void (async () => {
        const result = fetched(await node.client.request({ method: "GET", path: "/mav/state" }));
        if (!result.ok) {
          node.status({ fill: "red", shape: "ring", text: "not answering" });
          send({ payload: null, yonder: readFailure(result.message, Date.now()) });
          done();
          return;
        }
        const body = result.value as MavlinkStateBody;
        node.status({ fill: "green", shape: "dot", text: body.link.phase });
        send(stateMessage(body, Date.now()));
        done();
      })();
    });
  });
}
