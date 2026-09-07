// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "../apply/types.js";
import { warn } from "../log.js";
import type { Camera } from "../schema/config.js";
import type { RunningEncodes } from "./pipeline.js";
import type { CameraRun } from "./supervisor.js";

/**
 * Recording to the board, and taking a still, off a pipeline that is already
 * running (R-CAM-17, R-CAM-18, R-STO-06).
 *
 * `installer/payload/yonder-pipeline` is what actually builds the branch; this
 * decides nothing about GStreamer and knows nothing about it. What it owns is
 * the four things the host cannot:
 *
 *  - **Where a capture goes, and what it is called.**
 *    `/var/lib/yonder/captures/<camera-id>/`, one directory per camera, and a
 *    filename that is the capture's own timestamp with the shape it was taken
 *    at. That is not decoration: it is what makes the listing sortable, makes
 *    a collision impossible, and lets a capture written by a daemon that has
 *    since restarted still report its size without a sidecar file or a
 *    database to keep in step with the disk.
 *  - **The reserve** (R-STO-06). Recording stops *before* it fills the card,
 *    never by exhausting it. The floor is device-wide because the medium is:
 *    two cameras recording share one reserve, and whichever reaches it first
 *    ends.
 *  - **One operation at a time, per camera.** A second press is refused, not
 *    queued. An operator who presses REC twice must not get two branches on
 *    one tee, and one who presses the shutter while a recording is starting
 *    must not have the two interleave inside the host.
 *  - **Which medium is doing the work.** A camera with its own recorder holds
 *    its own files; the board holds the ones it wrote. A capture the camera
 *    holds is reported as the camera's and **is not fetchable**, because
 *    Yonder never saw the file.
 *
 * ## Three things it will not do
 *
 * - **Drive a camera's own recorder.** Both paths are modelled — the state
 *   says which medium is doing the work and a card-held capture is listed as
 *   the camera's — and no driver is written, because phase 5 is deferred
 *   until the hardware is in hand and a driver for a device nobody can test
 *   is a claim rather than a feature. `CameraMedium` is the seam it will
 *   arrive through; today every camera answers *the board holds this*.
 * - **Decide when to record.** R-CMD-04 and R-CMD-05: nothing here starts a
 *   recording because a flight started, or stops one because a link dropped.
 *   The one thing it ends by itself is a recording that has reached the
 *   reserve, which is a limit of the medium rather than a decision about the
 *   aircraft — and R-STO-06 asks for exactly that.
 * - **Touch a real disk to answer a question about space.** `freeBytes` is
 *   injected, like `Viewers`' clock and for the same reason: a test that
 *   drives the reserve must be able to say what the card has left, and a
 *   default that ran `statfs` would make every test that merely reached this
 *   file a measurement of the machine it ran on.
 */

/** Which medium is holding a capture, and doing the work of making it. */
export type Held = "board" | "camera";

/**
 * One capture, as the console lists it.
 *
 * `at`, `width` and `height` are read out of the **name**, not out of a
 * record kept beside the file: a daemon that restarted has no memory of what
 * it wrote, and the alternative — a sidecar or an index — is a second copy of
 * the truth that goes stale the first time a file is deleted from a shell.
 */
export interface Capture {
  readonly name: string;
  /** When it was taken, epoch ms, from the name. */
  readonly at: number;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly held: Held;
}

/**
 * What one camera's recorder is doing (R-CAM-17, R-STO-06).
 *
 * `since` is what the REC pill counts its elapsed time from. `destination`
 * is the medium doing the work, which is the sentence R-CAM-17 asks the
 * interface to say. `remainingSeconds` is measured **against the reserve**,
 * not against an empty card, so the number an operator reads is the number
 * they actually have.
 */
