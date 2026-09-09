// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";
import { PREVIEW_RUNGS, type Camera, type PreviewRung } from "../schema/config.js";
import type { Ack } from "./encoder.js";
import type { EncodeName, PreviewShape, RunningEncodes } from "./pipeline.js";
import { FeedbackRate } from "./feedback-rate.js";
import { atIp, fromIp } from "./present.js";

/**
 * Moving an encoder's own rate, and the preview's own size, to what the link
 * carrying them is actually carrying (R-VID-07, R-VID-11; spec §8.1).
 *
 * **This is the fix for K-49.** The console offers Adaptive for the stream
 * and for the preview, and Auto for the preview's size, and until this file
 * existed all three held whatever the camera last had. A development board
 * was found with `stream.mode: adaptive`, `preview.mode: adaptive`, both at
 * 100 kb/s and a preview floor of 300 — the applied rate below the camera's
 * own declared floor, with no control on the page able to raise it. An
 * automatic mode that never acts is worse than no automatic mode, because an
 * operator reads it as working.
 *
 * ## It relays a policy; it does not originate one (R-CMD-04, R-CMD-05)
 *
 * **This file looks like the thing CLAUDE.md rule 4 forbids and is not, and
 * the difference has to be exact, because the next reader will ask.**
 *
 * Rule 4 is about *the aircraft*: Yonder never decides to send a command to
 * it. No flight mode, no parameter write, no payload output, and above all no
 * automatic reaction to link loss or battery state — the autopilot owns every
 * one of those, and a companion computer that grew a control loop over them
 * is the failure the rule exists to prevent.
 *
 * What this file changes is **a video encoder's own bitrate, on the video
 * this same board is transmitting**. That is the encoder managing its own
 * transmission — the same act as a modem picking a modulation, and the same
 * act `EncoderChannel` already performs when an operator moves the bitrate
 * bar by hand. It commands no flight mode. It writes no parameter. It touches
 * nothing the autopilot owns, and nothing outside this board's own outbound
 * video. If the link drops entirely, this file does nothing at all: no
 * evidence is not a trigger here, it is a reason to hold (`tick` below).
 *
 * And the envelope is not its own. Floor, ceiling, ladder top, ladder bottom,
 * Fixed or Adaptive, a held size — every bound it moves between was chosen by
 * the operator and applied through the confirmation window. **It carries out
 * an applied policy; it does not decide one.** Where the policy leaves it no
 * room it says so and changes nothing, rather than widening the policy to
 * fit (`shortfall` below) — which is the same refusal `validateDraft` makes
 * when it declines to repair a draft, for the same reason.
 *
 * ## What it will not do
 *
 * - *Read a draft.* The policy it acts on comes back from `policy()` on every
 *   tick, and that function's contract is the **applied** configuration. A
 *   draft is what an operator is still typing; acting on one would change the
 *   aircraft's video on a keystroke, before Apply and before the confirmation
 *   window R-CFG-03 exists to arm.
 * - *Keep its own copy of what the encoder is doing.* Every tick asks
 *   `channel.inForce()`. A cached rate parts company with the pipeline the
 *   moment the pipeline restarts on its launch line, and a controller
 *   comparing its next target against its own bookkeeping would then leave
 *   the encoder somewhere it never intended — K-48's shape, one level up.
 * - *Treat silence as good news.* A report that has gone stale is dropped
 *   from the evidence rather than believed; with nothing fresh, nothing
 *   moves and the reason says so. Raising a rate on the strength of an old
 *   measurement is the one failure mode of an adaptive controller that an
 *   operator cannot see happening.
 */

/**
 * One viewer's measurement of the path its video is leaving by (spec §8.1).
 *
 * `rtt` and `loss` are the browser's own WebRTC statistics for the preview;
 * `egress` and `capacity` are what is leaving on that path and what it is
 * measured to carry. **Both rates are kb/s at IP** — what an uplink actually
 * carries, the layer `present.ts` states every figure at — while a floor, a
 * ceiling and an encoder setpoint are encoder rates. `atIp`/`fromIp` are the
 * only conversion between them, and this file does not restate the overhead.
 *
 * `at` is **the daemon's own clock** at the moment the report arrived, not
 * the browser's: freshness is judged against `tick`'s `now`, and two clocks
 * compared against each other would make a stale report look fresh.
 */
