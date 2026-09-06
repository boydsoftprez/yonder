// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
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
   * A process that *does* answer sets both this and `onMessage`, and
   * `installer/payload/yonder-pipeline` is that process.
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
 * The program that carries a pipeline **and can be told things while it is
 * carrying it** (R-VID-07; closes K-53).
 *
 * `installer/payload/yonder-pipeline`, installed here by
 * `installer/roles/55-pipeline-host.sh`. It takes the argv `compose()` emits,
 * plays it through GStreamer's own `parse_launchv`, and answers the NDJSON
 * protocol `video/encoder.ts` speaks. Absent, everything below falls back to
 * the program that has always run these pipelines.
 *
 * A constant rather than a setting, for the reason `YONDER_NODE_LINK` is one
 * in the installer: it is half of a pair with the role that installs it, and
 * a value the two halves can disagree about is a control channel that is
 * silently never there.
 */
export const PIPELINE_HOST = "/usr/local/bin/yonder-pipeline";

/** Whether this path is something this account can actually run. Executable,
 *  not merely present: a payload copied without its mode bit is a file that
 *  exists and cannot be spawned, and the difference decides which spawner a
 *  camera gets. */
function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn `command` with the pipeline's own arguments, over a control channel.
 *
 * **`argv.slice(1)` is deliberate and is the whole contract**: the host is
 * handed exactly what `gst-launch-1.0` would have been handed, so the two
 * programs run the same pipeline and this file composes nothing. A spike
 * whose pipeline differed from the daemon's cost this branch three fix rounds
 * and produced video that never started.
 *
 * stdout is the reply channel and is read as lines, because a pipe hands over
 * whatever it has: two replies can arrive in one chunk and one reply can
 * arrive in two, and a listener fed raw chunks would drop both.
 *
 * **stdin errors are swallowed on purpose.** Writing to a child that has just
 * died raises EPIPE on the stream, and an unhandled `error` on a stream takes
 * the *daemon* down — the whole device, for a camera. The command is lost
 * either way, and a lost command is already reported: `EncoderChannel` hears
 * no reply and says the request did not land.
 */
export function controlledSpawner(command: string, env?: NodeJS.ProcessEnv): ProcessSpawner {
  return (argv) => {
    const child = spawn(command, argv.slice(1), {
      stdio: ["pipe", "pipe", "inherit"],
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    const listeners: ((line: string) => void)[] = [];
    let held = "";
    child.stdin.on("error", () => { /* see above */ });
    child.stdout.setEncoding("utf8");
    child.stdout.on("error", () => { /* see above */ });
    child.stdout.on("data", (chunk: string) => {
      held += chunk;
      for (;;) {
        const at = held.indexOf("\n");
        if (at < 0) break;
        const line = held.slice(0, at);
        held = held.slice(at + 1);
        for (const fn of [...listeners]) fn(line);
      }
    });
    return {
      kill: (signal) => { child.kill(signal as NodeJS.Signals | undefined); },
      on: (event, fn) => { child.on(event, (arg: unknown) => { fn(arg); }); },
      send: (line) => { child.stdin.write(`${line}\n`); },
      onMessage: (fn) => { listeners.push(fn); },
    };
  };
}

/**
 * The pipeline runner this project has always had, unchanged.
 *
 * **stdout discarded, stderr inherited.** `gst-launch-1.0 -q` says nothing on
 * stdout worth keeping and everything worth keeping on stderr: the encoder
 * fault `pipeline.ts` records — `Failed to process frame`, on the first frame,
 * after everything looked well — is printed there and nowhere else. Inheriting
 * sends it to the daemon's own stderr, which systemd hands to the journal: the
 * diagnostic half, exactly where `trace()` puts an nmcli command line, and
 * deliberately not the activity pane an operator reads.
 *
 * **It offers no `send`, because `gst-launch-1.0` has none to offer.** The
 * program reads its pipeline from argv, plays it, and takes no instruction
 * afterwards: there is no property to set, no socket, no stdin protocol.
 * `EncoderChannel` therefore reports every camera on this spawner as not
 * controllable and changes nothing, which is the true answer. Giving the
 * child a stdin pipe and writing commands into it would produce the same
 * silence with none of the report — K-48's failure exactly, one layer down.
 */
export const plainSpawner: ProcessSpawner = (argv) => {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "inherit"] });
  return {
    kill: (signal) => { child.kill(signal as NodeJS.Signals | undefined); },
    on: (event, fn) => { child.on(event, (arg: unknown) => { fn(arg); }); },
  };
};

/**
 * How long a runner has to prove it started before this file stops trusting
 * it. Longer than an interpreter needs to fail an import and shorter than a
 * pipeline that is genuinely running will live.
 */