export interface RecordingState {
  readonly recording: boolean;
  /** Epoch ms, or null when nothing is recording. */
  readonly since: number | null;
  readonly destination: Held;
  /** Seconds of recording the medium has left before the reserve, or null
   *  where nothing knows the rate. */
  readonly remainingSeconds: number | null;
  /**
   * Stills the medium has left before the reserve, or null on a medium this
   * device is not spending.
   *
   * **The same fact as `remainingSeconds`, in the unit the operator is
   * working in.** Photo mode is not a recording, and a page that answered
   * "118 min free" under a shutter key that takes photographs would be
   * stating the headroom in a unit nothing on the screen is about. It is here
   * rather than worked out on the page for this file's own reason: the page
   * has neither the free space nor the reserve, and a browser dividing one
   * guess by another is two copies of a rule that would drift.
   *
   * An estimate, and knowingly so — see `STILL_BYTES_PER_PIXEL`.
   */
  readonly remainingPhotos: number | null;
  /** What the open recording has written so far, or null when none is. */
  readonly bytes: number | null;
  /**
   * Why the last recording ended, when it ended by itself.
   *
   * Null while one is running and after an operator's own stop — a stop
   * somebody pressed needs no explanation. It is here because R-STO-06's
   * "ends by itself" is only honest if the interface can say *that is what
   * happened*: without it, a recording that stopped at the reserve and one
   * the operator stopped are the same silence.
   */
  readonly ended: { readonly at: number; readonly reason: string } | null;
}

/**
 * A refusal, in words an operator reads, with the kind of refusal it is.
 *
 * The kind is here so that a route can answer with the right status without
 * reading the sentence back — the mistake `video/present.ts` records in its
 * own words as deciding from a rendering. Nothing in this file knows what
 * HTTP is.
 */
export interface Refusal {
  readonly refused: string;
  readonly because:
  /** Something is already in flight on this camera. One at a time. */
  | "busy"
  /** The card is at or below the reserve. */
  | "no-space"
  /** No pipeline to record off, or none that takes instruction. */
  | "not-running"
  /** The camera's own medium holds it, and Yonder does not drive that. */
  | "on-camera"
  /** No such camera, or no such capture. */
  | "not-found"
  /** The pipeline was asked and said nothing, or said it could not. */
  | "unanswered";
}

export type Answer<T> = { readonly ok: T } | Refusal;

export function isRefusal<T>(answer: Answer<T>): answer is Refusal {
  return "refused" in answer;
}

/** A capture's bytes, on their way out to a browser. */
export interface CaptureBody {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

/**
 * What this file needs of a running pipeline. `Supervisor` satisfies it as it
 * stands, and a test satisfies it with an object.
 */
export interface PipelineChannel {
  send(camera: string, message: unknown): boolean;
  onMessage(fn: (camera: string, line: string) => void): void;
  state(camera: string): CameraRun;
}

/**
 * A camera that records and photographs to its own medium (R-CAM-17,
 * R-CAM-18).
 *
 * **Modelled, and deliberately not driven.** No camera in this build has one:
 * the default answers *the board holds this* for every camera, and both
 * halves of the requirement are reachable through this seam when the hardware
 * arrives. `captures()` returns what the camera says it holds; nothing here
 * ever offers to fetch or delete one, because Yonder never saw the file.
 */
export interface CameraMedium {
  holds(camera: string): boolean;
  captures(camera: string): Promise<readonly Capture[]>;
}

export interface RecorderOptions {
  /** The one supervisor this process owns. See `PipelineChannel`. */
  readonly channel: PipelineChannel;
  /**
   * The **applied** cameras, asked again every time anything is composed —
   * never a draft, for the reason `rate.ts` gives: a draft is what an
   * operator is still typing.
   */
  readonly cameras: () => readonly Camera[];
  /** `storage.reserve_mb`, read fresh, so an apply that changes it is in
   *  force for the next tick rather than the next reboot. */
  readonly reserveMb: () => number;
  /**
   * Free space on the medium holding `root`, in bytes.
   *
   * Injected and never defaulted: with a default, a test that merely reached
   * this file would be measuring the disk of the machine it ran on, and the
   * reserve is exactly the behaviour that has to be drivable from a test.
   */
  readonly freeBytes: (path: string) => Promise<number>;
  /** Where captures live. `/var/lib/yonder/captures` in production. */
  readonly root?: string;
  readonly clock?: Clock;
  /**
   * What each camera's pipeline is actually running — `EncoderChannel.
   *  inForce`. Read before the configuration, for K-48's reason: the encode a
   * recording is taking off is the one the pipeline holds, not the one the
   * document asks for.
   */
  readonly inForce?: (camera: string) => RunningEncodes | null;
  /** See `CameraMedium`. Defaults to *the board holds everything*. */
  readonly onCamera?: CameraMedium;
  /** How often an open recording is measured against the reserve. */
  readonly watchMs?: number;
  /** How long the pipeline has to answer a still, and a record. */
  readonly stillMs?: number;
  readonly recordMs?: number;
}

/** `/var/lib/yonder/captures` — beside the journal and the remote-state
 *  record, and deliberately neither `/etc` (configuration) nor `/run`
 *  (volatile). A capture outlives a reboot and is not a setting. */
export const CAPTURES_ROOT = "/var/lib/yonder/captures";

/** 0750, matching the installer's mode for /var/lib/yonder itself. */
const CAPTURE_DIR_MODE = 0o750;

const STILL_EXTENSION = "jpg";

/**
 * What one still costs, per pixel, for the count under a Photo-mode shutter
 * key (R-CAM-17). Measured off this project's own captures — see
 * `remainingStills()` for why the pessimistic end of the range is the one
 * taken, and why an estimate is the honest answer here rather than silence.
 */
const STILL_BYTES_PER_PIXEL = 0.15;
const RECORDING_EXTENSION = "mkv";

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  mkv: "video/x-matroska",
};

