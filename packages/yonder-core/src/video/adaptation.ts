// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";
import type { Camera } from "../schema/config.js";
import {
  RateController, type Decision, type RateChannel, type RateThresholds,
} from "./rate.js";
import type { CameraReport } from "./viewers.js";

/**
 * The thing that actually runs the rate controllers (R-VID-07, R-VID-11).
 *
 * **This file exists because `rate.ts` had no caller.** The controller was
 * built, proved on a board and left with nobody to construct it: every
 * measurement it reasons about was typed in by hand, and an operator turning
 * Adaptive on got a switch that did nothing — which is K-49 exactly, one
 * layer further out than the layer K-49 was found at. A mechanism with no
 * production caller is a mechanism that does not exist.
 *
 * ## What it is
 *
 * One `RateController` per camera, because a floor, a ceiling and a ladder
 * belong to one camera; a map of them, because cameras come and go with an
 * apply; and one timer, because the ladder is judged against elapsed time and
 * something has to make time pass.
 *
 * ## What it is not
 *
 * - **Not a second opinion.** Every rule about what a rate may be is in
 *   `rate.ts` and none is here. This file decides *when* to ask and *which*
 *   controller to ask; it never clamps, reserves or steps anything.
 * - **Not a reaction to the aircraft** (R-CMD-04, R-CMD-05). The only thing
 *   that reaches a controller here is a receiver measurement of the path
 *   this board's own video is leaving on. No flight mode, no parameter, no
 *   automatic response to link loss beyond what `rate.ts` already does with
 *   it, which is to hold and say so.
 * - **Not a place a report is re-dated.** A measurement arrives with the
 *   stamp `Viewers` put on it and is handed straight to `observe`. Nothing
 *   here stores one to re-send later, which is what would make "a stale
 *   report is not headroom" unreachable.
 */

/**
 * How often the ladder is judged.
 *
 * A second: the interval a browser reports its WebRTC statistics at, so a
 * tick has at most one new measurement to think about and never none for long
 * enough for the evidence to go stale by itself. `tDown` and `tUp` are what
 * decide how fast anything moves; this only decides how often the question is
 * asked.
 */
const PERIOD_MS = 1_000;

/**
 * The three timings the ladder is judged by, until a board measures them.
 *
 * **Not measured.** The plan's Task 31 step 5 asks for them to be chosen on a
 * throttled link and written down, and that has not happened — so these are
 * reasoned defaults, and they are stated here rather than buried so that
 * replacing them is a one-line change against a measurement:
 *
 *  - `tDown` 5 s — a picture that has broken up is urgent, and a rung is
 *    cheap. Long enough that one bad second does not shrink the picture.
 *  - `tUp` 20 s — four times as long, because the failure mode of an
 *    adaptive ladder is hunting, and growing back into a link that has only
 *    just recovered is how hunting starts.
 *  - `hysteresisKbps` 100 — the schema's own smallest bitrate, so the
 *    deadband is one unit of the thing an operator can actually set.
 */
export const RATE_THRESHOLDS: RateThresholds = {
  tDown: 5_000,
  tUp: 20_000,
  hysteresisKbps: 100,
};

export interface AdaptationOptions {
  /** How a rate reaches a running encoder — `EncoderChannel`. */
  readonly channel: RateChannel;
  /** The **applied** cameras, read fresh on every tick. Never a draft. */
  readonly cameras: () => readonly Camera[];
  readonly thresholds?: RateThresholds;
  readonly clock?: Clock;
  readonly periodMs?: number;
  /**
   * Run at the top of every tick, before anything is decided.
   *
   * The daemon lets go of expired Full rate holds here, so that a hold nobody
   * renewed is not still being charged to the path when this tick works out
   * what the link affords.
   */
  readonly onTick?: (now: number) => void;
  /** Every decision, on its way to the picture (`Viewers.decided`). */
  readonly onDecisions?: (decisions: readonly Decision[]) => void;
}

export class Adaptation {
  private readonly channel: RateChannel;
  private readonly cameras: () => readonly Camera[];
  private readonly thresholds: RateThresholds;
  private readonly clock: Clock;
  private readonly periodMs: number;
  private readonly onTick: (now: number) => void;
  private readonly onDecisions: (decisions: readonly Decision[]) => void;