export interface LinkReport {
  readonly viewer: string;
  /** Round-trip time, in ms. */
  readonly rtt: number;
  /** The fraction of what was sent that did not arrive, 0–1. */
  readonly loss: number;
  /** Observed delivery in kb/s. RTSP carries transported payload bytes;
   * browser accounting uses the existing IP estimate. Neither is capacity. */
  readonly egress: number;
  /** What this path is measured to carry, kb/s at IP. */
  readonly capacity: number | null;
  readonly encode?: EncodeName;
  /** Trusted server-side observations; browser reports cannot supply this. */
  readonly rtsp?: {
    readonly transport: 'tcp' | 'udp';
    readonly queuedMs: number;
    readonly discarded: number;
    readonly canIncrease: boolean;
    readonly acknowledged: boolean;
    /** A newly received loss window, not a re-dated historical counter. */
    readonly lossEvent?: boolean;
  };
  readonly at: number;
}

/**
 * What the controller did about one subject, and why — every tick, for each
 * of the two encodes' rates and the preview's size.
 *
 * **A hold is a decision.** Three of the five cases below change nothing, and
 * they are reported exactly as loudly as the two that do: an operator
 * watching an automatic mode needs to be told *it is holding, and this is
 * what it is waiting for* far more than they need to be told it moved.
 * Reporting only changes is how K-49 reads from the outside.
 *
 * `reason` is the operator's sentence, not a log line, and is what the
 * picture announces (spec §8.2). Task 32 carries these to the page; nothing
 * in this file publishes them, because a mechanism that both decides and
 * publishes has two reasons to change.
 */
export type Decision =
  /** A rate this encode was asked to hold. */
  | {
    readonly action: "rate"; readonly camera: string; readonly encode: EncodeName;
    readonly kbps: number; readonly reason: string; readonly at: number;
  }
  /** A rung the preview was asked to move to. */
  | {
    readonly action: "size"; readonly camera: string; readonly encode: "preview";
    readonly size: PreviewRung; readonly reason: string; readonly at: number;
  }
  /** A rate left where it was. `kbps` is what is in force, or null where
   *  nothing is running to have one. */
  | {
    readonly action: "hold-rate"; readonly camera: string; readonly encode: EncodeName;
    readonly kbps: number | null; readonly reason: string; readonly at: number;
  }
  /** A size left where it was. */
  | {
    readonly action: "hold-size"; readonly camera: string; readonly encode: "preview";
    readonly size: PreviewRung | null; readonly reason: string; readonly at: number;
  }
  /**
   * Not even the applied floor fits in what the link is carrying, and
   * **nothing was changed** — the floor is not lowered, no output is
   * stopped, and the traffic is not claimed to fit (spec §8.1). The two
   * numbers are carried so the page can state the gap rather than describe
   * it.
   */
  | {
    readonly action: "shortfall"; readonly camera: string; readonly encode: EncodeName;
    readonly floorKbps: number; readonly carryingKbps: number;
    readonly reason: string; readonly at: number;
  };

/**
 * The part of `EncoderChannel` this controller uses.
 *
 * Named as an interface so the controller depends on the three operations
 * rather than on the class, and so a test can hold a pipeline still and watch
 * what actually arrives at it. `EncoderChannel` satisfies it structurally.
 */
export interface RateChannel {
  inForce(camera: string): RunningEncodes | null;
  retune(camera: Camera, encode: EncodeName, kbps: number): Promise<Ack<number>>;
  reconfigurePreview(camera: Camera, shape: PreviewShape): Promise<Ack<PreviewShape>>;
}