/**
 * A capture's filename: the moment it was taken, then the shape it was taken
 * at.
 *
 * **The timestamp comes first so the names sort chronologically**, and it
 * carries milliseconds so two captures a second apart — or a still taken
 * during a recording — cannot collide. The shape is on the end because a
 * listing has to report it and nothing else on the disk knows it.
 *
 * Exported because `daemon/routes.ts` matches a name off a URL against this
 * exact pattern before it is joined to a path. One statement of what a name
 * is, in one place: a route that accepted names the lister never produces
 * would be a path-traversal surface, and a route that accepted fewer would
 * make some captures unreachable.
 */
export const CAPTURE_NAME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(\d{1,5})x(\d{1,5})\.(jpg|mkv)$/;

/**
 * A capture name off a URL — the traversal guard, and nothing more.
 *
 * **Deliberately wider than `CAPTURE_NAME` above.** A camera that holds its
 * own captures names its own files, and Yonder does not get to say what it
 * calls them; a route that only accepted this project's naming would make
 * every camera-held capture unaddressable, including the refusal that
 * explains why it cannot be fetched. What it forbids is what a path
 * traversal is made of: it admits no separator of either kind and cannot be
 * `.` or `..`, because it has to begin with a letter or a digit.
 *
 * It is a statement of what may be *asked for*. What may be *served* is
 * decided by the listing: `find` answers only for a capture that is actually
 * in it.
 */
export const SAFE_CAPTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** `2026-09-07T14-22-05-123Z-1280x720.jpg`. ISO 8601 with the two characters
 *  a filename should not carry replaced by the one it may. */
export function captureName(at: number, width: number, height: number, ext: string): string {
  const stamp = new Date(at).toISOString().replaceAll(":", "-").replace(".", "-");
  return `${stamp}-${width}x${height}.${ext}`;
}

/** The facts a name carries, or null where it is not one of ours. */
function readName(name: string): { at: number; width: number; height: number } | null {
  const match = CAPTURE_NAME.exec(name);
  if (match === null) return null;
  const n = (i: number): number => Number(match[i]);
  return {
    at: Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6), n(7)),
    width: n(8),
    height: n(9),
  };
}

/** One line back from the pipeline host. `observed` is what the op produced,
 *  or `{ refused }` where the host declined — see `yonder-pipeline`. Exported
 *  with `parseReply` below so `video/stills.ts`, which drives the same `still`
 *  op on a timer, reads the same envelope rather than a second copy of it. */
export interface Reply {
  readonly id: string;
  readonly continuous: boolean;
  readonly observed: unknown;
}

/** What is being written, per camera. One at most: one pipeline is one
 *  camera, and the host refuses a second branch on the same tee. */
interface Open {
  readonly path: string;
  readonly name: string;
  readonly since: number;
  timer: unknown;
}

const WATCH_MS = 5_000;
/**
 * A still waits on the pipeline host, which itself waits up to two seconds
 * for a fresh frame before refusing. Six seconds leaves room for that refusal
 * to arrive and be reported as a refusal, rather than as this end giving up
 * first and reporting a silence — two different sentences for an operator,
 * and only one of them is true.
 */
const STILL_MS = 6_000;
const RECORD_MS = 6_000;

