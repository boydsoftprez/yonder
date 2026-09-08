// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";
import { systemClock } from "../apply/types.js";
import type { DetectOutcome } from "./detect.js";
import type { Heartbeat } from "./frame.js";
import type { EndpointStats } from "./router/stats.js";

/**
 * One state, everything the console's Telemetry page reads (R-MAV-10).
 *
 * §6's governing idea, carried into the type: every field here is something
 * that happened, not something that was configured. `heartbeatHz` comes from
 * the spacing between arrivals, not from a MAVLink stream rate nobody asked
 * the vehicle to honour. `groundStations[i].answering` comes from that one
 * endpoint's own counter having moved in `mavlink-router`'s own statistics,
 * never from the endpoint merely appearing in `config.yaml` — a lesson this
 * design paid for once already: an earlier draft of this same file reasoned
 * from the merged loopback copy, where every ground station looks identical,
 * and could only report *that* one was answering, not which. A field this
 * file cannot measure is `null`, never a plausible-looking zero.
 *
 * The same rule turned out to bind harder than it first looked: a counter
 * being cumulative since the router started (`EndpointStats`) means a
 * *non-zero* reading is not exempt from it either. The router survives a
 * `yonder-core` restart by design (R-MAV-06), so a fresh `LinkTracker`
 * meeting a long-running router with an already-large count is the ordinary
 * case, not an edge one — and a total on its own says only "answered at
 * some point", never "answering now". Only a counter *moving* between two
 * readings is evidence of the present tense, which is why every "answering"
 * decision below waits for a second sample before it will say yes.
 */
export interface LinkState {
  /**
   * What the *serial link* is doing, plus one value this class never produces
   * itself: `stopped`.
   *
   * R-MAV-09's flag belongs to whoever performed the stop, and that is
   * `MavlinkRenderer` — it is the only thing that can put telemetry back on
   * the air, and a stop it holds survives a pinned or adopted link that never
   * sweeps again. So `MavlinkRenderer.state()` overlays `stopped` on the way
   * past, and this class has no setter for it. One fact, one owner: an
   * earlier draft kept a second copy of it here with no production caller,
   * which is how two sources of truth start.
   */
  phase: "searching" | "silent" | "noise" | "linked" | "stopped";
  device: string | null;
  baud: number | null;
  vehicle: string | null;
  system: number | null;
  heartbeatHz: number | null;
  lastHeardMs: number | null;
  /**
   * One entry per configured endpoint, in configuration order.
   *
   * Per-endpoint rather than a single flag, because the router turned out to
   * keep the attribution itself: with ReportStats on, an answering endpoint's
   * received count tracks its replies exactly and a silent one stays at zero.
   * §6 originally reported only *that* someone was answering, having reasoned
   * correctly that the merged loopback copy cannot distinguish them — and
   * missed that it does not have to.
   */
  groundStations: { name: string; answering: boolean; lastHeardMs: number | null }[];
  triedBauds: number[];
  /**
   * The sparkline's two series and the TCP client count, which the page
   * needs and heartbeats cannot supply.
   *
   * An earlier draft defined this state from heartbeats alone and left a
   * later, thinner layer to produce RX/TX history and a client count out of
   * them, which no thin adapter could — every heartbeat stream looks the
   * same. `rx`/`tx` are **kilobytes per second**, in the router's own coarse
   * integer unit (`EndpointStats.receivedKb`/`.transmittedKb` — the figure
   * `mavlink-router` prints beside every count, e.g. `Handled: 21 1KB`) —
   * never a bytes-per-message conversion off the message counts, because
   * MAVLink messages vary in size and any such factor would be a configured
   * number smuggled in as a unit, the exact thing this file exists to
   * refuse. Summed across the configured ground stations, where the design's
   * Throughput instrument sits (`docs/console/design/telemetry/README.md`),
   * and turned into a rate the way `TrafficSampler` (`remote/sampler.ts`)
   * already turns an interface's byte counters into one: a delta between two
   * readings, divided by the clock time between them, with the same "a
   * counter that went backwards means a restart, not negative traffic"
   * guard. Because the router's own KB figure is coarse and integer, a slow
   * link can go several samples between it moving at all, so this series is
   * honestly lumpy rather than smoothed into a shape nobody measured. `null`
   * until that source has answered even once, rather than a zero that would
   * draw a flat line nobody measured.
   */
  traffic: { rx: number[]; tx: number[]; peak: number | null; windowMs: number } | null;
  tcpClients: number | null;
}

const DEFAULT_WINDOW_MS = 5_000;

/**
 * Heartbeats kept for the rate calculation. HEARTBEAT is nominally 1 Hz, so
 * ten of them span roughly the last ten seconds — enough to smooth over one
 * missed beat without a rate from long ago outliving its own relevance.
 */
const HEARTBEAT_RING_SIZE = 10;

