// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";
import { PREVIEW_RUNGS, type Camera, type PreviewRung } from "../schema/config.js";
import {
  encodeControl, encodesIn, previewCaps, scalesInEncoder,
  type ElementProperty, type EncodeName, type PreviewShape, type RunningEncodes,
} from "./pipeline.js";
import type { CameraRun, Supervisor } from "./supervisor.js";

/**
 * Telling an encoder that is already running to do something else (R-VID-07).
 *
 * **This is the fix for K-48.** An operator changed a camera's bitrate,
 * applied it, and confirmed it; `config.yaml` took the new value, the
 * confirmation said `confirmed`, and the encoder went on running the old one
 * — because `pipeline.ts` bakes the rate into the launch line and nothing
 * respawned the pipeline. An apply was silently a no-op for the picture,
 * which is worse than refusing the change. This file is the route a new rate
 * has that is not a respawn.
 *
 * **A respawn is not the fallback, because it does not have to be.** Task 1
 * measured the daemon's own pipeline on this board, three times:
 * `v4l2h264enc` took `extra-controls` while playing and moved from ~0.97 to
 * 3.01 Mb/s, with every timestamp gap falling *before* the retune call and
 * none in the ten seconds after it
 * (`docs/hardware/runtime-encoder-control.md`). So a bitrate change is a
 * property write on a running element, the main stream and any board
 * recording stay continuous through it, and only a preview *reconfigure* —
 * a size or a rate, which is a caps renegotiation rather than a control —
 * may cost the preview branch a restart. The main branch never restarts for
 * either.
 *
 * **It relays; it does not decide** (R-CMD-04, R-CMD-05). Nothing here
 * chooses a bitrate, clamps one to an envelope or reacts to a link. The
 * envelope is the operator's and the stepping is the rate controller's; a
 * second opinion held here would disagree with the first one silently.
 *
 * **Three things it will not do**, each of which is the same mistake:
 *
 * - *Answer from the configuration.* Everything this file reports comes from
 *   the launch line the process is running or from the process itself. K-48
 *   is what config-shaped answers look like: every file that asked the
 *   config agreed with the config, and the encoder was doing something else.
 * - *Invent a confirmation.* An answer that does not arrive, or arrives
 *   malformed, leaves the last confirmed state exactly where it was, and the
 *   `requested` field names what failed.
 * - *Vouch for continuity itself.* See `Ack.continuous`.
 */

/**
 * What the channel got for what it asked.
 *
 * `requested` and `observed` are **separate values, and are meant to be
 * compared** (spec §8.1): equal, the request landed; different, it did not,
 * and `observed` is the last state the encoder actually confirmed. There is
 * no third field saying "failed", because the pair already says it and a
 * flag beside them could disagree with them.
 *
 * `continuous` is a claim about the **main branch**: that the ground-station
 * stream, and any board recording taken off it, did not break while this
 * request was carried out. It is true only when all three witnesses agree,
 * and not one of them is this file's own opinion:
 *
 *  1. the process's own report that its main-branch timestamps ran without a
 *     gap after the request;
 *  2. that the process which answered is the process that answered last time
 *     — a new pid is a new pipeline, whatever it says about its timestamps;
 *  3. that the supervisor counted no restart across the request and the
 *     camera did not stop or fail.
 *
 * An unanswered request leaves witness 1 silent and 3 deciding: nothing was
 * done, so nothing broke, and it is `requested` against `observed` that
 * carries the failure rather than a continuity claim the pipeline never
 * earned.
 *
 * `notControllable` is the other answer entirely: there is no encoder on
 * this feed to command — the camera is not running, its pipeline takes no
 * instruction, or the feed carries the source's own encoding and never had
 * an encoder in the first place. It carries the reason as a sentence,
 * because an operator shown a bitrate control that quietly does nothing is
 * back in K-48.
 */
export type Ack<T> =
  | {
    readonly requested: T;
    readonly observed: T;
    readonly continuous: boolean;
    readonly at: number;
  }
  | { readonly notControllable: string };