export class Recorder {
  private readonly channel: PipelineChannel;
  private readonly cameras: () => readonly Camera[];
  private readonly reserveMb: () => number;
  private readonly freeBytes: (path: string) => Promise<number>;
  private readonly root: string;
  private readonly clock: Clock;
  private readonly inForce: (camera: string) => RunningEncodes | null;
  private readonly onCamera: CameraMedium;
  private readonly watchMs: number;
  private readonly stillMs: number;
  private readonly recordMs: number;

  /** One operation at a time, per camera. See `hold`. */
  private readonly busy = new Set<string>();
  private readonly open = new Map<string, Open>();
  private readonly ended = new Map<string, { at: number; reason: string }>();
  private readonly waiting = new Map<string, { camera: string; settle(r: Reply | null): void }>();
  private next = 1;

  constructor(opts: RecorderOptions) {
    this.channel = opts.channel;
    this.cameras = opts.cameras;
    this.reserveMb = opts.reserveMb;
    this.freeBytes = opts.freeBytes;
    this.root = opts.root ?? CAPTURES_ROOT;
    this.clock = opts.clock ?? systemClock;
    this.inForce = opts.inForce ?? ((): null => null);
    this.onCamera = opts.onCamera ?? {
      holds: (): boolean => false,
      captures: (): Promise<readonly Capture[]> => Promise.resolve([]),
    };
    this.watchMs = opts.watchMs ?? WATCH_MS;
    this.stillMs = opts.stillMs ?? STILL_MS;
    this.recordMs = opts.recordMs ?? RECORD_MS;
    this.channel.onMessage((camera, line) => { this.heard(camera, line); });
  }

  // -- what a camera's recorder is doing ---------------------------------

  /**
   * One camera's recording state, read now (R-CAM-17).
   *
   * Asynchronous because the free space it reports is read at the moment it
   * is asked for. A cached figure would be the wrong shape of answer for the
   * one number an operator watches while deciding whether to start.
   */
  async state(id: string): Promise<RecordingState> {
    const camera = this.cameras().find((c) => c.id === id);
    // A pipeline that has stopped has taken the recording with it. Noticed
    // here rather than announced, because nothing tells this file when a
    // pipeline dies — and a page still drawing a REC pill over a camera that
    // is off the air is worse than a late notice.
    if (this.open.has(id) && !this.alive(id)) {
      this.close(id, "the camera's pipeline stopped, and the recording ended with it");
    }
    const open = this.open.get(id);
    const onCamera = this.onCamera.holds(id);
    const free = await this.free();
    return {
      recording: open !== undefined,
      since: open?.since ?? null,
      destination: onCamera ? "camera" : "board",
      // **The medium doing the work, and no other** (R-CAM-17). A camera
      // recording to its own card is not spending this board's, so reporting
      // the board's headroom under it would be a number about the wrong
      // medium — worse than none, because an operator would plan with it.
      // This build does not read a camera's card, so there the answer is that
      // nothing knows.
      remainingSeconds: onCamera || camera === undefined
        ? null
        : this.remaining(free, this.rateKbps(camera)),
      // The same headroom, counted in the unit Photo mode works in.
      remainingPhotos: onCamera || camera === undefined
        ? null
        : this.remainingStills(free, camera),
      bytes: open === undefined ? null : sizeOf(open.path),
      ended: this.ended.get(id) ?? null,
    };
  }

  // -- recording (R-CAM-17, R-STO-06) ------------------------------------

  /** Start or stop this camera's recording. */
  async record(id: string, action: "start" | "stop"): Promise<Answer<RecordingState>> {
    const camera = this.cameras().find((c) => c.id === id);
    if (camera === undefined) return notFound(id);
    if (!this.hold(id)) return busy(id);
    try {
      return action === "start" ? await this.begin(camera) : await this.end(camera);
    } finally {
      this.release(id);
    }
  }

