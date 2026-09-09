// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";
import type { Camera, PreviewRung } from "../schema/config.js";
import type { RunningEncodes } from "./pipeline.js";
import { atIp } from "./present.js";
import type { Decision, LinkReport } from "./rate.js";

/**
 * Who is watching, what each of them is being sent, and what that costs
 * (R-VID-11, R-VID-13, R-VID-14; spec §8.2).
 *
 * **A viewer is a browser session, not a camera page component.** Two pages
 * of one camera open in one session are one viewer watching one camera, and
 * they share one subscription — otherwise closing one of them would end the
 * other's picture, and a page opened twice would be charged to the uplink
 * twice while only one copy left the aircraft.
 *
 * ## What this file is for
 *
 * `rate.ts` decides what the encoders do; this decides nothing about them.
 * It answers three questions that file cannot:
 *
 *  - *Whose measurement is evidence?* Only an active video subscriber of the
 *    camera in question (spec §8.2). A browser on stills is not measuring the
 *    path the preview leaves on, and a viewer that has gone is not measuring
 *    anything at all.
 *  - *What is actually leaving?* One encode watched by three browsers is
 *    three transmissions and one encode, and an operator asking what a
 *    picture costs has to be told the first number, not the second.
 *  - *What does this browser say on its own picture?* The per-camera and
 *    per-viewer scopes, combined into one message per picture.
 *
 * ## Three things it will not do
 *
 * - **Republish a statistic with a fresh timestamp.** A report is stamped
 *   once, with the daemon's clock, at the moment it arrives, and it is handed
 *   on once, then. Nothing here re-sends a stored measurement on a later
 *   tick: `rate.ts` refuses to treat a stale report as headroom, and a
 *   mechanism upstream of it that re-dated one would make that refusal
 *   unreachable. `mine.statsAt` carries that same stamp out to the page, so a
 *   reading that has stopped moving is visible as one rather than looking
 *   current for ever.
 * - **Change a configured output.** A page leaving ends that browser's own
 *   delivery and nothing else. An RTSP, SRT or RTP output is a stored
 *   decision of the operator's (§8.6) and it goes on leaving the aircraft
 *   whether or not anyone has a browser open — this file is handed the
 *   applied cameras to *read*, and writes nothing anywhere.
 * - **Raise the shared encode for one viewer.** Full rate moves that browser
 *   on to the main stream, which is already being encoded; it does not touch
 *   the preview encode every other viewer is watching, and it does not move
 *   anyone else off stills.
 */

/** What a browser has asked for, per camera. */
export type Want = "video" | "stills" | "off";

/**
 * How often a stills viewer is sent a frame, in ms (R-VID-14).
 *
 * One figure, here, that `video/stills.ts` takes its timer from and this
 * file promises every stills subscriber as `mine.interval` — so the interval
 * a picture is told and the interval frames are actually taken at cannot be
 * two numbers.
 */
export const STILLS_INTERVAL_MS = 5_000;

/** The still this device holds for a camera, as this file needs to know it:
 *  when it was taken and how big it is. `video/stills.ts` holds the rest. */
export interface StillHeld {
  readonly at: number;
  readonly bytes: number;
}

/**
 * What one transmitted copy of a still costs, in kb/s at IP (R-VID-11,
 * R-VID-14).
 *
 * **A rate, from a size and the interval it is sent at.** A still is not a
 * stream; what the uplink carries is one JPEG every interval, per browser
 * that fetches it, and that is `bytes × 8 / interval`. Stated at IP like every
 * other figure on this console, so a still copy and a video copy add up in
 * one path total rather than two layers.
 */
export function stillCostKbps(bytes: number, intervalMs: number): number {
  if (!(bytes > 0) || !(intervalMs > 0)) return 0;
  return atIp((bytes * 8) / intervalMs);
}

