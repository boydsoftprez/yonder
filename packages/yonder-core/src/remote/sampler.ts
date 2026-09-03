// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";
import { systemClock } from "../apply/types.js";
import { readTraffic, type Traffic } from "./traffic.js";

/** One rate reading, in bits per second - what lets a console say "Mbps". */
export interface ThroughputSample {
  rx: number;
  tx: number;
}

export interface Throughput {
  rxBitsPerSecond: number | null;
  txBitsPerSecond: number | null;
  /** Oldest first, at most the sampler's configured history length. */
  history: ThroughputSample[];
}

const EMPTY: Throughput = { rxBitsPerSecond: null, txBitsPerSecond: null, history: [] };

export const DEFAULT_INTERVAL_MS = 2_000;
export const DEFAULT_HISTORY = 60;

/** One raw reading of `readTraffic`, kept to compute the next delta against. */
interface Baseline {
  iface: string;
  rxBytes: number;
  txBytes: number;
  atMs: number;
}

/**
 * Turns the kernel's ever-increasing byte counters into a rate, on its own
 * clock rather than whenever a console happens to ask (R-NET-10).
 *
 * **Why a timer, not a read on request.** The mesh tab must already show a
 * graph the moment it is opened, not one that starts flat and fills in while
 * an operator watches. Node-RED's own poll keeps `GET /remote/state` coming
 * whether or not a browser is attached, but nothing guarantees it lands every
 * `intervalMs` on the nose - two pollers share this route at different
 * periods, and either can be late. Sampling on a dedicated timer keeps the
 * two-minute window's spacing exact regardless of when a page asks to see it,
 * and means history is already there from whenever `start()` ran, not from
 * whenever the first request happened to arrive.
 *
 * **Why a counter going backwards resets everything.** ZeroTier hands out a
 * new interface name on every join - `ztuqliuo7y`, `zttqh536rh`, never the
 * same one twice - so a *name* change is the ordinary case and is handled by
 * `forInterface` below. But the kernel counters for a given name can also
 * restart at a small number without the name changing (the client's tun
 * device recreated under the daemon, an interface index reused) and a delta
 * against the old total there would be a wild negative or an implausible
 * spike, either of which is worse on a page an operator trusts with their
 * life than a graph that briefly goes quiet while it rebuilds.
 */
export class TrafficSampler {
  private readonly clock: Clock;
  private readonly read: (iface: string, sysfs?: string) => Traffic | null;
  private readonly intervalMs: number;
  private readonly maxHistory: number;

  private timer: unknown;
  /** `undefined` means `forInterface` has never been called at all. */
  private targetIface: string | null | undefined;
  private baseline: Baseline | null = null;
  private history: ThroughputSample[] = [];

  constructor(opts: { clock?: Clock; read?: typeof readTraffic; intervalMs?: number; history?: number } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.read = opts.read ?? readTraffic;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxHistory = opts.history ?? DEFAULT_HISTORY;
  }

  /** Idempotent: a second call while already running does not restart the clock. */
  start(): void {
    if (this.timer !== undefined) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  /**
   * What to show for this interface. Empty when it has never been sampled.
   *
   * Naming a *different* interface than the one currently tracked drops
   * whatever history exists - a device between joins must never show the
   * previous mesh's traffic under the new one's label.
   */
  forInterface(iface: string | null): Throughput {
    if (iface !== this.targetIface) {
      this.targetIface = iface;
      this.baseline = null;
      this.history = [];
    }
    if (iface === null || this.history.length === 0) return EMPTY;
    const last = this.history[this.history.length - 1]!;
    return { rxBitsPerSecond: last.rx, txBitsPerSecond: last.tx, history: [...this.history] };
  }

  private schedule(): void {
    this.timer = this.clock.setTimer(this.intervalMs, () => {
      this.tick();
      this.schedule();
    });
  }

  private tick(): void {
    const iface = this.targetIface;
    if (iface === null || iface === undefined) return;

    const raw = this.read(iface);
    if (raw === null) {
      // Gone or unreadable - "we do not know" is what the next forInterface
      // call must see, not a rate computed against a total that no longer
      // means anything.
      this.baseline = null;
      this.history = [];
      return;
    }

    const now = this.clock.now();
    const prior = this.baseline;
    this.baseline = { iface, rxBytes: raw.rxBytes, txBytes: raw.txBytes, atMs: now };

    // The first reading for this interface is a total, not a rate - there is
    // nothing yet to take a delta against.
    if (prior === null || prior.iface !== iface) return;

    if (raw.rxBytes < prior.rxBytes || raw.txBytes < prior.txBytes) {
      // See the class comment: this name's counters restarted, so whatever
      // history was measured against the old total is discarded. The
      // baseline above already holds this reading, so the very next tick
      // resumes with a valid delta rather than staying stuck.
      this.history = [];
      return;
    }

    const elapsedSeconds = (now - prior.atMs) / 1000;
    // Defensive only: a clock that has not advanced would divide by zero.
    // Real ticks are always `intervalMs` apart.
    if (elapsedSeconds <= 0) return;

    this.history.push({
      rx: ((raw.rxBytes - prior.rxBytes) * 8) / elapsedSeconds,
      tx: ((raw.txBytes - prior.txBytes) * 8) / elapsedSeconds,
    });
    if (this.history.length > this.maxHistory) this.history.shift();
  }
}