/**
 * The timings the ladder and the deadband are judged by.
 *
 * `tDown`, `tUp` and `hysteresisKbps` are the three the plan's board
 * measurement sets, on a throttled link, so that the preview does not hunt.
 * The other two have defaults and are named here rather than buried:
 *
 * - `staleAfterMs` is how long a viewer's report counts as evidence. It is
 *   the number that makes *a stale report is not headroom* mean something,
 *   so it is a setting and not a constant.
 * - `rttInflationMs` is how far above the lowest round trip this controller
 *   has ever seen a link may drift before it is treated as queueing rather
 *   than as offering room. A queue is not headroom, whatever the arithmetic
 *   says, and a step up taken into one is a step straight back down.
 *
 * **`hysteresisKbps` is read three times and means one thing each time:** the
 * smallest change in kb/s this controller treats as a change. It is the
 * deadband a rate must move by before it is commanded at all, the margin
 * above the ceiling the link must carry before that counts as room to grow
 * into, and the band above the floor within which the preview counts as
 * pinned to it. One number, so a link sitting on a boundary cannot walk the
 * ladder up and straight back down.
 *
 * The deadband's cost, stated because it is a real one: an encode may sit up
 * to `hysteresisKbps` **above** what the link currently affords rather than
 * be moved for a change too small to be worth a command. That excursion is
 * bounded, is always still inside the applied floor and ceiling, and
 * self-corrects — running over what a link carries shows up as loss in the
 * next report, which lowers the allowance again until the gap is worth
 * commanding. What it buys is a picture that does not announce a new rate
 * every second.
 */
export interface RateThresholds {
  readonly tDown: number;
  readonly tUp: number;
  readonly hysteresisKbps: number;
  readonly staleAfterMs?: number;
  readonly rttInflationMs?: number;
}

const STALE_AFTER_MS = 6_000;
const RTT_INFLATION_MS = 100;

/** A command the pipeline answered *no such control* to, and the exact
 *  circumstances it refused in — so the same request is not made again every
 *  tick, and a different one still is. */
interface Refusal<T> {
  readonly reason: string;
  readonly want: T;
  readonly inForce: T | null;
}

export interface RateControllerOptions {
  readonly channel: RateChannel;
  /** The **applied** policy for this camera, asked again on every tick.
   *  Never a draft: see this file's opening comment. */
  readonly policy: () => Camera;
  readonly thresholds: RateThresholds;
  readonly clock?: Clock;
}

/**
 * One camera's rate and size, kept inside one camera's applied envelope.
 *
 * One controller per camera, because one camera is what a floor, a ceiling
 * and a ladder belong to; a daemon holding several holds one of these each.
 */
export class RateController {
  private rtspIncreaseBlocked = false;
  private readonly channel: RateChannel;
  private readonly policy: () => Camera;
  private readonly clock: Clock;
  private readonly tDown: number;
  private readonly tUp: number;
  private readonly hysteresisKbps: number;
  private readonly staleAfterMs: number;
  private readonly rttInflationMs: number;

  /** The latest report from each viewer, replaced as they arrive and judged
   *  for freshness only at the moment a decision is taken. */
  private readonly reports = new Map<string, LinkReport>();
  /** Recent baseline of the selected viewer, so a LAN baseline expires on LTE. */
  private rttFloor: number | null = null;

  private pinnedSince: number | null = null;
  private headroomSince: number | null = null;

  private readonly refusedRate = new Map<EncodeName, Refusal<number>>();
  private refusedSize: Refusal<PreviewRung> | null = null;

  private readonly outstanding = new Set<Promise<unknown>>();
  private readonly feedback: FeedbackRate;

  constructor(opts: RateControllerOptions) {
    this.channel = opts.channel;
    this.feedback = new FeedbackRate(opts.channel, opts.thresholds, work => this.track(work));
    this.policy = opts.policy;
    this.clock = opts.clock ?? systemClock;
    this.tDown = opts.thresholds.tDown;
    this.tUp = opts.thresholds.tUp;
    this.hysteresisKbps = opts.thresholds.hysteresisKbps;
    this.staleAfterMs = opts.thresholds.staleAfterMs ?? STALE_AFTER_MS;
    this.rttInflationMs = opts.thresholds.rttInflationMs ?? RTT_INFLATION_MS;
  }

