// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { systemClock, type Clock } from "../apply/types.js";

/**
 * Spawning and supervising one pipeline per camera (R-CTL-01).
 *
 * **Start and stop are process lifecycle; a keyframe on reconnect is arranged
 * in the pipeline rather than commanded.** M4 left it there and said so: a
 * control channel into a running pipeline was R-VID-07's cost to carry, not
 * that milestone's. R-VID-07 is now being built, so `send()` and `argv()`
 * below are that channel's half of this file — a line to the process and the
 * command line it is running under. Everything they mean is in
 * `video/encoder.ts`; this file carries them and knows nothing about
 * encoders, exactly as it knows nothing about pipelines.
 *
 * **Stopping is a runtime action, not a configuration write.** It survives no
 * apply and no reboot: a camera configured to autostart comes back streaming.
 * That is deliberate — Start and Stop are the only controls on the camera page
 * that stop the aircraft *sending*, and an operator watching the uplink track
 * go past its mark needs something that acts now rather than something that
 * takes a confirmation window to arm.
 */
export type RunState = "stopped" | "starting" | "running" | "failed";

/** `state()` and `all()` read this back rather than the config a camera was
 *  last given — the actual, observed run state, not a form default (R-CTL-10). */
export interface CameraRun {
  readonly id: string;
  readonly state: RunState;
  readonly since: number;
  readonly reason?: string;
  readonly restarts: number;
}

/** The part of a child process this file uses. Injected; see ProcessSpawner. */
export interface SpawnedProcess {
  kill(signal?: string): void;
  on(event: "exit" | "error", fn: (arg: unknown) => void): void;
  /**
   * One line to the process's control channel — how a bitrate reaches an
   * encoder that is already running (R-VID-07).
   *
   * **Optional, and that is the honest shape.** Not every program that can
   * carry a pipeline can be told anything once it is carrying it:
   * `gst-launch-1.0` reads its pipeline from its arguments and then listens
   * to nobody, so a spawner for it offers no `send` and the channel above it
   * answers `notControllable` rather than writing into a pipe nothing reads.
   * A process that *does* answer sets both this and `onMessage`.
   */
  send?(line: string): void;
  /** Lines the process sends back — its acknowledgements. See `send`. */
  onMessage?(fn: (line: string) => void): void;
}

/**
 * Injected for the reason `CommandRunner` is: no test spawns
 * `gst-launch-1.0`. A separate type because a pipeline does not exit and hand
 * back its output — it runs until something stops it.
 */
export type ProcessSpawner = (argv: string[]) => SpawnedProcess;

/**
 * The real one, and the only place in this package that starts a pipeline.
 *
 * **stdout discarded, stderr inherited.** `gst-launch-1.0 -q` says nothing on
 * stdout worth keeping and everything worth keeping on stderr: the encoder
 * fault `pipeline.ts` records — `Failed to process frame`, on the first frame,
 * after everything looked well — is printed there and nowhere else. Inheriting
 * sends it to the daemon's own stderr, which systemd hands to the journal: the
 * diagnostic half, exactly where `trace()` puts an nmcli command line, and
 * deliberately not the activity pane an operator reads.
 *
 * **Untested, and it has to be.** Nothing in this repository's suite spawns a
 * process — that is what `ProcessSpawner` exists for — so this function is the
 * seam's far side. It is four lines for exactly that reason.
 *
 * **It offers no `send`, because `gst-launch-1.0` has none to offer.** The
 * program reads its pipeline from argv, plays it, and takes no instruction
 * afterwards: there is no property to set, no socket, no stdin protocol.
 * `EncoderChannel` therefore reports every camera on this spawner as not
 * controllable and changes nothing, which is the true answer. Giving the
 * child a stdin pipe and writing commands into it would produce the same
 * silence with none of the report — K-48's failure exactly, one layer down.
 * The program that does answer is not in this repository yet; when it is,
 * it arrives here, as a spawner that sets `send` and `onMessage`.
 */