  private async begin(camera: Camera): Promise<Answer<RecordingState>> {
    const id = camera.id;
    if (this.onCamera.holds(id)) {
      return {
        refused: `${id} records to its own medium, and this build does not drive `
          + "that recorder",
        because: "on-camera",
      };
    }
    if (this.open.has(id)) {
      return { refused: `${id} is already recording`, because: "busy" };
    }
    if (!this.alive(id)) {
      return {
        refused: `${id} is not running: there is no pipeline to record from`,
        because: "not-running",
      };
    }
    // **Before anything is written, and that is the whole of R-STO-06.** A
    // check made after the branch is on the tee is a check made after the
    // card has already been written to: the reserve would be crossed first
    // and noticed second, which is the failure the requirement names — "ends
    // by itself when it is reached rather than by exhausting the card".
    const free = await this.free();
    const reserve = this.reserveBytes();
    if (free - reserve <= 0) {
      return {
        refused: `there is no room to record: ${mb(free)} MB free and ${mb(reserve)} MB `
          + "is reserved on this device",
        because: "no-space",
      };
    }

    const at = this.clock.now();
    const name = captureName(at, camera.width, camera.height, RECORDING_EXTENSION);
    const path = this.pathFor(id, name);
    const reply = await this.ask(id, { op: "record", path }, this.recordMs);
    const refusal = refusalIn(reply, id, "record");
    if (refusal !== null) return refusal;
    this.witness(id, reply, "starting a recording");

    this.ended.delete(id);
    const open: Open = { path, name, since: at, timer: null };
    this.open.set(id, open);
    this.arm(id, open);
    return { ok: await this.state(id) };
  }

  private async end(camera: Camera): Promise<Answer<RecordingState>> {
    const id = camera.id;
    const open = this.open.get(id);
    if (open === undefined) {
      return { refused: `${id} is not recording`, because: "not-running" };
    }
    const reply = await this.ask(id, { op: "record-stop" }, this.recordMs);
    if (reply === null) {
      // **The recording is left open.** A pipeline that said nothing may still
      // be writing, and forgetting it here would leave a branch on the tee
      // that nothing could ever stop — and a card filling with a file the
      // console had stopped counting.
      return {
        refused: `${id}'s pipeline did not answer; the recording is still running`,
        because: "unanswered",
      };
    }
    // The host's own answer wins even when it disagrees: it is the thing
    // holding the branch. A refusal here means it is not recording, so
    // neither is this.
    this.close(id, null);
    const refusal = refusalIn(reply, id, "stop");
    if (refusal !== null) return refusal;
    return { ok: await this.state(id) };
  }

  // -- a still (R-CAM-18) ------------------------------------------------

  /**
   * One frame from the running pipeline, written and then reported.
   *
   * **It answers after the file is written, never on dispatch.** A capture
   * reported before it exists is a thumbnail that 404s, and the whole point
   * of waiting for the host's second buffer is that the frame is a real one.
   */
  async photo(id: string): Promise<Answer<Capture>> {
    const camera = this.cameras().find((c) => c.id === id);
    if (camera === undefined) return notFound(id);
    if (!this.hold(id)) return busy(id);
    try {
      if (this.onCamera.holds(id)) {
        return {
          refused: `${id} takes its own photographs to its own medium, and this `
            + "build does not drive that camera",
          because: "on-camera",
        };
      }
      if (!this.alive(id)) {
        return {
          refused: `${id} is not running: there is no pipeline to take a frame from`,
          because: "not-running",
        };
      }
      // A still is a small write, and it is still a write to the same medium.
      // The reserve is what the card keeps back from *video*, and a photograph
      // taken at the floor would spend it.
      const free = await this.free();
      const reserve = this.reserveBytes();
      if (free - reserve <= 0) {
        return {
          refused: `there is no room for a still: ${mb(free)} MB free and ${mb(reserve)} MB `
            + "is reserved on this device",
          because: "no-space",
        };
      }

      const at = this.clock.now();
      const name = captureName(at, camera.width, camera.height, STILL_EXTENSION);
      const path = this.pathFor(id, name);
      const reply = await this.ask(id, { op: "still", path }, this.stillMs);
      const refusal = refusalIn(reply, id, "still");
      if (refusal !== null) return refusal;
      this.witness(id, reply, "taking a still");

      const observed = (reply?.observed ?? {}) as Record<string, unknown>;
      const width = typeof observed.width === "number" ? observed.width : camera.width;
      const height = typeof observed.height === "number" ? observed.height : camera.height;
      if (width !== camera.width || height !== camera.height) {
        // The pipeline is composed from the camera's own capture size, so the
        // two disagreeing is a fault rather than a variation. The name keeps
        // the configured shape, because that is what the rest of the listing
        // is measured in; the journal keeps the discrepancy.
        warn(`${id}: the still is ${width}x${height} and the camera is configured `
          + `for ${camera.width}x${camera.height}`);
      }
      return {
        ok: {
          name, at, bytes: sizeOf(path) ?? 0,
          width: camera.width, height: camera.height, held: "board",
        },
      };
    } finally {
      this.release(id);
    }
  }