  /**
   * One viewer's measurement of the path (spec §8.2).
   *
   * **A report whose numbers are not numbers is not stored at all.** A NaN
   * capacity would poison every comparison it took part in and a negative one
   * would be read as a link carrying less than nothing; either would be
   * silently believed. Refusing it here means the controller has no evidence
   * from that viewer, which is a state it already reports honestly, rather
   * than bad evidence, which is a state nothing could see.
   */
  observe(report: LinkReport): void {
    const numbers = [report.rtt, report.loss, report.egress, report.at];
    if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return;
    if (report.loss < 0 || report.loss > 1) return;
    if (report.rtt < 0 || report.egress < 0) return;
    if (report.capacity !== null && (!Number.isFinite(report.capacity) || report.capacity < 0)) return;
    if (typeof report.viewer !== "string" || report.viewer === "") return;
    if (report.rtsp && (!Number.isFinite(report.rtsp.queuedMs) || report.rtsp.queuedMs < 0
      || !Number.isFinite(report.rtsp.discarded) || report.rtsp.discarded < 0 || report.rtsp.discarded > 1)) return;
    this.reports.set(report.viewer, report);
    this.feedback.observe(report);
  }

  forget(viewer: string): void { this.reports.delete(viewer); }
  blockRtspIncrease(blocked: boolean): void { this.rtspIncreaseBlocked = blocked; }

  /**
   * Decide, act, and say what was decided — three decisions, every tick: the
   * stream's rate, the preview's rate, and the preview's size.
   *
   * The commands it issues are not awaited here, and deliberately: a tick is
   * a decision taken on the evidence in hand, and a pipeline that takes five
   * seconds to answer a preview reconfigure must not hold up the next one.
   * What each command *did* comes back through `channel.inForce()` on a later
   * tick, from the encoder rather than from this file's memory of what it
   * asked for. `settled()` is the wait, for a caller that needs one.
   */
  tick(now: number = this.clock.now()): Decision[] {
    const camera = this.policy();
    const running = this.channel.inForce(camera.id);

    if (!camera.enabled) {
      return this.allHolds(camera, running, now,
        `${camera.name} is disabled, so there is nothing running to move`);
    }
    if (running === null) {
      return this.allHolds(camera, running, now,
        `nothing is running on ${camera.name} to command: no pipeline, no encoder, no rate`);
    }

    if (this.feedback.pending) return this.allHolds(camera, running, now, "Waiting for the encoder to confirm the preceding change.");
    const link = this.evidence(now);
    const fresh = [...this.reports.values()].filter(r => r.at <= now);
    const outside = (["stream", "preview"] as const).some(encode => {
      const policy = camera[encode], rate = running[encode];
      return policy.mode === "adaptive" && rate !== null && (rate < policy.floor_kbps || rate > policy.ceiling_kbps);
    });
    if (fresh.some(r => r.encode !== undefined || r.capacity === null) || (link === null && outside)) {
      this.pinnedSince = null; this.headroomSince = null;
      return this.feedback.tick(camera, running, fresh, now, !this.rtspIncreaseBlocked);
    }
    if (link === null) {
      // Not merely "no change": the waits are abandoned. A step down is
      // earned by *observed* pinning for tDown, and a gap in the evidence is
      // not evidence that the pinning continued through it.
      this.pinnedSince = null;
      this.headroomSince = null;
      return this.allHolds(camera, running, now,
        `no fresh report from any viewer in the last ${seconds(this.staleAfterMs)}: `
        + "what the link can carry is unknown, so nothing moves");
    }

    // What the path is actually getting through, rather than what it
    // measured: a link losing a tenth of what is put on it is not carrying
    // the capacity it reported.
    const carrying = Math.max(0, Math.floor(link.capacity! * (1 - link.loss)));
    this.rttFloor = this.feedback.baseline(link, now);

    /*
     * The decision point, and the one R-CMD-04 asks about (see the file
     * header). Everything below moves this board's own encoder inside bounds
     * the operator applied. Nothing below reaches the autopilot, and nothing
     * below reacts to the aircraft — only to the link this video is leaving
     * on, which is the encoder's own business.
     */
    const stream = this.rateFor(camera, "stream", {
      now, running,
      floor: camera.stream.floor_kbps,
      ceiling: camera.stream.ceiling_kbps,
      fixed: camera.stream.mode === "fixed",
      available: carrying,
      fixedReason: "the stream is Fixed: its rate is the operator's, and this controller "
        + "does not move it",
    });

    // The stream is reserved first (spec §8.1): the preview is offered what
    // the path carries beyond whatever the stream is running once this tick's
    // decision has been carried out — the rate just commanded, or the rate it
    // is holding at. Never a share of the whole.
    const fullConsumer = camera.outputs.some(output => output.enabled) || fresh.some(report => report.encode === "stream");
    const reserved = fullConsumer ? atIp(stream.spend ?? camera.stream.floor_kbps) : 0;
    const left = Math.max(0, carrying - reserved);

    const preview = this.rateFor(camera, "preview", {
      now, running,
      floor: camera.preview.floor_kbps,
      ceiling: camera.preview.ceiling_kbps,
      fixed: camera.preview.mode === "fixed",
      available: left,
      fixedReason: "the preview is Fixed: its rate and its size are the operator's",
    });

    const size = this.sizeFor(camera, {
      now, running,
      allowance: preview.allowance,
      shortfall: preview.decision.action === "shortfall",
      link, carrying,
    });

    return [stream.decision, preview.decision, size];
  }