/**
 * What goes down the wire, and what the far side may do about it.
 *
 * One line of JSON per command, one per reply, matched by `id`. The `op` is
 * not decoration — it is the latitude the process is being given, and it is
 * Task 1's measurement written down:
 *
 * - `retune` — set these properties on the running pipeline. **Nothing may be
 *   restarted**: the encoder takes a bitrate while playing, so a process that
 *   answered this by rebuilding anything would be answering a question it was
 *   not asked.
 * - `reconfigure-preview` — set these, and where the elements will not take
 *   them while playing, **the preview branch alone** may be restarted to make
 *   them take. The main branch, its outputs and any board recording stay up.
 *
 * `sets` is the whole instruction. The caps in a preview reconfigure carry
 * the size and the rate, so the process needs nothing else to know what it is
 * being asked for, and there is no second copy of the request to disagree
 * with the first.
 */
interface Command {
  readonly id: number;
  readonly camera: string;
  readonly op: "retune" | "reconfigure-preview";
  readonly sets: readonly ElementProperty[];
}

/** One line back. `observed` is a rate in kb/s for a retune and a `{ size,
 *  fps }` for a reconfigure; anything else is not an answer (see `reply`). */
interface Reply {
  readonly id: number;
  readonly pid: number;
  readonly continuous: boolean;
  readonly observed: unknown;
}

type Answer =
  | { readonly kind: "reply"; readonly reply: Reply }
  | { readonly kind: "silence" }
  | { readonly kind: "no channel" };

/**
 * How long a command has to be answered in.
 *
 * A retune is a property write on a playing element and answers immediately;
 * a reconfigure may have to take the preview branch down and bring it back,
 * which is a state change on real elements holding a real V4L2 device. Two
 * numbers rather than one, so the generous budget the second needs is not
 * also the delay an operator waits through when the first goes unanswered.
 */
const RETUNE_MS = 2_000;
const RECONFIGURE_MS = 5_000;

/**
 * The last state this camera's encoder actually confirmed. Seeded from the
 * launch line it is running under, and moved only by the process.
 *
 * `since` is the supervisor's own timestamp for the run this was seeded
 * from, and it is what makes the seed expire: a pipeline that stopped and
 * started again — a crash and its retry, or an operator pressing Stop then
 * Start — is running its launch line from the top, and what the process
 * before it confirmed is not what this one is doing. The restart counter
 * alone will not do, because `Supervisor.start()` resets it to zero.
 */
interface Confirmed {
  pid: number | null;
  since: number;
  stream: number | null;
  preview: number | null;
  shape: PreviewShape | null;
}

export class EncoderChannel {
  private readonly supervisor: Supervisor;
  private readonly clock: Clock;
  private readonly retuneMs: number;
  private readonly reconfigureMs: number;
  private readonly confirmed = new Map<string, Confirmed>();
  private readonly waiting = new Map<number, { camera: string; settle(a: Answer): void }>();
  private next = 1;

  constructor(opts: {
    supervisor: Supervisor; clock?: Clock; retuneMs?: number; reconfigureMs?: number;
  }) {
    this.supervisor = opts.supervisor;
    this.clock = opts.clock ?? systemClock;
    this.retuneMs = opts.retuneMs ?? RETUNE_MS;
    this.reconfigureMs = opts.reconfigureMs ?? RECONFIGURE_MS;
    this.supervisor.onMessage((camera, line) => { this.heard(camera, line); });
  }

  /**
   * Move one encode of a running camera to `kbps`, without respawning
   * anything (R-VID-07, R-CTL-03).
   */
  async retune(camera: Camera, encode: EncodeName, kbps: number): Promise<Ack<number>> {
    const argv = this.supervisor.argv(camera.id);
    if (argv === null) return notRunning(camera.id);

    const set = encodeControl(argv, encode, kbps);
    const held = this.hold(camera.id, argv);
    const last = held[encode];
    if (set === null || last === null) {
      // The pipeline that is running carries no encoder on this feed — a
      // fixed-passthrough main stream is exactly this shape, and so is any
      // other feed that leaves the source's own encoding alone.
      return {
        notControllable: `${camera.id}'s ${encode} carries the source's own `
          + "encoding: there is no encoder on it to retune",
      };
    }

    const before = this.supervisor.state(camera.id);
    const answer = await this.ask(camera.id, "retune", [set], this.retuneMs);
    if (answer.kind === "no channel") return noChannel(camera.id);

    const reply = answer.kind === "reply" ? answer.reply : null;
    const continuous = this.settle(camera.id, argv, before, reply);
    const observed = reply === null ? null : kbpsIn(reply.observed);
    if (observed !== null) held[encode] = observed;
    return {
      requested: kbps,
      // The rate the process just confirmed, or — where it confirmed
      // nothing readable — the one it last confirmed, which `settle` has
      // already re-read from the launch line if the pipeline changed under
      // us. Never the rate that was asked for.
      observed: observed ?? held[encode] ?? last,
      continuous,
      at: this.clock.now(),
    };
  }

