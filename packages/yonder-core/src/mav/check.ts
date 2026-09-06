// SPDX-License-Identifier: GPL-3.0-or-later
import type { LinkState } from "./link.js";

/**
 * R-DIA-04 — verify the MAVLink path end to end — drawn as the three-link
 * chain §8 specifies rather than as a single verdict.
 *
 * **`ok: null` is the whole point of this file.** It means *nobody attempted
 * this link*, and the console draws a dash for it; `false` means *this was
 * attempted and it is not working*, and the console draws a cross. A link
 * nobody tried is not a link that failed — an operator who deliberately
 * stopped telemetry (R-MAV-09) must not open the page to a row of red, and a
 * board that has been up for two seconds must not either. That distinction is
 * the same one the Status strip makes and it is load-bearing, so every branch
 * below chooses between the three deliberately.
 *
 * **Pure.** State in, three sentences out. It reads no clock, runs no probe
 * and asks systemd nothing: every input is something `LinkTracker` already
 * measured, plus the two facts only the daemon knows — whether the router is
 * on the air, and what the configuration asks for. That is what makes the
 * whole of this decision testable without a board (`check.test.ts`), and it is
 * the same shape `system/format.ts` and `net/state.ts` already have.
 */

export interface CheckLink {
  /**
   * `true` — measured, and working. `false` — measured, and not working.
   * `null` — **not attempted**, which draws a dash and never a cross.
   */
  ok: boolean | null;
  /** One sentence, already in words. No widget learns a vocabulary. */
  detail: string;
}

/** The chain, in the order the console draws it. */
export interface PathCheck {
  /** Autopilot to Yonder — the serial link and the heartbeats on it. */
  autopilot: CheckLink;
  /** Yonder to ground stations — what `mavlink-router` is sending out. */
  outbound: CheckLink;
  /** Ground station to Yonder — whether anything is answering. */
  inbound: CheckLink;
}

export interface PathCheckInput {
  /** Everything measured about the autopilot. `MavlinkRenderer.state()`. */
  state: LinkState;
  /**
   * Whether `mavlink-router` is on the air, as of the last time systemd was
   * asked. Not a field of `LinkState` — every field there is a measurement
   * about the *aircraft*, and this is a fact about this device — which is why
   * it arrives beside it rather than inside it.
   */
  telemetryRunning: boolean;
  /**
   * Whether `mavlink-router` is on the air at all.
   *
   * A different question from `telemetryRunning`, and the two come apart
   * exactly while telemetry is stopped: a stop removes the ground-station
   * endpoints and restarts the router, so the service is up, the flight
   * controller link is up, the loopback copy is still delivering heartbeats —
   * and nothing is being sent on. The *Autopilot to Yonder* row is measured on
   * that loopback copy, so it is this field it depends on, never the other.
   */
  routerRunning: boolean;
  /**
   * The configured ground stations, in configuration order, from
   * `config.mavlink.endpoints`.
   *
   * Read from the configuration rather than from `LinkState.groundStations`,
   * which is populated by the router's own statistics and is therefore empty
   * for the first couple of seconds of every daemon's life. "No ground
   * stations are configured" and "no reading has arrived yet" are different
   * answers and this is the input that tells them apart.
   */
  endpoints: string[];
  /**
   * `config.mavlink.autocast` — whether telemetry starts on its own
   * (R-MAV-08). It is what makes a router that is not running either a
   * setting doing its job or a fault worth a cross.
   */
  autocast: boolean;
}

/**
 * How long without a heartbeat before the autopilot link is called broken.
 *
 * HEARTBEAT is nominally 1 Hz, so this is three missed beats: long enough
 * that one dropped frame does not flash a cross at an operator, short enough
 * that a cable that came out is reported while they are still holding it.
 * Exported so a reader can find the number rather than infer it.
 */
export const HEARTBEAT_STALE_MS = 3_000;