  /**
   * Every command issued so far, once each has been answered.
   *
   * For a caller that is shutting a camera down, and for a test that must not
   * sleep: the clock is injected everywhere in this file precisely so that no
   * timing here is a race, and a test that awaited a wall-clock delay instead
   * would be asserting that the delay was long enough.
   */
  async settled(): Promise<void> {
    while (this.outstanding.size > 0) await Promise.all([...this.outstanding]);
  }

  /**
   * The one fresh report to act on: **the most constrained** (spec §8.2).
   *
   * One report, not the worst field of several. A viewer's rtt, loss and
   * capacity are one coherent picture of one path at one moment, and a
   * composite of the worst of each would be a link nobody measured. The one
   * that can carry least decides, and every other fresh viewer is at least as
   * well served by its answer.
   *
   * A report the daemon stamped *after* the moment being asked about is not
   * evidence either — it can never go stale, so it would sit in the evidence
   * for ever. It falls out here rather than being trusted for ever.
   */
  private evidence(now: number): LinkReport | null {
    // Dropped rather than merely skipped: a viewer that has gone is a browser
    // that closed, and its last word is not evidence again however long the
    // aircraft flies. `rttFloor` is deliberately not recomputed from what
    // survives — it is a baseline over time, not over the viewers in hand.
    for (const [viewer, r] of this.reports) {
      if (now - r.at > this.staleAfterMs) this.reports.delete(viewer);
    }
    const fresh = [...this.reports.values()].filter((r) => r.at <= now);
    if (fresh.length === 0) return null;
    const carrying = (r: LinkReport): number => (r.capacity ?? Infinity) * (1 - r.loss);
    return fresh.reduce((worst, r) => {
      if (carrying(r) < carrying(worst)) return r;
      if (carrying(r) > carrying(worst)) return worst;
      return r.viewer < worst.viewer ? r : worst;
    });
  }

