// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { systemClock, type Clock } from "../apply/types.js";
import { warn } from "../log.js";
import type { Camera } from "../schema/config.js";
import { parseReply, type Answer, type PipelineChannel, type Reply } from "./recorder.js";
import { STILLS_INTERVAL_MS, type StillHeld } from "./viewers.js";

/**
 * Periodic stills, generated once per camera for whoever is watching them
 * (R-VID-14, R-VID-11, R-STO-01; spec §8.6).
 *
 * **This file exists because nothing produced a still.** `Viewers` accounted
 * for a stills subscriber completely — its interval, its frame age, its cost
 * per copy — and `YonderPicture` fell back to stills after twelve seconds of
 * no video, and between the two there was no frame: a viewer could ask for
 * stills, be counted, be billed, and see nothing. The same shape as three
 * defects this branch had already met, a value that travels partway and
 * stops. This is the chain.
 *
 * ## What it is
 *
 * **The host's `still` op, on a timer.** `installer/payload/yonder-pipeline`
 * takes one frame off the running `raw` tee to a path without disturbing the
 * ground station's stream — spiked and measured on a Pi 4, and the recipe in
 * `docs/hardware/stills-and-recording-on-a-live-pipeline.md` is what it
 * follows. Nothing here takes a frame any other way, and nothing here knows
 * what GStreamer is. `video/recorder.ts`'s `photo()` drives the same op; the
 * difference is what a *photo* is. A photo is a capture: it lands under
 * `/var/lib/yonder/captures/`, on the card, named and listed. A periodic
 * still is not a capture. It is never listed, it is overwritten every
 * interval, and it must not touch the card.
 *
 * ## Three decisions, each with its reason
 *
 * - **Stills live in RAM** (R-STO-01). `/run/yonder/stills/<camera-id>.jpg`
 *   is on the tmpfs systemd gives this daemon as its `RuntimeDirectory`,
 *   overwritten each interval, and only the latest still per camera is kept.
 *   A frame a browser will look at for five seconds is exactly the volatile
 *   runtime state that requirement keeps off the storage medium — a card
 *   written to every five seconds for every camera, for the life of every
 *   flight, is how a card wears out.
 * - **One still per camera per interval, whoever is watching.** The generator
 *   asks `Viewers` which cameras have at least one stills subscriber and takes
 *   one frame for each. Three browsers on stills of one camera is one frame
 *   taken and three transmissions counted — the counting is `Viewers`', at
 *   the route that serves each copy. Nobody on stills for a camera means no
 *   frame is taken for it: a still nobody asked for is a still off the
 *   pipeline for nothing.
 * - **A stopped camera has no still.** The host cannot take a frame from a
 *   pipeline that is not running, and a frame taken before the camera stopped
 *   is not a picture of what the camera sees now. It is dropped, and a viewer
 *   asking is told so in words rather than handed a stale frame.
 *
 * ## What it will not do
 *
 * - **Decide when.** The timer is the interval a stills viewer was promised;
 *   the cameras are the ones somebody is watching. Nothing here reacts to a
 *   link, a flight state or a battery (R-CMD-04, R-CMD-05).
 * - **Report an old frame as a new one.** A tick that gets no fresh frame
 *   keeps the last one, with its age growing on the page, and never re-dates
 *   it. A daemon that restarts starts with none: the files an earlier daemon
 *   left are cleared, because nothing remembers when they were taken.
 * - **Serve a half-written file.** The host writes to `<id>.next.jpg`; only
 *   once the host has answered — after the second buffer proved the frame is
 *   complete and the branch is gone — is it renamed over `<id>.jpg`. A rename
 *   on one filesystem is atomic, so a read never sees a frame in progress.
 */

/** `/run/yonder/stills` — on the tmpfs this daemon's unit provides as its
 *  `RuntimeDirectory`, never `/var/lib/yonder` (the card). R-STO-01. */
export const STILLS_ROOT = "/run/yonder/stills";

/** 0750, matching what systemd gives `/run/yonder` itself. */
const STILLS_DIR_MODE = 0o750;

/**
 * How long the pipeline host has to answer a still — the same six seconds
 * `video/recorder.ts` gives a photo, for the same reason: the host itself
 * waits up to two seconds for a fresh frame before refusing, and a refusal
 * that arrives is a sentence for the journal, where a silence is not.
 */