/** What is kept per ground station between `sampled()` calls, so the next
    reading has something to difference against. */
interface StationRecord {
  received: number;
  transmitted: number;
  receivedKb: number;
  transmittedKb: number;
  /** When this endpoint's `received` count was last seen to *increase*
      against a reading that was itself trustworthy. `null` until that has
      genuinely happened — never seeded from a first or post-restart total
      on its own, however large, because a total alone fixes no instant. */
  lastAnsweredAtMs: number | null;
}

/** One traffic-rate reading, timestamped so it can age out of `windowMs`. */
interface TrafficPoint {
  atMs: number;
  rx: number;
  tx: number;
}

export class LinkTracker {
  private readonly clock: Clock;
  private readonly windowMs: number;

  private lastOutcome: DetectOutcome | null = null;
  private selectedLink: { device: string; baud: number } | null = null;

  private heartbeatRing: number[] = [];
  private lastHeartbeatAtMs: number | null = null;

  private stationRecords = new Map<string, StationRecord>();
  private lastGroundStationNames: string[] = [];

  private lastSampledAtMs: number | null = null;
  private hasSampled = false;
  private trafficHistory: TrafficPoint[] = [];

  constructor(opts: { clock?: Clock; windowMs?: number } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  }

  /**
   * A fresh sweep result, from `detect()` (§3). It replaces whatever was
   * known about the serial link outright, rather than layering on top of it:
   * a sweep that comes back silent has disproved whatever vehicle a previous
   * sweep found, so that vehicle's name must not survive into this reading
   * (see link.test.ts's "drops the old vehicle" case) — carrying it forward
   * would be reporting something this observation never measured, the same
   * mistake §6 made about ground stations one level up.
   */
  observed(outcome: DetectOutcome): void {
    this.selectedLink = null;
    this.lastOutcome = outcome;
    this.heartbeatRing = [];
    this.lastHeartbeatAtMs = null;
  }

  /** A router started on an explicitly selected port (R-MAV-01, R-MAV-10).
   * This establishes identity only, never a detected vehicle or live link. */
  selected(link: { device: string; baud: number }): void {
    const held = this.selectedLink ?? (this.lastOutcome?.kind === "found" ? this.lastOutcome : null);
    if (held?.device === link.device && held.baud === link.baud) return;
    this.selectedLink = { ...link };
    this.lastOutcome = null;
    this.heartbeatRing = [];
    this.lastHeartbeatAtMs = null;
  }

  /**
   * A heartbeat off the loopback feed (Task 11). Only ones the vehicle
   * itself sent count: a ground station heartbeats back too (frame.ts's
   * `fromVehicle`, and the whole premise of §6), and mixing one into this
   * ring would corrupt the vehicle's own rate with an arrival that says
   * nothing about it.
   */
  heard(heartbeat: Heartbeat): void {
    if (!heartbeat.fromVehicle) return;
    const now = this.clock.now();
    this.lastHeartbeatAtMs = now;
    this.heartbeatRing.push(now);
    if (this.heartbeatRing.length > HEARTBEAT_RING_SIZE) this.heartbeatRing.shift();
  }