  /** One encode's rate: what it may have, whether that is a change worth
   *  making, and what it will be spending once this tick is carried out. */
  private rateFor(camera: Camera, encode: EncodeName, ctx: {
    now: number; running: RunningEncodes; available: number;
    floor: number; ceiling: number; fixed: boolean; fixedReason: string;
  }): { decision: Decision; spend: number | null; allowance: number } {
    const inForce = ctx.running[encode];
    const allowance = fromIp(ctx.available);
    const at = ctx.now;

    if (inForce === null) {
      return {
        decision: this.holdRate(camera, encode, null, at,
          `${camera.name}'s ${encode} carries the source's own encoding: there is no `
          + "encoder on it whose rate could move"),
        spend: null, allowance,
      };
    }
    if (ctx.fixed) {
      return {
        decision: this.holdRate(camera, encode, inForce, at, ctx.fixedReason),
        spend: inForce, allowance,
      };
    }
    if (allowance < ctx.floor) {
      // The floor is not lowered, no output is stopped, and the traffic is
      // not claimed to fit. The gap is stated and nothing moves.
      return {
        decision: {
          action: "shortfall", camera: camera.id, encode, at,
          floorKbps: ctx.floor, carryingKbps: ctx.available,
          reason: `${camera.name}'s ${encode} floor of ${ctx.floor} kb/s costs `
            + `${atIp(ctx.floor)} kb/s on the link and only ${ctx.available} kb/s is `
            + `available; nothing was changed`,
        },
        spend: inForce, allowance,
      };
    }

    const want = Math.min(ctx.ceiling, Math.max(ctx.floor, allowance));
    const outside = inForce < ctx.floor || inForce > ctx.ceiling;
    const moved = Math.abs(want - inForce) >= this.hysteresisKbps;
    const refusal = this.refusedRate.get(encode);
    if (refusal !== undefined && refusal.want === want && refusal.inForce === inForce) {
      return {
        decision: this.holdRate(camera, encode, inForce, at, refusal.reason),
        spend: inForce, allowance,
      };
    }
    if (!outside && !moved) {
      return {
        decision: this.holdRate(camera, encode, inForce, at,
          `the link affords ${want} kb/s and the ${encode} is already at ${inForce}`),
        spend: inForce, allowance,
      };
    }

    this.refusedRate.delete(encode);
    this.issue(this.channel.retune(camera, encode, want), (reason) => {
      this.refusedRate.set(encode, { reason, want, inForce });
    });
    return {
      decision: {
        action: "rate", camera: camera.id, encode, kbps: want, at,
        reason: outside
          ? `the applied envelope is ${ctx.floor}–${ctx.ceiling} kb/s and the ${encode} `
            + `was running at ${inForce}; it holds ${want} kb/s`
          : `the link leaves ${ctx.available} kb/s for the ${encode}; it holds `
            + `${want} kb/s, inside its applied ${ctx.floor}–${ctx.ceiling}`,
      },
      spend: want, allowance,
    };
  }