const STILL_MS = 6_000;

/** The latest still this device holds for one camera. */
export interface LatestStill extends StillHeld {
  readonly width: number | null;
  readonly height: number | null;
}

/** A still's bytes, on their way to whoever asked. */
export interface StillBody extends LatestStill {
  readonly bytes: number;
  readonly body: Buffer;
  readonly contentType: "image/jpeg";
  /** Milliseconds since it was taken, by the clock that stamped it (R-VID-14). */
  readonly age: number;
}

export interface StillsOptions {
  /** The one supervisor this process owns. See `PipelineChannel`. */
  readonly channel: PipelineChannel;
  /** The **applied** cameras, asked again every tick. Never a draft. */
  readonly cameras: () => readonly Camera[];
  /**
   * Which cameras have at least one stills subscriber right now —
   * `Viewers.wantingStills()`. Asked on every tick, so a browser that has
   * gone stops costing the pipeline a frame the moment `Viewers` lets go of
   * it, and one that has just arrived is taken a frame for on the next tick.
   */
  readonly wanted: () => readonly string[];
  /** Identity of the running process. A new spawn invalidates its predecessor's frame. */
  readonly generation?: (camera: string) => number;
  /** Where the stills live. `STILLS_ROOT` in production, a temporary
   *  directory in a test. */
  readonly root?: string;
  readonly clock?: Clock;
  /** How often a still is taken. `STILLS_INTERVAL_MS` — the figure `Viewers`
   *  promises every stills subscriber, so the two cannot disagree. */
  readonly intervalMs?: number;
  readonly stillMs?: number;
}

export class Stills {
  private readonly channel: PipelineChannel;
  private readonly cameras: () => readonly Camera[];
  private readonly wanted: () => readonly string[];
  private readonly generation: (camera: string) => number;
  private readonly root: string;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly stillMs: number;

  /** camera → the still this device holds for it. */
  private readonly held = new Map<string, LatestStill & { readonly generation: number }>();
  /** Cameras a still is in flight for. One at a time, per camera: a tick that
   *  lands while the host is still answering the last one skips that camera
   *  rather than queueing a second branch behind the first. */
  private readonly inFlight = new Set<string>();
  /** Cameras whose last attempt failed, so the journal carries one line per
   *  failure and not one per interval for as long as it lasts. */
  private readonly failing = new Set<string>();
  private readonly waiting = new Map<string, { camera: string; settle(r: Reply | null): void }>();
  private next = 1;
  private timer: unknown;
  private stopped = false;
  private prepared = false;

  constructor(opts: StillsOptions) {
    this.channel = opts.channel;
    this.cameras = opts.cameras;
    this.wanted = opts.wanted;
    this.generation = opts.generation ?? (() => 0);
    this.root = opts.root ?? STILLS_ROOT;
    this.clock = opts.clock ?? systemClock;
    this.intervalMs = opts.intervalMs ?? STILLS_INTERVAL_MS;
    this.stillMs = opts.stillMs ?? STILL_MS;
    this.channel.onMessage((camera, line) => { this.heard(camera, line); });
  }

  /** How often a still is taken, in ms — what a stills viewer is told. */
  get interval(): number {
    return this.intervalMs;
  }

  /**
   * The latest still this device holds for a camera, or null.
   *
   * Null for a camera that is not running, even if a file is still on the
   * tmpfs: a frame from before the pipeline stopped is not a picture of what
   * the camera sees, and the next tick removes it. `Viewers` reads this for
   * the frame age it reports (R-VID-14), and `present.ts` for the strip.
   */
  latest(camera: string): LatestStill | null {
    if (!this.eligible(camera)) {
      this.forget(camera);
      return null;
    }
    const held = this.held.get(camera);
    if (held === undefined) return null;
    if (held.generation !== this.generation(camera)) {
      this.forget(camera);
      return null;
    }
    return publicStill(held);
  }