/**
 * One browser's own measurement of the path its picture is arriving on.
 *
 * `rtt`, `loss`, `egress` and `capacity` are what `rate.ts` reasons about and
 * mean exactly what they mean there — both rates in kb/s **at IP**. The rest
 * is what the browser can say about the picture itself and nothing else can:
 * `frameAge` is how long ago it last painted a frame, `size` and `fps` are
 * what it is actually rendering, which is not always what was asked for.
 *
 * **No timestamp.** The daemon stamps it on arrival, in the daemon's clock.
 * A browser's own wall clock cannot be compared with this one, and a report
 * carrying its own age would be a browser telling this device how fresh to
 * consider it.
 */
export interface ViewerStats {
  readonly camera: string;
  /** Round-trip time, in ms. */
  readonly rtt: number;
  /** The fraction of what was sent that did not arrive, 0–1. */
  readonly loss: number;
  /** What is arriving on this path, kb/s at IP. */
  readonly egress: number;
  /** What this path is measured to carry, kb/s at IP. */
  readonly capacity: number | null;
  readonly receiverBufferMs?: number;
  readonly decodeMs?: number;
  /** Milliseconds since this browser last painted a frame. */
  readonly frameAge?: number;
  /** What it is rendering — `"1280x720"`, or whatever it actually got. */
  readonly size?: string;
  readonly fps?: number;
}

/** A measurement, tagged with the camera it is about. What `Viewers` hands to
 *  whatever adapts the rate; `LinkReport` is `rate.ts`'s own half of it. */
export interface CameraReport extends LinkReport {
  readonly camera: string;
}

/** The shared preview encode: one per camera, whoever is watching it. */
export interface SharedState {
  readonly mode: "adaptive" | "fixed";
  /** The rung the preview branch is actually running, never the one asked
   *  for. Null where nothing is running to have one. */
  readonly size: PreviewRung | null;
  readonly fps: number | null;
  readonly kbps: number | null;
  readonly floor: number;
  readonly ceiling: number;
  /** At or below the applied floor, or the controller has reported that even
   *  the floor does not fit. Either way there is no room left to give back. */
  readonly pinned: boolean;
  /** The rung the operator chose, or null where the ladder is free to step. */
  readonly held: PreviewRung | null;
  /** The last thing the rate controller decided about this preview, and why. */
  readonly step: { readonly reason: string; readonly at: number } | null;
}

/** One browser's own delivery of one camera. */
export interface MineState {
  readonly receiverBufferMs?: number | null;
  readonly decodeMs?: number | null;
  readonly delivery: Want;
  /** The media path this browser is being served from, or null when off. */
  readonly source: string | null;
  /** A preview rung on video; on stills, the frame's own shape as the host
   *  reported it, which is the capture size and not a rung. */
  readonly size: string | null;
  readonly fps: number | null;
  readonly kbps: number | null;
  /**
   * Milliseconds since this browser last painted, as *it* measured it — on
   * video. On stills, the age of the still this device is holding for the
   * camera, as *this device* measured it (R-VID-14): a browser showing an
   * `<img>` has no media clock to report, and the daemon is the one thing
   * that knows when the frame was taken.
   */
  readonly frameAge: number | null;
  /** The stills interval, in ms, while this browser is on stills. */
  readonly interval: number | null;
  readonly fullRate: boolean;
  /**
   * When this daemon received the statistic the three readings above came
   * from — the freshness tag §8.2 asks for. Null before a browser has
   * reported anything, and deliberately **not** moved by anything but a new
   * report arriving.
   */
  readonly statsAt: number | null;
}

/**
 * What a picture costs, at IP, three ways (spec §8.2).
 *
 * Three numbers and never one, because they answer three different
 * questions and none of them is the sum of the others:
 *
 *  - `mine` — every copy being transmitted **to this browser**, across every
 *    camera it has subscribed to. What holding Full rate costs *you*.
 *  - `shared` — what the preview encode itself costs, once, however many
 *    browsers are watching it.
 *  - `path` — every copy leaving this device, counted **once each**: the
 *    configured outputs, every viewer's video, and every still. This is the
 *    figure that grows when a second browser opens the same camera, and the
 *    one R-VID-11 is about.
 */
export interface CostState {
  readonly mine: number;
  readonly shared: number;
  readonly path: number;
}