const GRACE_MS = 3_000;

/**
 * `first` where it can be run and does run; `second` everywhere else
 * (R-VID-07, and rule 6: nothing may take the picture away).
 *
 * **This replaces the one part of the video path that is known to work on
 * hardware, so the old part stays reachable in both the ways it is needed.**
 * A board with no host installed never spawns one. A board where the host is
 * installed but *cannot start* — no `python3-gi`, a GStreamer too old to
 * address, a pipeline it will not witness — is not left with a dead camera
 * either: the runner that has always worked is spawned in its place, in the
 * same wrapper, and the supervisor is never told the first one exited,
 * because from the camera's point of view nothing did.
 *
 * **The fallback costs the control channel, and says so rather than hiding
 * it.** `send` is taken off the wrapper the moment `second` takes over, so
 * `Supervisor.send` answers false and `EncoderChannel` reports *no control
 * channel* — the true statement about what is now running. Leaving `send` in
 * place would write commands into a program that reads none, and answer an
 * operator's bitrate change with a silence: K-48 again, one layer down.
 *
 * **One fallback, and only inside the grace window.** A host that ran for an
 * hour and then died is a pipeline that failed, which is the supervisor's
 * business and gets its backoff; a second fallback would be this file
 * retrying a decision it has already made, so falling back closes the window
 * it was allowed by. And a process killed by `stop()` exited because it was
 * told to, so a kill disarms the window too.
 */
export function preferring(opts: {
  first: ProcessSpawner;
  second: ProcessSpawner;
  usable: () => boolean;
  clock?: Clock;
  graceMs?: number;
  note?: (message: string) => void;
}): ProcessSpawner {
  const clock = opts.clock ?? systemClock;
  const graceMs = opts.graceMs ?? GRACE_MS;
  const note = opts.note ?? ((message: string) => process.stderr.write(`${message}\n`));

  return (argv) => {
    if (!opts.usable()) return opts.second(argv);

    const exits: ((arg: unknown) => void)[] = [];
    const errors: ((arg: unknown) => void)[] = [];
    const inbox: ((line: string) => void)[] = [];
    let child = opts.first(argv);
    let early = true;
    let killed = false;

    const timer = clock.setTimer(graceMs, () => { early = false; });

    const wrapper: SpawnedProcess = {
      kill: (signal) => {
        killed = true;
        clock.clearTimer(timer);
        child.kill(signal);
      },
      on: (event, fn) => { (event === "exit" ? exits : errors).push(fn); },
      send: (line) => { child.send?.(line); },
      onMessage: (fn) => { inbox.push(fn); },
    };

    const ended = (fns: ((arg: unknown) => void)[], arg: unknown, why: string): void => {
      if (early && !killed) {
        // Closing the window here is what makes the fallback once-only: the
        // second runner's own early exit is a pipeline that failed, which is
        // the supervisor's business. A separate `fell` flag beside this line
        // would say the same thing and could never be made to fail a test.
        early = false;
        clock.clearTimer(timer);
        delete wrapper.send;
        note(`the pipeline host ${why}; falling back to ${argv[0]}, `
          + "which carries video but takes no instruction once it is running");
        child = opts.second(argv);
        attach(child);
        return;
      }
      for (const fn of [...fns]) fn(arg);
    };

    function attach(proc: SpawnedProcess): void {
      proc.onMessage?.((line) => { for (const fn of [...inbox]) fn(line); });
      proc.on("exit", (arg) => { ended(exits, arg, `exited with code ${String(arg)}`); });
      proc.on("error", (arg) => { ended(errors, arg, `could not be started: ${String(arg)}`); });
    }

    attach(child);
    return wrapper;
  };
}

/**
 * The real one, and the only place in this package that starts a pipeline.
 *
 * **Untested, and it has to be.** Nothing in this repository's suite spawns a
 * process from *this* value — that is what `ProcessSpawner` exists for — so
 * this line is the seam's far side. It is an assembly of three pieces that
 * are each tested on their own, for exactly that reason: `preferring` against
 * fake spawners, `controlledSpawner` against the real host with a fake
 * GStreamer under it, and `plainSpawner` unchanged from the shape that has
 * run every pipeline this project has ever run.
 *
 * `usable` is asked on **every** spawn rather than once at load, so a device
 * that has just had the host installed picks it up the next time a camera
 * starts, without the daemon being restarted underneath a flying aircraft.
 */
export const systemSpawner: ProcessSpawner = preferring({
  first: controlledSpawner(PIPELINE_HOST),
  second: plainSpawner,
  usable: () => executable(PIPELINE_HOST),
});

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