/** Milliseconds as an operator reads them: "0.3 s", "12.0 s". */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * A count of ground stations, in words, so no page has to pluralise.
 *
 * The same rule the contrib nodes follow: every string arrives already said.
 */
function stations(count: number): string {
  return count === 1 ? "one ground station" : `${String(count)} ground stations`;
}

/**
 * Autopilot to Yonder.
 *
 * **This row does not read `telemetryRunning`, and that is the point.**
 * Stopping telemetry stops the *sending*; the router stays up carrying the
 * flight controller link and the loopback copy, so heartbeats go on arriving
 * and this row goes on being a live measurement — *OK · heartbeat every
 * second* beside a Ground stations row reading *stopped by you*. An operator
 * stops broadcasting; they do not ask to be blinded. What this row depends on
 * is `routerRunning`, because that is what decides whether anything can arrive
 * on the loopback feed at all.
 *
 * The ways it is *not attempted* are worth naming together, because each would
 * otherwise reach the page as a cross: no sweep has reported yet; the router
 * is not running, so nothing can arrive; and a link found whose first
 * heartbeat has not landed.
 */
function autopilotLink(state: LinkState, routerRunning: boolean): CheckLink {
  if (state.phase === "searching") {
    return { ok: null, detail: "Still looking for a flight controller" };
  }
  if (state.phase === "silent") {
    // R-MAV-13's two kinds of nothing, and the third the renderer adds: an
    // empty `triedBauds` means no speed was swept because the device node
    // could not be opened at all, which sends the operator somewhere else
    // again.
    return state.triedBauds.length === 0
      ? { ok: false, detail: `${state.device ?? "The serial port"} could not be opened` }
      : { ok: false, detail: "No data on the wire, at any speed" };
  }
  if (state.phase === "noise") {
    // Deliberately not the silent sentence. Bytes reaching the receive pin
    // rule the wiring out and point at the autopilot's own protocol and baud
    // parameters (R-MAV-13) — a different errand entirely.
    return { ok: false, detail: "Bytes on the wire, but no MAVLink frame at any speed" };
  }

  // Linked, or linked and deliberately not broadcasting. Either way the
  // heartbeats that would confirm this row arrive over the loopback copy,
  // which exists whenever the router does.
  const speed = state.baud === null ? "" : `, ${String(state.baud)} baud`;
  if (!routerRunning) {
    return { ok: null, detail: `Not checked — mavlink-router is not running, so nothing is listening${speed}` };
  }
  if (state.lastHeardMs === null) {
    // Adoption, and the first second of every boot: the sweep (or the file a
    // running router was started with) says there is a link, and no heartbeat
    // has come off the feed yet. The answer is not in, which is not a failure.
    return { ok: null, detail: `Linked${speed}; waiting for the first heartbeat` };
  }
  if (state.lastHeardMs >= HEARTBEAT_STALE_MS) {
    // The failure this row exists for: it was heartbeating and it has stopped.
    return { ok: false, detail: `No heartbeat for ${seconds(state.lastHeardMs)}${speed}` };
  }
  // `heartbeatHz` is null below two arrivals, and `Date.now()` has
  // millisecond resolution — so two beats inside one millisecond divide by
  // zero and give Infinity, which must never reach a page as the word.
  const rate = state.heartbeatHz !== null && Number.isFinite(state.heartbeatHz)
    ? `Heartbeat at ${state.heartbeatHz.toFixed(1)} Hz`
    : `Heartbeat heard ${seconds(state.lastHeardMs)} ago`;
  return { ok: true, detail: `${rate}${speed}` };
}

/**
 * Yonder to ground stations.
 *
 * UDP has no acknowledgement, so "it arrived" is not a thing this device can
 * measure. What it can measure is bytes leaving, out of the router's own
 * per-endpoint counters — which is what the tick means here.
 */