/**
 * The overlay the picture draws, composed here (spec §8.2: "the picture draws
 * the resulting state without depending on the deck or a second rate
 * algorithm").
 *
 * Every field is the exact string `YonderStateOverlay` puts on screen. The
 * words are composed where they have tests, not in a Vue component, for the
 * same reason every other rendering in this package is.
 */
export interface OverlayState {
  readonly head: "adaptive" | "floor" | "held" | "fixed" | "full-rate" | "stills";
  readonly size: string;
  readonly rate: string;
  readonly bitrate: string;
  readonly detail: string;
  readonly step: string;
  readonly cost: {
    readonly view: string;
    readonly encode: string;
    readonly path: string;
  };
}

/** One picture's whole state, per camera and per viewer (spec §8.2). */
export interface PreviewState {
  readonly camera: string;
  readonly viewer: string;
  readonly revision: number;
  /** When this state was composed, in the daemon's clock. */
  readonly at: number;
  readonly shared: SharedState;
  readonly mine: MineState;
  readonly cost: CostState;
  readonly overlay: OverlayState;
}

export interface ViewersOptions {
  /**
   * The **applied** cameras, asked again every time anything is composed.
   * Never a draft, for the reason `rate.ts` gives: a draft is what an
   * operator is still typing.
   */
  readonly cameras: () => readonly Camera[];
  /** What each camera's pipeline is actually running — `EncoderChannel.
   *  inForce`. Never the configuration: that pair is K-48. */
  readonly inForce: (camera: string) => RunningEncodes | null;
  readonly clock?: Clock;
  /**
   * How long a Full rate hold lasts without a renewal.
   *
   * A lease rather than a latch, and it is the "expiry" of §8.2's own list of
   * the six things that end the request. Release, cancel and blur all send a
   * release; a browser that was closed, crashed or driven into a tunnel sends
   * nothing at all, and the one thing that must not happen then is the
   * aircraft going on transmitting a full-rate copy over a cellular uplink
   * for the rest of the flight.
   */
  readonly fullRateLeaseMs?: number;
  /**
   * How long a viewer that has said nothing goes on being counted.
   *
   * The other half of the same argument, one level up: a browser that has
   * gone is not costing the path anything, and a cost figure that includes it
   * is wrong in the direction that makes an operator turn a camera off for
   * nothing.
   */
  readonly idleMs?: number;
  /** How often a stills viewer is sent a frame. `STILLS_INTERVAL_MS`, which
   *  is also what `video/stills.ts` takes them at. */
  readonly stillsIntervalMs?: number;
  /**
   * The still this device holds for a camera, or null — `Stills.latest`.
   *
   * What a stills viewer's `frameAge` is read from, and what its `size` is
   * read from. Injected rather than reached for, so this file stays a
   * register of who is watching and never touches a file.
   */
  readonly stillFor?: (camera: string) => (StillHeld & {
    readonly width?: number | null; readonly height?: number | null;
  }) | null;
  /** Published on every change, and on every reconnect. */
  readonly onState?: (state: PreviewState) => void;
  /**
   * One viewer's measurement, for whatever adapts the rate.
   *
   * Called **once, as the report arrives**, and only for a browser that is an
   * active video subscriber of that camera. Never again for the same report:
   * see this file's header on why.
   */
  readonly onReport?: (report: CameraReport) => void;
}

const FULL_RATE_LEASE_MS = 15_000;
const IDLE_MS = 60_000;
/** Ten subdivisions plus the partial bucket preceding the current window. */
const STILL_TRAFFIC_SUBDIVISIONS = 10;
const STILL_TRAFFIC_BUCKETS = STILL_TRAFFIC_SUBDIVISIONS + 1;

interface StillTrafficBucket {
  slot: number;
  /** Latest transmission represented by this bucket. */
  at: number;
  bytes: number;
}