  /**
   * The bytes of a camera's latest still, or the refusal in words.
   *
   * A stopped camera and a camera with no still yet are two different
   * sentences, because an operator does something different about each: one
   * is a camera to start, the other is a wait of at most one interval.
   */
  read(camera: string): Answer<StillBody> {
    if (!this.cameras().some((c) => c.id === camera)) {
      return { refused: `no camera is configured with the id "${camera}"`, because: "not-found" };
    }
    if (!this.eligible(camera)) {
      return {
        refused: `${camera} is not running: there is no pipeline to take a frame from`,
        because: "not-running",
      };
    }
    const held = this.held.get(camera);
    if (held === undefined) {
      return {
        refused: `no still of ${camera} yet; the first is taken within `
          + `${String(this.intervalMs / 1000)} s of a viewer asking for stills`,
        because: "not-found",
      };
    }
    if (held.generation !== this.generation(camera)) {
      this.forget(camera);
      return {
        refused: `no still of ${camera} yet; the first is taken within `
          + `${String(this.intervalMs / 1000)} s of a viewer asking for stills`,
        because: "not-found",
      };
    }
    try {
      const body = readFileSync(this.pathFor(camera));
      return {
        ok: {
          ...publicStill(held), bytes: body.length, body, contentType: "image/jpeg",
          age: Math.max(0, this.clock.now() - held.at),
        },
      };
    } catch {
      // Cleared from under this daemon — a `/run` that was emptied by hand.
      // Forgotten rather than reported, so the next tick takes a fresh one.
      this.held.delete(camera);
      return {
        refused: `the still of ${camera} is gone from this device's memory; the next is `
          + `taken within ${String(this.intervalMs / 1000)} s`,
        because: "not-found",
      };
    }
  }

  /**
   * One frame for every camera somebody is watching on stills, once each.
   *
   * Public, and returning when every take this tick started has been
   * answered or has timed out, so a test drives it rather than waiting on a
   * clock — the same shape `Adaptation.tick()` has for the same reason.
   */
  async tick(): Promise<void> {
    const configured = this.cameras();
    const wanted = new Set(this.wanted());
    const takes: Promise<void>[] = [];
    for (const camera of configured) {
      const id = camera.id;
      // **A stopped camera has no still.** Dropped here rather than left to
      // age on the tmpfs: a stills viewer of a stopped camera is told so in
      // words, and the strip draws it as stopped, never as a stale frame.
      if (!camera.enabled || !this.alive(id)) {
        this.forget(id);
        continue;
      }
      const held = this.held.get(id);
      if (held !== undefined && held.generation !== this.generation(id)) this.forget(id);
      // **Nobody watching means no frame.** A still nobody asked for is a
      // still off the pipeline for nothing.
      if (!wanted.has(id)) continue;
      if (this.inFlight.has(id)) continue;
      takes.push(this.take(id));
    }
    // A camera an apply removed takes its still with it, exactly as
    // `Adaptation` lets go of a removed camera's controller.
    for (const id of [...this.held.keys()]) {
      if (!configured.some((c) => c.id === id)) this.forget(id);
    }
    await Promise.all(takes);
  }