function outboundLink(
  state: LinkState, telemetryRunning: boolean, endpoints: string[], autocast: boolean,
): CheckLink {
  // R-MAV-09. Reported before everything else: nothing has failed, the
  // operator turned it off.
  if (state.phase === "stopped") return { ok: null, detail: "Stopped by you" };
  // §8's own words for the case where the autopilot is missing.
  if (state.phase !== "linked") return { ok: null, detail: "Nothing to send" };

  if (!telemetryRunning) {
    // Reached only when the operator has *not* stopped telemetry — that case
    // returned above — and outside a stop "not sending" and "no router" are
    // the same fact, which is what lets this branch name the service. R-MAV-16:
    // a router that will not start is reported on the page, and with `autocast`
    // on and a link found it is the one genuinely measured failure this leg
    // has. With it off, the same fact is the setting doing exactly what it says
    // (R-MAV-08).
    return autocast
      ? { ok: false, detail: "mavlink-router is not running" }
      : { ok: null, detail: "Telemetry does not start on its own on this device" };
  }
  if (endpoints.length === 0) {
    return { ok: null, detail: "No ground stations are configured" };
  }

  const traffic = state.traffic;
  if (traffic === null) {
    return { ok: null, detail: "Waiting for the first reading of the router's own counters" };
  }

  // The peak across the window rather than the newest point. The router's KB
  // figure is a coarse integer, so a healthy slow link genuinely reads zero
  // for whole samples between movements (`link.ts` says so at length) and the
  // newest point alone would blink between a rate and nothing.
  const leaving = traffic.tx.length === 0 ? 0 : Math.max(...traffic.tx);
  if (leaving <= 0) {
    // Still a tick: the router is running and configured, and every frame it
    // handles is sent to every endpoint. What has not happened is a
    // measurement, and that is what the sentence says.
    return { ok: true, detail: `Sending to ${stations(endpoints.length)}; no measurable traffic yet` };
  }
  return { ok: true, detail: `${leaving.toFixed(1)} kB/s leaving, ${stations(endpoints.length)} configured` };
}

/**
 * Ground station to Yonder.
 *
 * A ground station is under no obligation to send anything, so silence is
 * *not checked* rather than *failed* — §8 says so in as many words. The one
 * cross is a station that was answering and has gone quiet, which is a
 * measurement about something that used to work.
 */
function inboundLink(state: LinkState, telemetryRunning: boolean, endpoints: string[]): CheckLink {
  const NOT_CHECKED: CheckLink = { ok: null, detail: "Not checked" };
  // `phase === "stopped"` fails the first test, which is right: a stop takes
  // the ground-station endpoints out of the generated file, so there is no
  // longer a path for one of them to answer over.
  if (state.phase !== "linked" || !telemetryRunning || endpoints.length === 0) return NOT_CHECKED;

  const answering = state.groundStations.filter((s) => s.answering && s.lastHeardMs !== null);
  if (answering.length > 0) {
    const soonest = Math.min(...answering.map((s) => s.lastHeardMs ?? Number.POSITIVE_INFINITY));
    return { ok: true, detail: `Answering, last heard ${seconds(soonest)} ago` };
  }

  const heardOnce = state.groundStations
    .map((s) => s.lastHeardMs)
    .filter((ms): ms is number => ms !== null);
  if (heardOnce.length > 0) {
    return { ok: false, detail: `No reply for ${seconds(Math.min(...heardOnce))}` };
  }
  // Never heard from. Not a fault of this device's, and not a cross.
  return { ok: null, detail: "Nothing has answered yet" };
}

export function pathCheck(input: PathCheckInput): PathCheck {
  const { state, telemetryRunning, routerRunning, endpoints, autocast } = input;
  return {
    // The one row measured on the loopback copy, which the router carries
    // whether or not the ground stations are being sent to. The other two ask
    // about the sending, so they read the other field.
    autopilot: autopilotLink(state, routerRunning),
    outbound: outboundLink(state, telemetryRunning, endpoints, autocast),
    inbound: inboundLink(state, telemetryRunning, endpoints),
  };
}