export const systemSpawner: ProcessSpawner = (argv) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "inherit"] });
  return {
    kill: (signal) => { child.kill(signal as NodeJS.Signals | undefined); },
    on: (event, fn) => { child.on(event, (arg: unknown) => { fn(arg); }); },
  };
};

/** How long a pipeline must hold before it counts as running (R-UI-05). */
const SETTLE_MS = 2_000;
/** Backoff between restarts, and how many before giving up. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_RESTARTS = 5;

interface Entry {
  run: CameraRun;
  argv: string[];
  proc: SpawnedProcess | null;
  settle: unknown;
  retry: unknown;
  /** Set while an operator's stop is in flight, so an exit is not a failure. */
  stopping: boolean;
}

export class Supervisor {
  private readonly spawner: ProcessSpawner;
  private readonly clock: Clock;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners: ((id: string, line: string) => void)[] = [];

  constructor(opts: { spawner?: ProcessSpawner; clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.spawner = opts.spawner ?? (() => { throw new Error("no spawner configured"); });
  }

  /**
   * The operator pressing Start.
   *
   * **A failed camera has a retry armed, and this is the state the page
   * invites a Start in.** Without the two lines below, Start spawned a process
   * while the backoff was still pending; the retry then fired, spawned a
   * second, and overwrote `entry.proc` — so the supervisor held a handle to
   * the second and none at all to the first. `stop()` killed one of the two,
   * and the orphan went on holding the camera's `/dev/video*` node open, so
   * every later start got `EBUSY` from `v4l2src` and mediamtx refused it as a
   * second publisher on the same path. From the console the camera was then
   * permanently unstartable: only a reboot or a manual `kill` cleared it.
   * Verified on hardware. The trigger is ordinary — any fail-fast cause,
   * followed by the operator's natural response.
   *
   * **One timer, and only one, because only one can be armed here.** `ended`
   * clears the settle timer and nulls `proc` before it arms a retry, `stop()`
   * clears both and kills, and an entry still holding a live process is
   * `starting` or `running` — which the guard on the first line returns on.
   * So a pending retry is the only thing this state can be carrying, and a
   * second `clearTimer` beside it would be a guard no test could ever turn
   * red. The test below pins the guard the reasoning rests on.
   */
  start(id: string, argv: string[]): void {
    const existing = this.entries.get(id);
    if (existing && (existing.run.state === "starting" || existing.run.state === "running")) return;
    const entry: Entry = existing ?? {
      run: { id, state: "stopped", since: this.clock.now(), restarts: 0 },
      argv, proc: null, settle: null, retry: null, stopping: false,
    };
    this.clock.clearTimer(entry.retry);
    entry.retry = null;
    entry.argv = argv;
    entry.stopping = false;
    entry.run = { ...entry.run, restarts: 0, reason: undefined };
    this.entries.set(id, entry);
    this.spawn(id, entry);
  }

  stop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      this.entries.set(id, {
        run: { id, state: "stopped", since: this.clock.now(), restarts: 0 },
        argv: [], proc: null, settle: null, retry: null, stopping: false,
      });
      return;
    }
    entry.stopping = true;
    this.clock.clearTimer(entry.settle);
    this.clock.clearTimer(entry.retry);
    entry.settle = null;
    entry.retry = null;
    entry.proc?.kill("SIGTERM");
    entry.proc = null;
    entry.run = { ...entry.run, state: "stopped", since: this.clock.now(), reason: undefined };
  }

  state(id: string): CameraRun {
    return this.entries.get(id)?.run
      ?? { id, state: "stopped", since: this.clock.now(), restarts: 0 };
  }

  all(): CameraRun[] {
    return [...this.entries.values()].map((e) => e.run);
  }

  /**
   * One line to this camera's running pipeline. False where there is nothing
   * to send it to (R-VID-07).
   *
   * **Both refusals are the same sentence to a caller** — *this camera cannot
   * be told anything right now* — and they are kept apart here anyway,
   * because they are different facts about the device: `proc` is null when no
   * pipeline is running, and `send` is absent when one is running under a
   * program that takes no instruction. A caller that cannot tell them apart
   * cannot explain either, so `EncoderChannel` asks `argv()` first and this
   * second, and names whichever answered.
   */
  send(id: string, msg: unknown): boolean {
    const proc = this.entries.get(id)?.proc;
    if (proc?.send === undefined) return false;
    proc.send(JSON.stringify(msg));
    return true;
  }

  /**
   * The command line this camera's pipeline is **running under**, or null
   * when none is.
   *
   * Deliberately not part of `CameraRun`: `state()` is served to the console
   * on every camera read, and a launch line is a diagnostic rather than
   * something every page needs to carry. The one caller is the runtime
   * channel, which reads the running encodes out of it rather than trusting a
   * configuration that may have been applied since (K-48).
   *
   * Null while stopped, and it must be: `entry.argv` outlives the process
   * that ran it — `stop()` keeps it so a later `start()` has something to
   * spawn — so returning it unconditionally would let a channel address an
   * encoder that exited minutes ago.
   */
  argv(id: string): readonly string[] | null {
    const entry = this.entries.get(id);
    return entry?.proc ? entry.argv : null;
  }

  /** Lines the running pipelines send back, tagged with the camera each came
   *  from. Registered once; survives every restart of every pipeline. */
  onMessage(fn: (id: string, line: string) => void): void {
    this.listeners.push(fn);
  }

  private spawn(id: string, entry: Entry): void {
    entry.run = { ...entry.run, state: "starting", since: this.clock.now() };
    const proc = this.spawner(entry.argv);
    entry.proc = proc;

    // The same stale-process guard `ended` carries, for the same reason: a
    // superseded pipeline can still be draining its output pipe, and its late
    // acknowledgement must not be read as the *new* process answering. That
    // one is a restart mistaken for a crash; this one would be a bitrate the
    // dead encoder confirmed, reported as the live encoder's own.
    proc.onMessage?.((line) => {
      if (entry.proc !== proc) return;
      for (const fn of this.listeners) fn(id, line);
    });

    // R-UI-05: a spawn call is the command being sent. A pipeline that exits
    // after 200 ms was never running, and a page that turned green on the
    // spawn would be reporting the command rather than its effect.
    entry.settle = this.clock.setTimer(SETTLE_MS, () => {
      if (entry.proc !== proc) return;
      entry.run = { ...entry.run, state: "running", since: this.clock.now(), reason: undefined };
    });

    // Guards against two different stale signals, not one wearing two hats:
    // `entry.proc !== proc` is for a process a restart has already
    // superseded (its late exit must not be mistaken for the *new* process
    // crashing); `entry.stopping` is for the process stop() itself just
    // killed (its exit is the expected effect of SIGTERM, not a crash to
    // recover from). Losing either turns a stopped camera, or a clean
    // restart, into one that resurrects itself.
    const ended = (why: string): void => {
      if (entry.proc !== proc) return;
      this.clock.clearTimer(entry.settle);
      entry.proc = null;
      if (entry.stopping) return;
      if (entry.run.restarts >= MAX_RESTARTS) {
        entry.run = {
          ...entry.run, state: "failed", since: this.clock.now(),
          reason: `${why}; gave up after ${MAX_RESTARTS} restarts`,
        };
        return;
      }
      const attempt = entry.run.restarts;
      entry.run = {
        ...entry.run, state: entry.run.state === "running" ? "starting" : "failed",
        since: this.clock.now(), reason: why, restarts: attempt + 1,
      };
      entry.retry = this.clock.setTimer(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], () => {
        this.spawn(id, entry);
      });
    };

    proc.on("exit", (code) => ended(`the pipeline exited with code ${String(code)}`));
    proc.on("error", (e) => ended(`the pipeline could not be started: ${String(e)}`));
  }
}