  private readonly controllers = new Map<string, RateController>();
  private timer: unknown;
  private stopped = false;

  constructor(opts: AdaptationOptions) {
    this.channel = opts.channel;
    this.cameras = opts.cameras;
    this.thresholds = opts.thresholds ?? RATE_THRESHOLDS;
    this.clock = opts.clock ?? systemClock;
    this.periodMs = opts.periodMs ?? PERIOD_MS;
    this.onTick = opts.onTick ?? ((): void => {});
    this.onDecisions = opts.onDecisions ?? ((): void => {});
  }

  /**
   * One browser or external RTSP receiver measurement, routed to its camera.
   *
   * A report for a camera this device is not configured with is dropped: a
   * controller conjured by an arriving measurement would be a controller
   * with no applied policy to carry out.
   */
  observe(report: CameraReport): void {
    this.controllerFor(report.camera)?.observe(report);
  }

  forget(camera: string, viewer: string): void { this.controllers.get(camera)?.forget(viewer); }
  blockRtspIncrease(camera: string, blocked: boolean): void { this.controllerFor(camera)?.blockRtspIncrease(blocked); }

  /**
   * Decide once for every configured camera, and report what was decided.
   *
   * Every camera, not only the ones with viewers: a camera whose browser has
   * gone still has a ground-station stream on the same uplink, and an
   * envelope the operator applied. What it will not have is fresh evidence,
   * and `rate.ts` answers that by holding and saying so.
   */
  tick(now: number = this.clock.now()): Decision[] {
    this.onTick(now);
    const decisions: Decision[] = [];
    const configured = new Set<string>();
    for (const camera of this.cameras()) {
      configured.add(camera.id);
      const controller = this.controllerFor(camera.id);
      if (controller !== undefined) decisions.push(...controller.tick(now));
    }
    // A camera removed by an apply takes its controller with it. Left behind,
    // it would go on asking a policy function for a camera that is no longer
    // in the configuration, on every tick, for the life of the daemon.
    for (const id of [...this.controllers.keys()]) {
      if (!configured.has(id)) this.controllers.delete(id);
    }
    if (decisions.length > 0) this.onDecisions(decisions);
    return decisions;
  }

  /** Start deciding, on this daemon's own clock. */
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.arm();
  }

  /**
   * Stop, for good.
   *
   * `stopped` as well as clearing the timer, for the reason the reach watch
   * and the fallback watchdog both have one: a tick already queued must not
   * re-arm itself on behalf of a process that has let go of its socket, and
   * a `start()` after a `close()` must not bring the loop back.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Every command issued so far, once each has been answered. For a test
   *  that must not sleep, and for a caller shutting the video layer down. */
  async settled(): Promise<void> {
    for (const controller of [...this.controllers.values()]) await controller.settled();
  }

  private arm(): void {
    this.timer = this.clock.setTimer(this.periodMs, () => {
      this.timer = undefined;
      if (this.stopped) return;
      // A throw here would take the daemon down, and the daemon is the
      // device. Nothing in `tick` is expected to throw; a policy function
      // reading a configuration off disk is what could.
      try {
        this.tick();
      } catch {
        // Deliberately silent: this runs once a second, and a line per tick
        // would bury whatever is actually wrong under thousands of copies of
        // the fact that it is.
      }
      this.arm();
    });
  }

  /** This camera's controller, made on first use. The policy function reads
   *  the applied configuration again on every tick rather than closing over
   *  the camera it was made from — an apply replaces that object. */
  private controllerFor(id: string): RateController | undefined {
    const camera = this.cameras().find((c) => c.id === id);
    if (camera === undefined) return undefined;
    const held = this.controllers.get(id);
    if (held !== undefined) return held;
    const made = new RateController({
      channel: this.channel,
      clock: this.clock,
      policy: () => this.cameras().find((c) => c.id === id) ?? camera,
      thresholds: this.thresholds,
    });
    this.controllers.set(id, made);
    return made;
  }
}