  /** Start taking stills, on this daemon's own clock. */
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    this.arm();
  }

  /**
   * Stop, for good — `stopped` as well as the timer, for the reason every
   * other timer this daemon owns has one: a tick already queued must not
   * re-arm itself on behalf of a process that has let go of its socket.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.timer = this.clock.setTimer(this.intervalMs, () => {
      this.timer = undefined;
      if (this.stopped) return;
      // Re-armed *before* the tick rather than after it, so the cadence is
      // the interval a viewer was promised rather than the interval plus
      // however long the host took to answer; `inFlight` is what keeps a
      // slow answer from being asked twice.
      this.arm();
      // A throw here would take the daemon down, and the daemon is the
      // device. `take` reports every failure it expects; this is for the
      // one it does not.
      void this.tick().catch((e: unknown) => {
        warn(`stills: a tick failed: ${(e as Error).message}`);
      });
    });
  }

  /**
   * One still of one camera: asked of the host, then renamed into place.
   *
   * `at` is stamped when the complete JPEG is atomically made available.
   * Before that rename there is no frame this daemon can truthfully serve;
   * dating it from the request would make host latency look like image age.
   */
  private async take(id: string): Promise<void> {
    this.inFlight.add(id);
    const generation = this.generation(id);
    const next = this.pathFor(id, "next");
    try {
      if (!this.prepareRoot()) {
        this.complain(id, `${this.root} could not be prepared to hold a still`);
        return;
      }
      const reply = await this.ask(id, { op: "still", path: next, thumbnail: true }, this.stillMs);
      if (reply === null) {
        this.complain(id, "the pipeline did not answer; the last still is kept");
        removeQuietly(next);
        return;
      }
      const observed = (typeof reply.observed === "object" && reply.observed !== null
        ? reply.observed
        : {}) as Record<string, unknown>;
      if ("refused" in observed) {
        const said = observed.refused;
        this.complain(id, typeof said === "string" ? said : "the pipeline refused the still");
        removeQuietly(next);
        return;
      }
      // The pipeline's own claim that the main branch came through this,
      // written to the journal when it says otherwise — as `Recorder.witness`
      // does, and for the same reason: the day the measured property stops
      // holding is the day it has to be findable in the journal.
      if (!reply.continuous) {
        warn(`${id}: the main stream broke while taking a still for the stills strip`);
      }
      const bytes = sizeOf(next);
      if (bytes === null || bytes === 0) {
        this.complain(id, "the pipeline answered but wrote nothing; the last still is kept");
        removeQuietly(next);
        return;
      }
      if (!this.eligible(id) || generation !== this.generation(id)) {
        removeQuietly(next);
        return;
      }
      renameSync(next, this.pathFor(id));
      this.held.set(id, {
        at: this.clock.now(), bytes, generation,
        width: typeof observed.width === "number" ? observed.width : null,
        height: typeof observed.height === "number" ? observed.height : null,
      });
      this.failing.delete(id);
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** One line per failure, not one per interval for as long as it lasts. */
  private complain(id: string, why: string): void {
    if (this.failing.has(id)) return;
    this.failing.add(id);
    warn(`${id}: no still this interval — ${why}`);
  }

  private forget(id: string): void {
    this.held.delete(id);
    this.failing.delete(id);
    removeQuietly(this.pathFor(id));
    removeQuietly(this.pathFor(id, "next"));
  }

  /**
   * The directory, made, and emptied of whatever an earlier daemon left —
   * once, before the first still is taken.
   *
   * A file from before this process started has no `at` this process knows,
   * and a still whose age nothing can state is a still that must not be
   * served — so it is removed rather than offered. Nothing is served before
   * the first take either way (`held` is empty until one lands), which is
   * what lets this wait for a taker: a daemon nobody asks for stills never
   * touches the directory at all.
   */
  private prepareRoot(): boolean {
    if (this.prepared) return true;
    try {
      mkdirSync(this.root, { recursive: true, mode: STILLS_DIR_MODE });
      for (const name of readdirSync(this.root)) {
        if (name.endsWith(".jpg")) removeQuietly(join(this.root, name));
      }
      this.prepared = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One command down to the pipeline, and the reply, or null.
   *
   * **A third id namespace, and the string prefix is what keeps it apart.**
   * `EncoderChannel` hands out numbers and refuses a reply whose id is not
   * one; `Recorder` hands out `rec-…`; this hands out `still-…`. Each keeps
   * its own table of what it is waiting for, so a reply to one can never
   * settle a request from another on the same camera — which is exactly the
   * mistake `recorder.ts` names for numeric ids, met here a third time.
   */
  private ask(camera: string, body: object, budget: number): Promise<Reply | null> {
    return new Promise<Reply | null>((resolve) => {
      const id = `still-${String(this.next++)}`;
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

  private heard(camera: string, line: string): void {
    const reply = parseReply(line);
    if (reply === null) return;
    const waiting = this.waiting.get(reply.id);
    if (waiting === undefined || waiting.camera !== camera) return;
    waiting.settle(reply);
  }

  /** Is there a pipeline on this camera to take a frame from? */
  private alive(id: string): boolean {
    const state = this.channel.state(id).state;
    return state === "running";
  }

  /** A configured, enabled source with a settled running pipeline. */
  private eligible(id: string): boolean {
    return this.cameras().some((camera) => camera.id === id && camera.enabled) && this.alive(id);
  }

  private pathFor(id: string, part?: "next"): string {
    return join(this.root, part === undefined ? `${id}.jpg` : `${id}.${part}.jpg`);
  }
}

function publicStill(held: LatestStill & { readonly generation: number }): LatestStill {
  return { at: held.at, bytes: held.bytes, width: held.width, height: held.height };
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Nothing to remove, or nothing that can be: either way there is no
    // still there to serve.
  }
}