  /**
   * Hold the preview at a size and a rate (R-VID-13, spec §8.1).
   *
   * The one command that may cost a restart, and only ever the preview
   * branch's: the operator's stream, its outputs and a board recording are
   * downstream of a different encode and do not move for this.
   */
  async reconfigurePreview(camera: Camera, shape: PreviewShape): Promise<Ack<PreviewShape>> {
    const argv = this.supervisor.argv(camera.id);
    if (argv === null) return notRunning(camera.id);

    // On MPP the preview's size is RGA's, set on the encoder at start only;
    // set while playing it is accepted and ignored (measured). Refusing it
    // here is what stops an Ack reporting a shape the picture never took.
    // The rate controller holds the rung on this refusal (rate.ts) and the
    // renderer applies a new size by restarting the camera.
    if (scalesInEncoder(argv)) {
      return {
        notControllable: `${camera.id}'s preview is scaled inside its encoder, which takes a size only when the pipeline starts; a new size is applied by restarting the camera`,
      };
    }

    const held = this.hold(camera.id, argv);
    const last = held.shape;
    if (last === null) {
      return { notControllable: `${camera.id} has no preview branch to reconfigure` };
    }

    const before = this.supervisor.state(camera.id);
    const answer = await this.ask(
      camera.id, "reconfigure-preview", previewCaps(shape), this.reconfigureMs,
    );
    if (answer.kind === "no channel") return noChannel(camera.id);

    const reply = answer.kind === "reply" ? answer.reply : null;
    const continuous = this.settle(camera.id, argv, before, reply);
    const observed = reply === null ? null : shapeIn(reply.observed);
    if (observed !== null) held.shape = observed;
    return {
      requested: shape,
      observed: observed ?? held.shape ?? last,
      continuous,
      at: this.clock.now(),
    };
  }

  /**
   * What this camera's encoder is running now — the launch line the process
   * is under, moved by every acknowledgement since (R-VID-07, R-VID-11).
   *
   * **The read a rate controller does before it decides anything**
   * (`video/rate.ts`). It is deliberately not a number the caller keeps: a
   * controller holding its own copy of the encoder's rate would compare its
   * next target against its own bookkeeping, and the moment the pipeline
   * restarted — at the rate its launch line carries, not the rate that was
   * last commanded — the two would part company silently. That is K-48's
   * shape exactly, one level up.
   *
   * `null` when nothing is running on this camera: there is no encoder to
   * have a rate.
   */
  inForce(camera: string): RunningEncodes | null {
    const argv = this.supervisor.argv(camera);
    if (argv === null) return null;
    const held = this.hold(camera, argv);
    return { stream: held.stream, preview: held.preview, shape: held.shape };
  }

  /** What this camera's encoder last confirmed, seeded from the launch line
   *  the process is running under — the first time it is asked for, and again
   *  whenever the pipeline it was seeded from has been replaced (`since`). */
  private hold(camera: string, argv: readonly string[]): Confirmed {
    const since = this.supervisor.state(camera).since;
    const held = this.confirmed.get(camera);
    if (held === undefined) {
      const seed = { pid: null, since, ...encodesIn(argv) };
      this.confirmed.set(camera, seed);
      return seed;
    }
    if (held.since !== since) {
      const fresh = encodesIn(argv);
      held.since = since;
      // A new process has no pid to be compared against the old one's, and
      // `settle` is told so rather than left to read a break into the change.
      held.pid = null;
      held.stream = fresh.stream;
      held.preview = fresh.preview;
      held.shape = fresh.shape;
    }
    return held;
  }