  /**
   * The size ladder (spec §8.1): down a rung after `tDown` pinned at the
   * floor, up a rung after `tUp` of room, and never outside the applied
   * ladder.
   *
   * **A held size never steps.** `preview.size` naming a rung rather than
   * `"auto"` is the operator having chosen the picture, and a controller that
   * overrode it would be deciding something they had already decided.
   */
  private sizeFor(camera: Camera, ctx: {
    now: number; running: RunningEncodes; allowance: number;
    shortfall: boolean; link: LinkReport; carrying: number;
  }): Decision {
    const at = ctx.now;
    const shape = ctx.running.shape;
    const current = shape?.size ?? null;

    if (shape === null) {
      return this.holdSize(camera, null, at,
        `${camera.name} has no preview branch whose size could step`);
    }
    if (camera.preview.size !== "auto") {
      return this.holdSize(camera, shape.size, at,
        `the picture is held at ${camera.preview.size}: the operator chose it, so the `
        + "ladder leaves it alone");
    }
    if (camera.preview.mode === "fixed") {
      return this.holdSize(camera, current, at,
        "the preview is Fixed: its rate and its size are the operator's");
    }
    if (ctx.shortfall) {
      /**
       * **A link too thin for the floor is the one case the ladder must
       * still move** — the operator's decision, made 2026-09-06.
       *
       * This held the size and reported the shortfall, on the reading that
       * "report the shortfall and change nothing" covers the ladder too. It
       * is the wrong way round: a smaller picture is exactly what makes a
       * floor's worth of bits go further, so the moment the floor will not
       * fit is the moment stepping down is worth most. Holding leaves a
       * picture that breaks up rather than one that degrades.
       *
       * The *rate* still changes nothing — there is no rate that fits, which
       * is what the shortfall says. Only the size moves, and only downward:
       * a link that cannot carry the floor is never evidence of headroom.
       * `tDown` still applies, so this is not a step per tick.
       */
      const rungsNow = PREVIEW_RUNGS as readonly PreviewRung[];
      const bottomNow = rungsNow.indexOf(camera.preview.ladder_bottom);
      const hereNow = rungsNow.indexOf(shape.size);
      // A shortfall *is* being pinned at the floor and worse, so it starts the
      // same clock a pin does rather than a second one beside it.
      this.pinnedSince ??= at;
      this.headroomSince = null;
      const held = at - this.pinnedSince;
      if (hereNow >= 0 && bottomNow >= 0 && hereNow < bottomNow && held >= this.tDown) {
        return this.step(camera, shape, rungsNow[hereNow + 1], at,
          "the preview's floor does not fit in what the link is carrying, so the "
          + "picture steps down to make those bits go further");
      }
      return this.holdSize(camera, current, at,
        hereNow >= 0 && hereNow >= bottomNow
          ? "the preview's floor does not fit in what the link is carrying, and the "
            + "picture is already at the smallest size the operator allowed"
          : "the preview's floor does not fit in what the link is carrying; the rate "
            + "cannot change, and the picture is stepping down");
    }

    const rungs = PREVIEW_RUNGS as readonly PreviewRung[];
    const top = rungs.indexOf(camera.preview.ladder_top);
    const bottom = rungs.indexOf(camera.preview.ladder_bottom);
    const here = rungs.indexOf(shape.size);

    // Outside the applied ladder, and back inside it at once. This is the
    // envelope rather than the ladder — an operator who narrows the ladder
    // under a running picture has said where it may be, and a timer would
    // leave it outside for tUp seconds first. It happens without a respawn
    // because `compose()` bakes in `ladder_bottom` for an automatic size, so
    // moving `ladder_top` alone changes no launch line.
    if (here >= 0 && here < top) {
      return this.step(camera, shape, rungs[top], at,
        `the applied ladder now tops out at ${camera.preview.ladder_top}`);
    }
    if (here >= 0 && here > bottom) {
      return this.step(camera, shape, rungs[bottom], at,
        `the applied ladder now bottoms out at ${camera.preview.ladder_bottom}`);
    }

    const pinned = ctx.allowance <= camera.preview.floor_kbps + this.hysteresisKbps;
    const affordable = ctx.allowance >= camera.preview.ceiling_kbps + this.hysteresisKbps;
    const queueing = this.rttFloor !== null
      && ctx.link.rtt > this.rttFloor + this.rttInflationMs;
    const oversubscribed = ctx.link.egress > ctx.carrying;
    const room = affordable && !queueing && !oversubscribed;

    if (pinned) {
      this.headroomSince = null;
      this.pinnedSince ??= at;
    } else if (room) {
      this.pinnedSince = null;
      this.headroomSince ??= at;
    } else {
      this.pinnedSince = null;
      this.headroomSince = null;
    }

    if (pinned && this.pinnedSince !== null && at - this.pinnedSince >= this.tDown) {
      if (here >= bottom) {
        return this.holdSize(camera, shape.size, at,
          `the preview is pinned at its floor and ${shape.size} is the bottom of the `
          + "applied ladder");
      }
      return this.step(camera, shape, rungs[here + 1], at,
        `the preview has been pinned at its ${camera.preview.floor_kbps} kb/s floor for `
        + `${seconds(this.tDown)}`);
    }
    if (room && this.headroomSince !== null && at - this.headroomSince >= this.tUp) {
      if (here <= top) {
        return this.holdSize(camera, shape.size, at,
          `the link has room and ${shape.size} is the top of the applied ladder`);
      }
      return this.step(camera, shape, rungs[here - 1], at,
        `the link has carried more than the preview's ${camera.preview.ceiling_kbps} kb/s `
        + `ceiling for ${seconds(this.tUp)}`);
    }

    if (pinned) {
      return this.holdSize(camera, shape.size, at,
        `pinned at the floor for ${seconds(at - (this.pinnedSince ?? at))} of the `
        + `${seconds(this.tDown)} a step down needs`);
    }
    if (room) {
      return this.holdSize(camera, shape.size, at,
        `room above the ceiling for ${seconds(at - (this.headroomSince ?? at))} of the `
        + `${seconds(this.tUp)} a step up needs`);
    }
    if (affordable && queueing) {
      return this.holdSize(camera, shape.size, at,
        `the round trip has risen to ${Math.round(ctx.link.rtt)} ms against this link's `
        + `own best of ${Math.round(this.rttFloor ?? ctx.link.rtt)} ms: a queue is not `
        + "room to grow into");
    }
    if (affordable && oversubscribed) {
      return this.holdSize(camera, shape.size, at,
        `${ctx.link.egress} kb/s is leaving on a link carrying ${ctx.carrying}: `
        + "there is no room to grow into");
    }
    return this.holdSize(camera, shape.size, at,
      `the preview has ${ctx.allowance} kb/s, between its floor and its ceiling; `
      + `${shape.size} is the size that suits it`);
  }