/** One browser's subscription to one camera. */
interface Subscription {
  want: Want;
  /** When the Full rate hold expires, or null when it is not held. */
  fullRateUntil: number | null;
  stats: ViewerStats | null;
  statsAt: number | null;
  /** Thumbnail generation demand, independent of the selected delivery. */
  stillDemand: boolean;
  /** Actual delivered JPEG bytes in a bounded rolling interval. */
  stillTraffic: StillTrafficBucket[];
  /** The last time this browser said anything at all about this camera. */
  heardAt: number;
  revision: number;
  /** The last state published for this pair, less its revision and its
   *  composition time — what "on change" is judged against. */
  published: string | null;
}

export class Viewers {
  private readonly cameras: () => readonly Camera[];
  private readonly running: (camera: string) => RunningEncodes | null;
  private readonly clock: Clock;
  private readonly leaseMs: number;
  private readonly idleMs: number;
  private readonly stillsIntervalMs: number;
  private readonly stillFor: NonNullable<ViewersOptions["stillFor"]>;
  private readonly onState: (state: PreviewState) => void;
  private readonly onReport: (report: CameraReport) => void;

  /** viewer → camera → subscription. */
  private readonly subs = new Map<string, Map<string, Subscription>>();
  /** camera → the last decision the rate controller took about its preview. */
  private readonly steps = new Map<string, { reason: string; at: number }>();

  constructor(opts: ViewersOptions) {
    this.cameras = opts.cameras;
    this.running = opts.inForce;
    this.clock = opts.clock ?? systemClock;
    this.leaseMs = opts.fullRateLeaseMs ?? FULL_RATE_LEASE_MS;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.stillsIntervalMs = opts.stillsIntervalMs ?? STILLS_INTERVAL_MS;
    this.stillFor = opts.stillFor ?? ((): null => null);
    this.onState = opts.onState ?? ((): void => {});
    this.onReport = opts.onReport ?? ((): void => {});
  }

  /**
   * This browser wants video, stills or nothing, of this camera.
   *
   * **Idempotent per browser and camera.** A second page of the same camera
   * in the same session finds the subscription already there and joins it,
   * which is what makes two tabs one transmission rather than two.
   */
  subscribe(viewer: string, camera: string, want: Want): void {
    const sub = this.hold(viewer, camera);
    if (sub === null) return;
    sub.want = want;
    // Video is what a Full rate hold is a variety of. A browser that has
    // asked for stills or for nothing is not holding the main stream open.
    if (want !== "video") sub.fullRateUntil = null;
    this.publishAll();
  }

  /**
   * Full rate, while it is held (R-VID-13).
   *
   * `held` true starts or renews the lease; false ends it at once — release,
   * cancel and blur are all the browser saying false, and there is nothing
   * for this file to tell them apart by, nor any reason to.
   *
   * It moves **this viewer** on to the main stream, which is already running
   * for the ground station. It does not raise the shared preview encode, and
   * it does not move any other viewer anywhere.
   */
  fullRate(viewer: string, camera: string, held: boolean): void {
    const sub = this.hold(viewer, camera);
    if (sub === null) return;
    // Only a video subscriber can hold the main stream: a browser on stills
    // asking for full rate is asking for two contradictory things, and the
    // one it asked for most recently is stills.
    sub.fullRateUntil = held && sub.want === "video" ? this.clock.now() + this.leaseMs : null;
    this.publishAll();
  }

  /**
   * One browser's measurement (spec §8.2).
   *
   * Stamped here, once, with this daemon's own clock, and handed on here,
   * once. A viewer that is not watching this camera's video is recorded and
   * **not** passed to the rate controller: adaptation uses the most
   * constrained fresh report among its *active video subscribers*, and a
   * browser showing thumbnails is not one of them.
   */
  report(viewer: string, stats: ViewerStats): void {
    const sub = this.hold(viewer, stats.camera);
    if (sub === null) return;
    const at = this.clock.now();
    sub.stats = stats;
    sub.statsAt = at;
    if (sub.want === "video") {
      this.onReport({
        camera: stats.camera,
        viewer,
        rtt: stats.rtt,
        loss: stats.loss,
        egress: stats.egress,
        capacity: stats.capacity,
        encode: sub.fullRateUntil !== null && sub.fullRateUntil > at ? "stream" : "preview",
        at,
      });
    }
    this.publishAll();
  }