  // -- the captures this device is holding --------------------------------

  /** Every capture of this camera, newest first — the board's and the
   *  camera's own, in one list, each saying which. */
  async captures(id: string): Promise<Answer<readonly Capture[]>> {
    if (!this.cameras().some((c) => c.id === id)) return notFound(id);
    const held = await this.onCamera.captures(id);
    const mine: Capture[] = [];
    for (const name of this.listDir(id)) {
      const facts = readName(name);
      if (facts === null) continue;
      const bytes = sizeOf(this.pathFor(id, name));
      // A name that no longer has a file behind it — deleted from a shell
      // between the listing and the stat — is left out rather than listed
      // with a size nobody can serve.
      if (bytes === null) continue;
      mine.push({ name, ...facts, bytes, held: "board" });
    }
    return { ok: [...held, ...mine].sort((a, b) => b.at - a.at) };
  }

  /**
   * One capture's bytes.
   *
   * **A camera-held capture is refused here**, with the reason: Yonder never
   * saw the file, so there is nothing to send. Offering it and failing later
   * would be the console claiming a file it does not have.
   */
  async fetch(id: string, name: string): Promise<Answer<CaptureBody>> {
    const found = await this.find(id, name);
    if (isRefusal(found)) return found;
    try {
      return {
        ok: {
          name,
          contentType: CONTENT_TYPES[extensionOf(name)] ?? "application/octet-stream",
          bytes: readFileSync(this.pathFor(id, name)),
        },
      };
    } catch {
      return { refused: `no capture called "${name}" on ${id}`, because: "not-found" };
    }
  }

  /** One capture, deleted. Camera-held ones are refused, as above. */
  async remove(id: string, name: string): Promise<Answer<{ readonly name: string }>> {
    const found = await this.find(id, name);
    if (isRefusal(found)) return found;
    const open = this.open.get(id);
    if (open !== undefined && open.name === name) {
      return {
        refused: `${id} is recording to "${name}"; stop the recording before deleting it`,
        because: "busy",
      };
    }
    try {
      rmSync(this.pathFor(id, name));
    } catch {
      return { refused: `no capture called "${name}" on ${id}`, because: "not-found" };
    }
    return { ok: { name } };
  }

  /** The capture this name means, or the refusal that answers for it. */
  private async find(id: string, name: string): Promise<Answer<Capture>> {
    const all = await this.captures(id);
    if (isRefusal(all)) return all;
    const found = all.ok.find((c) => c.name === name);
    if (found === undefined) {
      return { refused: `no capture called "${name}" on ${id}`, because: "not-found" };
    }
    if (found.held === "camera") {
      return {
        refused: `${id} holds "${name}" on its own medium; Yonder never saw the file `
          + "and cannot serve it",
        because: "on-camera",
      };
    }
    return { ok: found };
  }

  // -- the reserve (R-STO-06) --------------------------------------------

  /**
   * Watch an open recording against the reserve.
   *
   * On this daemon's own clock, like everything else that ticks here. The
   * check runs **before** the next interval is allowed to pass, so a
   * recording ends on the first reading at or below the floor rather than one
   * interval after it — which is the difference between stopping before the
   * card is full and noticing afterwards.
   */
  private arm(id: string, open: Open): void {
    open.timer = this.clock.setTimer(this.watchMs, () => { void this.tick(id); });
  }

  private async tick(id: string): Promise<void> {
    const open = this.open.get(id);
    if (open === undefined) return;
    if (!this.alive(id)) {
      this.close(id, "the camera's pipeline stopped, and the recording ended with it");
      return;
    }
    const free = await this.free();
    const reserve = this.reserveBytes();
    if (free - reserve <= 0) {
      await this.stopAtReserve(id, reserve);
      return;
    }
    // Only once it is known there is room: rearming first would let one more
    // interval of video be written against a card already at the floor.
    const still = this.open.get(id);
    if (still !== undefined) this.arm(id, still);
  }