  private step(
    camera: Camera, shape: PreviewShape, size: PreviewRung, at: number, why: string,
  ): Decision {
    const refusal = this.refusedSize;
    if (refusal !== null && refusal.want === size && refusal.inForce === shape.size) {
      return this.holdSize(camera, shape.size, at, refusal.reason);
    }
    // A step is earned once and then waited for again from scratch, which is
    // what stops a link sitting on a boundary from walking the ladder up and
    // straight back down.
    this.pinnedSince = null;
    this.headroomSince = null;
    this.refusedSize = null;
    // The rate the branch is *running*, not the rate the configuration asks
    // for: a rung change moves the size and nothing else, and a pipeline
    // whose framerate has not caught up with an apply must not have it
    // changed by a step of the ladder.
    this.issue(this.channel.reconfigurePreview(camera, { size, fps: shape.fps }), (reason) => {
      this.refusedSize = { reason, want: size, inForce: shape.size };
    });
    return {
      action: "size", camera: camera.id, encode: "preview", size, at,
      reason: `${why}; the picture steps from ${shape.size} to ${size}`,
    };
  }

  private holdRate(
    camera: Camera, encode: EncodeName, kbps: number | null, at: number, reason: string,
  ): Decision {
    return { action: "hold-rate", camera: camera.id, encode, kbps, at, reason };
  }

  private holdSize(
    camera: Camera, size: PreviewRung | null, at: number, reason: string,
  ): Decision {
    return { action: "hold-size", camera: camera.id, encode: "preview", size, at, reason };
  }

  /** The three subjects, all holding, for one reason that covers all three. */
  private allHolds(
    camera: Camera, running: RunningEncodes | null, now: number, reason: string,
  ): Decision[] {
    return [
      this.holdRate(camera, "stream", running?.stream ?? null, now, reason),
      this.holdRate(camera, "preview", running?.preview ?? null, now, reason),
      this.holdSize(camera, running?.shape?.size ?? null, now, reason),
    ];
  }

  /**
   * Send a command and remember only what the answer says.
   *
   * `notControllable` is latched by the caller's `refuse` so the same request
   * is not made again on the next tick and every tick after it — a control
   * that reports it is setting something a pipeline cannot be told is K-48
   * with an extra step. A *different* request is still made, because the
   * circumstances that produced the refusal have changed.
   *
   * A rejected promise is treated as a refusal for the same reason
   * `supervisor.ts` swallows an EPIPE: an unhandled rejection takes the whole
   * daemon down, and the daemon is the device.
   */
  private track(work: Promise<unknown>): void {
    this.outstanding.add(work);
    void work.then(() => this.outstanding.delete(work), () => this.outstanding.delete(work));
  }

  private issue<T>(sent: Promise<Ack<T>>, refuse: (reason: string) => void): void {
    this.track(sent.then(
      (ack) => { if ("notControllable" in ack) refuse(ack.notControllable); },
      (error: unknown) => { refuse(`the command was not carried out: ${String(error)}`); },
    ));
  }
}

/** A duration an operator reads, from one an interval is measured in. */
function seconds(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}