  /**
   * This browser has gone: its session ended, or its last page closed.
   *
   * **Its delivery stops and nothing else changes.** No configured output is
   * touched, no encode is stopped, and no other viewer's state moves except
   * its cost, which genuinely falls because a transmission ended.
   */
  unsubscribe(viewer: string): void {
    if (!this.subs.delete(viewer)) return;
    this.publishAll();
  }

  /** One camera's page closed. The browser's other cameras are untouched. */
  leave(viewer: string, camera: string): void {
    const held = this.subs.get(viewer);
    if (held === undefined || !held.delete(camera)) return;
    if (held.size === 0) this.subs.delete(viewer);
    this.publishAll();
  }

  /**
   * What the rate controller decided, on its way to the picture.
   *
   * `rate.ts` reports every decision and publishes none of them, deliberately
   * — "a mechanism that both decides and publishes has two reasons to
   * change". This is the other end of that sentence.
   *
   * **Which of a tick's decisions becomes the step line**, in this order: a
   * shortfall, because a link that cannot carry the floor is the one thing an
   * operator must be told; then a rung actually stepping, because it is the
   * change they can see; then a rate actually moving; and only then a hold,
   * whose sentence says what the ladder is waiting for. A hold is still a
   * decision and is still shown — reporting only changes is how K-49 reads
   * from the outside — it is simply the least urgent of the four.
   */
  decided(decisions: readonly Decision[]): void {
    for (const camera of new Set(decisions.map((d) => d.camera))) {
      const mine = decisions.filter((d) => d.camera === camera && d.encode === "preview");
      const chosen = mine.find((d) => d.action === "shortfall")
        ?? mine.find((d) => d.action === "size")
        ?? mine.find((d) => d.action === "rate")
        ?? mine.find((d) => d.action === "hold-size")
        ?? mine[0];
      if (chosen === undefined) continue;
      this.steps.set(camera, { reason: chosen.reason, at: chosen.at });
    }
    this.publishAll();
  }

  /**
   * Let go of what has expired: Full rate holds nobody renewed, and browsers
   * that have said nothing for long enough to have gone.
   *
   * Called from whatever ticks the rate controller, before it decides, so a
   * hold that has run out is not still being charged to the path when the
   * allowance is worked out.
   */
  sweep(now: number = this.clock.now()): void {
    for (const [viewer, cameras] of [...this.subs]) {
      for (const [camera, sub] of [...cameras]) {
        if (now - sub.heardAt > this.idleMs) {
          cameras.delete(camera);
          continue;
        }
        if (sub.fullRateUntil !== null && now - sub.fullRateUntil >= 0) sub.fullRateUntil = null;
      }
      if (cameras.size === 0) this.subs.delete(viewer);
    }
    this.publishAll();
  }

  /**
   * One picture's state, composed now (spec §8.2).
   *
   * It does **not** move the revision: a revision is what a publish did, and
   * a caller merely asking what the state is has not changed it. A route that
   * answers a browser's own post answers with the state the post produced,
   * which has already been published.
   */
  runtime(camera: string) {
    const run = this.running(camera);
    return { streamKbps: run?.stream ?? null, previewKbps: run?.preview ?? null,
      shape: run?.shape ?? null, decision: this.steps.get(camera) ?? null };
  }

  state(camera: string, viewer: string): PreviewState {
    return this.compose(camera, viewer, this.clock.now());
  }

  /** Every viewer of a camera, in the order they first subscribed. */
  watching(camera: string): readonly string[] {
    return [...this.subs].filter(([, c]) => c.has(camera)).map(([v]) => v);
  }

  /**
   * Every enabled camera with at least one browser on its stills, in
   * configured order (R-VID-14; spec §8.6).
   *
   * What `video/stills.ts` asks on every tick, and the whole of how "one
   * still per camera per interval, whoever is watching" is decided: a camera
   * is in this list once however many browsers want it, and not at all when
   * none does — so three viewers cost the pipeline one frame, and no viewer
   * costs it nothing.
   */
  wantingStills(): readonly string[] {
    return this.cameras()
      .filter((camera) => camera.enabled)
      .map((camera) => camera.id)
      .filter((id) => this.watching(id).some((v) => {
        const sub = this.subs.get(v)?.get(id);
        return sub?.want === "stills" || sub?.stillDemand === true;
      }));
  }