  /**
   * One reading of the router's own counters (Task 8b), attributed to
   * ground stations by name against `groundStationNames` — never by `kind`.
   * `yonder` (the control-plane's own loopback copy, R-MAV-05) and, once
   * opened, `inbound` (R-MAV-07) are both legitimately UDP, exactly like a
   * real ground station, so `kind` alone cannot tell them apart; only the
   * caller's own configured names can, which is why this takes them fresh on
   * every call rather than once at construction — `LinkTracker` holds no
   * `Config` of its own.
   */
  sampled(stats: EndpointStats[], groundStationNames: string[]): void {
    const now = this.clock.now();
    const byName = new Map(stats.map((entry) => [entry.name, entry] as const));
    this.lastGroundStationNames = [...groundStationNames];

    const elapsedSeconds = this.lastSampledAtMs === null ? null : (now - this.lastSampledAtMs) / 1000;
    let rxKbDelta = 0;
    let txKbDelta = 0;
    let haveDelta = false;

    for (const name of groundStationNames) {
      const entry = byName.get(name);
      // Missing from this particular reading — a block router/stats.ts
      // dropped as truncated, or an endpoint the router has not opened yet.
      // Leave whatever is already on record exactly as it is: a station does
      // not go silent because one read of the journal happened to cut it
      // off mid-write.
      if (entry === undefined) continue;

      const prior = this.stationRecords.get(name);
      // The router's counters are cumulative since it started (measured on a
      // board, 2026-09-05), so a set of counters that has not gone backwards
      // is a real prior total to difference against. One that *has* — the
      // router restarted underneath this reading — is treated exactly like
      // an endpoint seen for the very first time: TrafficSampler
      // (remote/sampler.ts) discards its own baseline the same way when an
      // interface's counters restart under it.
      const validPrior = prior !== undefined
        && entry.received >= prior.received
        && entry.transmitted >= prior.transmitted
        && entry.receivedKb >= prior.receivedKb
        && entry.transmittedKb >= prior.transmittedKb;

      let lastAnsweredAtMs: number | null;
      if (validPrior && prior !== undefined) {
        lastAnsweredAtMs = entry.received > prior.received ? now : prior.lastAnsweredAtMs;
        if (elapsedSeconds !== null && elapsedSeconds > 0) {
          rxKbDelta += entry.receivedKb - prior.receivedKb;
          txKbDelta += entry.transmittedKb - prior.transmittedKb;
          haveDelta = true;
        }
      } else {
        // No usable prior: first sighting, or a restart just invalidated the
        // old one. Either way this reading is a *total*, not a rate, and a
        // total alone — however large — is evidence the endpoint answered
        // *at some point*, not that it is answering *now*: the count could
        // be minutes old (a fresh tracker meeting a router that has been
        // running for hours, R-MAV-06) or seconds old (a restart whose very
        // next reading already shows a reply) and this single number cannot
        // tell those apart. `heartbeatHz` already refuses the equivalent
        // claim for a single heartbeat; this is the same refusal for a
        // single counter reading. The next sample, with a real prior to
        // diff against, tells the truth either way.
        lastAnsweredAtMs = null;
      }

      this.stationRecords.set(name, {
        received: entry.received,
        transmitted: entry.transmitted,
        receivedKb: entry.receivedKb,
        transmittedKb: entry.transmittedKb,
        lastAnsweredAtMs,
      });
    }

    if (haveDelta && elapsedSeconds !== null) {
      this.trafficHistory.push({ atMs: now, rx: rxKbDelta / elapsedSeconds, tx: txKbDelta / elapsedSeconds });
    }
    const cutoff = now - this.windowMs;
    this.trafficHistory = this.trafficHistory.filter((point) => point.atMs >= cutoff);

    this.lastSampledAtMs = now;
    this.hasSampled = true;
  }

  /**
   * What was measured. **Never `stopped`** — see `LinkState.phase`: R-MAV-09's
   * flag has one owner and it is `MavlinkRenderer`, which overlays that value
   * on the way past. Stopping telemetry is an operator choice about routing,
   * not a fact about the autopilot, which never hears about it and keeps
   * heartbeating over the UART regardless — so nothing here changes when one
   * happens.
   */
  state(): LinkState {
    const now = this.clock.now();
    const outcome = this.lastOutcome;

    const phase = outcome === null
      ? "searching"
      : outcome.kind === "found" ? "linked" : outcome.kind;

    // Below two arrivals there is no interval to measure yet — a rate from
    // one heartbeat is a claim no measurement supports.
    const heartbeatHz = this.heartbeatRing.length >= 2
      ? (this.heartbeatRing.length - 1)
        / ((this.heartbeatRing[this.heartbeatRing.length - 1] - this.heartbeatRing[0]) / 1000)
      : null;

    // Asked, not pushed: state() carries no timer of its own, so "how long
    // ago" is computed fresh against the current clock on every call rather
    // than frozen at whichever sample last touched it — otherwise a console
    // left open on a link that went quiet would read the last good moment
    // forever.
    const groundStations = this.lastGroundStationNames.map((name) => {
      const record = this.stationRecords.get(name);
      const lastHeardMs = record?.lastAnsweredAtMs != null ? now - record.lastAnsweredAtMs : null;
      return { name, answering: lastHeardMs !== null && lastHeardMs < this.windowMs, lastHeardMs };
    });

    const traffic = this.hasSampled
      ? {
          rx: this.trafficHistory.map((point) => point.rx),
          tx: this.trafficHistory.map((point) => point.tx),
          peak: this.trafficHistory.length === 0
            ? null
            : Math.max(...this.trafficHistory.flatMap((point) => [Math.abs(point.rx), Math.abs(point.tx)])),
          windowMs: this.windowMs,
        }
      : null;

    return {
      phase,
      device: outcome?.device ?? this.selectedLink?.device ?? null,
      baud: outcome?.kind === "found" ? outcome.baud : this.selectedLink?.baud ?? null,
      vehicle: outcome?.kind === "found" ? outcome.vehicle : null,
      system: outcome?.kind === "found" ? outcome.system : null,
      heartbeatHz,
      lastHeardMs: this.lastHeartbeatAtMs === null ? null : now - this.lastHeartbeatAtMs,
      groundStations,
      triedBauds: outcome !== null && outcome.kind !== "found" ? outcome.triedBauds : [],
      traffic,
      // Nothing has measured how a connected TCP client appears in the
      // router's output (Task 8b) — whether as its own block, a counter on
      // the server's, or not at all. Reporting a derived count would be a
      // number nobody measured, so this stays null until a bench session
      // with a client attached says what to count.
      tcpClients: null,
    };
  }
}