  private async stopAtReserve(id: string, reserve: number): Promise<void> {
    // An operator's own press is in flight. Come back rather than interleave
    // with it: whatever they asked for either stops the recording anyway or
    // leaves it running for this watch to end on its next look.
    const open = this.open.get(id);
    if (!this.hold(id)) {
      if (open !== undefined) this.arm(id, open);
      return;
    }
    try {
      await this.ask(id, { op: "record-stop" }, this.recordMs);
      const reason = `the recording ended by itself: ${mb(reserve)} MB is reserved on `
        + "this device and the card reached it";
      this.close(id, reason);
      warn(`${id}: ${reason}`);
    } finally {
      this.release(id);
    }
  }

  /** Forget an open recording, with the reason it ended if it was not an
   *  operator who ended it. */
  private close(id: string, reason: string | null): void {
    const open = this.open.get(id);
    if (open !== undefined) this.clock.clearTimer(open.timer);
    this.open.delete(id);
    if (reason === null) this.ended.delete(id);
    else this.ended.set(id, { at: this.clock.now(), reason });
  }

  /**
   * How long the medium has left at the rate the encode is actually running.
   *
   * **An estimate, and it says so.** A variable-bitrate encode writes more
   * than its nominal rate through motion and less through a still scene, so
   * this is the rate the encoder is holding rather than a measurement of the
   * file. It is honest in the direction that matters: the reserve is what
   * actually ends a recording, and this number is what an operator plans
   * with.
   */
  private remaining(free: number, kbps: number | null): number | null {
    if (kbps === null) return null;
    const perSecond = (kbps * 1000) / 8;
    return Math.max(0, Math.floor((free - this.reserveBytes()) / perSecond));
  }

  /**
   * The rate a recording is being written at, in kb/s.
   *
   * The **running** encode first and the applied configuration only as its
   * seed, for K-48's reason: a camera whose rate has been retuned by the
   * adaptive controller is writing at the rate the encoder holds, and a
   * remaining time worked out from the document would be wrong exactly when
   * adaptation is working. A recording is taken off `main`, so it is the
   * stream encode and never the preview.
   */
  private rateKbps(camera: Camera): number | null {
    const running = this.inForce(camera.id);
    // A pipeline that is running answers for itself — **including when its
    // answer is that there is no encoder on this feed**. A fixed-passthrough
    // main stream is written at whatever the source is producing, which no
    // configured number describes, so the honest remaining time there is none
    // at all rather than one worked out from a rate nothing is running.
    const kbps = running === null ? camera.bitrate_kbps : running.stream;
    return kbps !== null && kbps > 0 ? kbps : null;
  }

  /**
   * How many more stills fit before the reserve.
   *
   * **An estimate, and it says so.** A JPEG's size is a property of the
   * picture, not of the sensor: a blank wall and a treeline at the same
   * resolution differ several times over, and nothing can be known about the
   * next one. The alternative to an estimate is no number at all, and R-CAM-17
   * asks the interface to show the remaining time on the medium doing the
   * work — a figure an operator plans with, in the unit they are working in.
   *
   * The factor is measured off this project's own captures rather than
   * assumed: `jpegenc`'s default quality on a 1280×720 frame of a real scene
   * writes about 100–140 kB, which is 0.11 to 0.15 bytes per pixel. The
   * higher of the two, so the count is the conservative one: a number that
   * turns out to have been pessimistic costs an operator nothing, and an
   * optimistic one costs them the shot they thought they had room for.
   */
  private remainingStills(free: number, camera: Camera): number | null {
    const perStill = camera.width * camera.height * STILL_BYTES_PER_PIXEL;
    if (!(perStill > 0)) return null;
    return Math.max(0, Math.floor((free - this.reserveBytes()) / perStill));
  }

  private reserveBytes(): number {
    return this.reserveMb() * 1024 * 1024;
  }

  private async free(): Promise<number> {
    try {
      return await this.freeBytes(this.root);
    } catch {
      // A medium that cannot be measured is treated as having nothing spare.
      // The safe direction: a recording refused on a board whose card cannot
      // be read costs a capture, and the other way costs the card.
      return 0;
    }
  }

  // -- talking to the pipeline host --------------------------------------