  /** Request or release periodic still generation without changing video delivery. */
  requestStills(viewer: string, camera: string, wanted: boolean): void {
    const sub = this.hold(viewer, camera);
    if (sub === null) return;
    sub.stillDemand = wanted;
    this.publishAll();
  }

  /**
   * One copy of a still left this device for this browser (R-VID-11).
   *
   * Called by the route that serves the bytes, once per answer — which is
   * what makes two browsers on one camera's stills two transmissions of one
   * image, and the same browser fetching twice two transmissions too. What
   * is recorded is the size of the copy and when it went; what a stills
   * copy *costs* is that size over the interval it is sent at, worked out
   * where the cost is composed.
   *
   * The transmission is independent of selection: a browser on live video
   * may also receive the active thumbnail, and a fetch cannot silently turn
   * an `off` selection into continuing generation demand. Eleven rolling
   * time buckets bound memory while retaining every delivered
   * byte. Expiry has one-tenth-interval granularity because transmissions in
   * the same bucket share its latest timestamp.
   */
  transmitted(viewer: string, camera: string, bytes: number): void {
    const sub = this.hold(viewer, camera);
    if (sub === null || !Number.isFinite(bytes) || bytes <= 0) return;
    const now = this.clock.now();
    const bucketMs = Math.max(1, Math.ceil(this.stillsIntervalMs / STILL_TRAFFIC_SUBDIVISIONS));
    const slot = Math.floor(now / bucketMs);
    const index = slot % STILL_TRAFFIC_BUCKETS;
    const bucket = sub.stillTraffic[index];
    if (bucket === undefined || bucket.slot !== slot) {
      sub.stillTraffic[index] = { slot, at: now, bytes };
    } else {
      bucket.at = now;
      bucket.bytes += bytes;
    }
    this.publishAll();
  }

  /**
   * Every still copy leaving this device, summed, in kb/s at IP — what the
   * strip under the picture states as `… kb/s of stills · counted in Path
   * total` (blueprint L-22). Every viewer, every camera, each copy once: the
   * same count `cost.path` includes, taken out on its own.
   */
  stillsKbps(): number {
    let total = 0;
    const now = this.clock.now();
    for (const camera of this.cameras()) {
      if (!camera.enabled) continue;
      for (const watcher of this.watching(camera.id)) {
        total += this.stillCopy(this.subs.get(watcher)?.get(camera.id), now);
      }
    }
    return total;
  }

  /** Recent delivered still bytes for this browser/camera, stated as a rate. */
  private stillCopy(sub: Subscription | undefined, now: number): number {
    if (sub === undefined) return 0;
    const bytes = sub.stillTraffic
      .filter((bucket) => now - bucket.at < this.stillsIntervalMs)
      .reduce((total, bucket) => total + bucket.bytes, 0);
    return stillCostKbps(bytes, this.stillsIntervalMs);
  }

  /** The subscription for this pair, creating it if the camera is configured
   *  and refreshing what it was last heard from. Null for a camera this
   *  device does not have — a browser cannot invent one by posting. */
  private hold(viewer: string, camera: string): Subscription | null {
    if (!this.cameras().some((c) => c.id === camera)) return null;
    let cameras = this.subs.get(viewer);
    if (cameras === undefined) {
      cameras = new Map();
      this.subs.set(viewer, cameras);
    }
    const held = cameras.get(camera);
    const now = this.clock.now();
    if (held !== undefined) {
      held.heardAt = now;
      return held;
    }
    const made: Subscription = {
      want: "off", fullRateUntil: null, stats: null, statsAt: null,
      stillDemand: false, stillTraffic: [],
      heardAt: now, revision: 0, published: null,
    };
    cameras.set(camera, made);
    return made;
  }