  private ask(
    camera: string, op: Command["op"], sets: readonly ElementProperty[], budget: number,
  ): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      const id = this.next++;
      // Registered before it is sent: a process that answers the moment it is
      // written to would otherwise answer into an empty table.
      const timer = this.clock.setTimer(budget, () => {
        this.waiting.delete(id);
        resolve({ kind: "silence" });
      });
      this.waiting.set(id, {
        camera,
        settle: (answer) => {
          this.clock.clearTimer(timer);
          this.waiting.delete(id);
          resolve(answer);
        },
      });
      const command: Command = { id, camera, op, sets };
      if (!this.supervisor.send(camera, command)) {
        this.waiting.get(id)?.settle({ kind: "no channel" });
      }
    });
  }

  /** One line from a pipeline. Anything that is not a reply to a request
   *  still outstanding **for that camera** is dropped without effect. */
  private heard(camera: string, line: string): void {
    const reply = parseReply(line);
    if (reply === null) return;
    const waiting = this.waiting.get(reply.id);
    if (waiting === undefined || waiting.camera !== camera) return;
    waiting.settle({ kind: "reply", reply });
  }

  /**
   * Whether the main branch came through this request, and what the camera's
   * confirmed state is now. The three witnesses of `Ack.continuous`, in the
   * order they are cheapest to be sure of.
   */
  private settle(
    camera: string, argv: readonly string[],
    before: CameraRun, reply: Reply | null,
  ): boolean {
    const after = this.supervisor.state(camera);
    const undisturbed = after.restarts === before.restarts
      && after.state !== "stopped" && after.state !== "failed";
    if (reply === null) return undisturbed;

    const held = this.hold(camera, argv);
    // The first answer has nothing to compare a pid against and does not
    // pretend otherwise; from the second on, a different pid is a different
    // pipeline and the process's own opinion of its timestamps is about a
    // pipeline that is not the one we were holding.
    const samePid = held.pid === null || held.pid === reply.pid;
    if (!samePid) {
      const fresh = encodesIn(argv);
      held.stream = fresh.stream;
      held.preview = fresh.preview;
      held.shape = fresh.shape;
    }
    held.pid = reply.pid;
    return undisturbed && samePid && reply.continuous;
  }
}

function notRunning(camera: string): { notControllable: string } {
  return {
    notControllable: `${camera} is not running: there is no pipeline on it to command`,
  };
}

function noChannel(camera: string): { notControllable: string } {
  return {
    notControllable: `${camera}'s pipeline has no control channel: it was started `
      + "by a program that takes no instruction once it is running",
  };
}

/**
 * One line back, or null where it is not one this channel issued.
 *
 * **The `id` must be a number, and that guard is load-bearing beyond this
 * file.** `video/recorder.ts` speaks to the same processes over the same
 * supervisor and keeps its own table of outstanding requests; if both handed
 * out `1`, a reply to a still could settle a retune on the same camera the
 * first time an operator pressed the shutter while the rate controller was
 * working. Its ids are strings — `rec-1` — so this refusal is what keeps the
 * two tables from claiming each other's replies, and the same statement is
 * written where those ids are minted.
 */
function parseReply(line: string): Reply | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { id, pid, continuous, observed } = raw as Record<string, unknown>;
  if (!Number.isFinite(id) || !Number.isFinite(pid)) return null;
  if (typeof continuous !== "boolean") return null;
  return { id: id as number, pid: pid as number, continuous, observed };
}

/** A rate the process says it is running, or null where it said something
 *  this file will not read as one. */
function kbpsIn(observed: unknown): number | null {
  return typeof observed === "number" && Number.isFinite(observed) && observed > 0
    ? observed
    : null;
}

function shapeIn(observed: unknown): PreviewShape | null {
  if (typeof observed !== "object" || observed === null) return null;
  const { size, fps } = observed as Record<string, unknown>;
  // A size this schema does not offer is not adopted as one it does, for the
  // reason `pipeline.ts` gives where it reads the same value out of a launch
  // line: inventing a fourth rung to hold it would be a repair, and R-CMD-04
  // refuses repairs everywhere else.
  if (typeof size !== "string" || !(PREVIEW_RUNGS as readonly string[]).includes(size)) return null;
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) return null;
  return { size: size as PreviewRung, fps };
}