  /**
   * One command down to the pipeline, and the reply, or null.
   *
   * **The ids are strings, and that is not decoration.** `EncoderChannel`
   * speaks to the same processes over the same supervisor and keeps its own
   * table of outstanding numeric ids; two tables handing out `1` would let a
   * reply to a retune settle a still, on the same camera, the first time an
   * operator pressed the shutter while the rate controller was working.
   * `encoder.ts`'s own `parseReply` refuses an id that is not a finite
   * number, so a `rec-…` id can never be claimed there — and this one refuses
   * anything that is not a string, so a number can never be claimed here.
   */
  private ask(camera: string, body: object, budget: number): Promise<Reply | null> {
    return new Promise<Reply | null>((resolve) => {
      const id = `rec-${this.next++}`;
      // Registered before it is sent: a process that answers the moment it is
      // written to would otherwise answer into an empty table.
      const timer = this.clock.setTimer(budget, () => {
        this.waiting.delete(id);
        resolve(null);
      });
      this.waiting.set(id, {
        camera,
        settle: (reply) => {
          this.clock.clearTimer(timer);
          this.waiting.delete(id);
          resolve(reply);
        },
      });
      if (!this.channel.send(camera, { id, camera, ...body })) {
        this.waiting.get(id)?.settle(null);
      }
    });
  }

  /**
   * The pipeline's own claim that the main branch came through this, written
   * to the journal when it says otherwise.
   *
   * Not a refusal, and not a field on the answer: the capture was written
   * either way, and an operator who asked for a photograph should get one.
   * What must not happen is the break going unrecorded — a still that
   * interrupted the ground station's stream is the one measured property this
   * whole mechanism rests on, and the day it stops holding is the day it has
   * to be findable in the journal rather than inferred from a complaint.
   */
  private witness(id: string, reply: Reply | null, what: string): void {
    if (reply !== null && !reply.continuous) {
      warn(`${id}: the main stream broke while ${what}; the capture was still written`);
    }
  }

  /** One line from a pipeline. Anything that is not a reply to a request
   *  still outstanding **for that camera** is dropped without effect. */
  private heard(camera: string, line: string): void {
    const reply = parseReply(line);
    if (reply === null) return;
    const waiting = this.waiting.get(reply.id);
    if (waiting === undefined || waiting.camera !== camera) return;
    waiting.settle(reply);
  }

  // -- small things -------------------------------------------------------

  /** One operation at a time, per camera. */
  private hold(id: string): boolean {
    if (this.busy.has(id)) return false;
    this.busy.add(id);
    return true;
  }

  private release(id: string): void {
    this.busy.delete(id);
  }

  /** Is there a pipeline on this camera to command? */
  private alive(id: string): boolean {
    const state = this.channel.state(id).state;
    return state === "running" || state === "starting";
  }

  private dirFor(id: string): string {
    return join(this.root, id);
  }

  private pathFor(id: string, name: string): string {
    const dir = this.dirFor(id);
    mkdirSync(dir, { recursive: true, mode: CAPTURE_DIR_MODE });
    return join(dir, name);
  }

  private listDir(id: string): readonly string[] {
    try {
      return readdirSync(this.dirFor(id));
    } catch {
      // A camera that has never had a capture taken has no directory, which
      // is an empty list rather than a failure.
      return [];
    }
  }
}

function notFound(id: string): Refusal {
  return { refused: `no camera is configured with the id "${id}"`, because: "not-found" };
}

function busy(id: string): Refusal {
  return {
    refused: `${id} is busy with another capture; one at a time`,
    because: "busy",
  };
}

/** The refusal in a reply, or in its absence, or null where it carried
 *  neither. `what` names the op so the sentence reads as one. */
function refusalIn(reply: Reply | null, id: string, what: string): Refusal | null {
  if (reply === null) {
    return {
      refused: `${id}'s pipeline did not answer the ${what}; nothing was written`,
      because: "unanswered",
    };
  }
  const observed = reply.observed;
  if (typeof observed === "object" && observed !== null && "refused" in observed) {
    const said = (observed as { refused: unknown }).refused;
    return {
      refused: typeof said === "string" ? said : `${id} refused the ${what}`,
      // The pipeline's own refusals are all *this cannot be done now* — no
      // fresh frame, already recording, no tee to hang on — which is the same
      // answer to a caller as a camera that is not running.
      because: "not-running",
    };
  }
  return null;
}

export function parseReply(line: string): Reply | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { id, continuous, observed } = raw as Record<string, unknown>;
  if (typeof id !== "string") return null;
  if (typeof continuous !== "boolean") return null;
  return { id, continuous, observed };
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  return at < 0 ? "" : name.slice(at + 1);
}

/** Bytes as an operator reads them. */
function mb(bytes: number): string {
  return String(Math.round(bytes / (1024 * 1024)));
}