  /**
   * Publish every picture whose state has actually changed.
   *
   * "On change" is judged against the whole composed message less its
   * revision and its composition time — the two fields that would otherwise
   * make every comparison differ and turn "on change" into "on every tick".
   */
  private publishAll(): void {
    const now = this.clock.now();
    for (const [viewer, cameras] of this.subs) {
      for (const [camera, sub] of cameras) {
        const state = this.compose(camera, viewer, now);
        const { revision: _r, at: _a, ...rest } = state;
        const shape = JSON.stringify(rest);
        if (shape === sub.published) continue;
        sub.published = shape;
        sub.revision += 1;
        this.onState({ ...state, revision: sub.revision });
      }
    }
  }

  private compose(camera: string, viewer: string, now: number): PreviewState {
    const configured = this.cameras().find((c) => c.id === camera);
    const run = this.running(camera);
    const sub = this.subs.get(viewer)?.get(camera);
    const shared = sharedState(configured, run, this.steps.get(camera) ?? null);
    const mine = this.mineState(camera, configured, run, sub, now);
    const cost = this.costState(camera, viewer, run, now);
    return {
      camera, viewer, revision: sub?.revision ?? 0, at: now,
      shared, mine, cost, overlay: overlayFor(shared, mine, cost),
    };
  }

  private mineState(
    camera: string, configured: Camera | undefined,
    run: RunningEncodes | null, sub: Subscription | undefined, now: number,
  ): MineState {
    const delivery: Want = sub?.want ?? "off";
    const full = delivery === "video" && sub !== undefined && sub.fullRateUntil !== null;
    if (delivery === "off" || configured === undefined) {
      return {
        delivery: "off", source: null, size: null, fps: null, kbps: null,
        // No frame age: nothing is being painted, and the last age this
        // browser reported is about a picture it is no longer being sent.
        frameAge: null, interval: null, fullRate: false,
        statsAt: sub?.statsAt ?? null,
      };
    }
    if (delivery === "stills") {
      // The still this device is holding for the camera — its shape, and
      // its age *as this device measured it* (R-VID-14). Null where there is
      // none yet, or the camera has stopped: nothing is being painted, and
      // an age of nothing is not zero. Whole seconds, because the page draws
      // seconds and a revision per millisecond would be a change per tick.
      const still = this.stillFor(camera);
      const shape = still?.width != null && still.height != null
        ? `${String(still.width)}x${String(still.height)}`
        : null;
      const transmitted = sub === undefined ? 0 : this.stillCopy(sub, now);
      return {
        delivery, source: `${camera}-still`,
        size: shape, fps: null,
        // What this browser's copy costs, or null before one has been sent:
        // a still nothing has transmitted is not a rate.
        kbps: transmitted === 0 ? null : transmitted,
        frameAge: still === null ? null : Math.max(0, Math.floor((now - still.at) / 1000) * 1000),
        interval: this.stillsIntervalMs, fullRate: false,
        statsAt: sub?.statsAt ?? null,
      };
    }
    return {
      delivery,
      source: full ? camera : `${camera}-preview`,
      // The main stream's size is the camera's own; the preview's is
      // whatever rung the branch is running.
      size: full ? null : run?.shape?.size ?? null,
      fps: full ? configured.framerate : run?.shape?.fps ?? null,
      kbps: full ? run?.stream ?? null : run?.preview ?? null,
      frameAge: sub?.stats?.frameAge ?? null,
      receiverBufferMs: sub?.stats?.receiverBufferMs ?? null,
      decodeMs: sub?.stats?.decodeMs ?? null,
      interval: null, fullRate: full,
      statsAt: sub?.statsAt ?? null,
    };
  }

  /**
   * Every transmission leaving this device, counted once each (R-VID-11).
   *
   * A configured output costs what the main stream is running. A viewer on
   * video costs a copy of whichever encode it is being served — the main
   * stream while it holds Full rate, the preview otherwise — so two browsers
   * on one preview cost two copies of one encode, which is what actually
   * leaves. Delivered still bytes are added over their rolling interval,
   * independently of whether that viewer selected video, stills or off.
   * Generation remains one frame per camera; each successful HTTP copy adds
   * its own bytes and expires without a later heartbeat re-dating it.
   */
  private costState(camera: string, viewer: string, run: RunningEncodes | null, now: number): CostState {
    let path = 0;
    let ours = 0;
    for (const configured of this.cameras()) {
      if (!configured.enabled) continue;
      const running = this.running(configured.id);
      const stream = atIp(running?.stream ?? configured.bitrate_kbps);
      const preview = atIp(running?.preview ?? configured.preview.bitrate_kbps);
      for (const output of configured.outputs) if (output.enabled) path += stream;
      for (const watcher of this.watching(configured.id)) {
        const sub = this.subs.get(watcher)?.get(configured.id);
        if (sub === undefined) continue;
        const still = this.stillCopy(sub, now);
        path += still;
        if (watcher === viewer) ours += still;
        if (sub.want === "off" || sub.want === "stills") continue;
        const video = sub.fullRateUntil !== null ? stream : preview;
        path += video;
        if (watcher === viewer) ours += video;
      }
    }
    const shared = atIp(
      run?.preview
      ?? this.cameras().find((c) => c.id === camera)?.preview.bitrate_kbps
      ?? 0,
    );
    return { mine: ours, shared, path };
  }
}

/** The per-camera scope: what the shared preview encode is doing. */
function sharedState(
  camera: Camera | undefined,
  run: RunningEncodes | null,
  step: { reason: string; at: number } | null,
): SharedState {
  if (camera === undefined) {
    return {
      mode: "adaptive", size: null, fps: null, kbps: null, floor: 0, ceiling: 0,
      pinned: false, held: null, step,
    };
  }
  const kbps = run?.preview ?? null;
  return {
    mode: camera.preview.mode,
    size: run?.shape?.size ?? null,
    fps: run?.shape?.fps ?? null,
    kbps,
    floor: camera.preview.floor_kbps,
    ceiling: camera.preview.ceiling_kbps,
    pinned: kbps !== null && kbps <= camera.preview.floor_kbps,
    held: camera.preview.size === "auto" ? null : camera.preview.size,
    step,
  };
}

/**
 * The five head words, in the order an operator needs them.
 *
 * Full rate first — it is this browser's own most expensive fact and the one
 * it can end. Then a stills fall-back, which is the picture not being video
 * at all. Then the floor, which is a caution about the link. Then a size the
 * operator is holding, or a preview they have set to Fixed: both are the
 * ladder deliberately not stepping. Ordinary adaptive operation last, because
 * it is what nothing else being true means.
 */
function overlayFor(shared: SharedState, mine: MineState, cost: CostState): OverlayState {
  const head: OverlayState["head"] = mine.fullRate
    ? "full-rate"
    : mine.delivery === "stills"
      ? "stills"
      : shared.mode === "fixed"
        ? "fixed"
        : shared.pinned
          ? "floor"
          : shared.held !== null ? "held" : "adaptive";
  const size = mine.size ?? shared.size;
  return {
    head,
    size: size === null ? "" : size.replace("x", "×"),
    // A stills viewer has no frame rate; what it has is an interval, and the
    // head line reads `STILLS · every 5 s` (spec §8.2, blueprint L-11) in
    // the slot a rate would otherwise take.
    rate: mine.delivery === "stills"
      ? (mine.interval === null ? "" : `every ${String(mine.interval / 1000)} s`)
      : mine.fps === null ? "" : `${mine.fps} fps`,
    bitrate: mine.kbps === null ? "" : `${mbps(atIp(mine.kbps))} Mb/s`,
    detail: shared.kbps === null
      ? ""
      : `${mbps(atIp(shared.kbps))} of ${mbps(atIp(shared.floor))}–${mbps(atIp(shared.ceiling))}`,
    step: shared.step?.reason ?? "",
    cost: {
      view: `${mbps(cost.mine)} Mb/s`,
      encode: `${mbps(cost.shared)} Mb/s`,
      path: `${mbps(cost.path)} Mb/s`,
    },
  };
}

/** A rate already at IP, as an operator reads it. */
function mbps(kbps: number): string {
  return (kbps / 1000).toFixed(2);
}
