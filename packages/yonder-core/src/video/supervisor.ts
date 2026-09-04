// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { systemClock, type Clock } from "../apply/types.js";

/**
 * Spawning and supervising one pipeline per camera (R-CTL-01).
 *
 * **This is the whole runtime surface in M4.** Start and stop are process
 * lifecycle; resolution, codec and bitrate are a respawn; a keyframe on
 * reconnect is arranged in the pipeline rather than commanded. What M4
 * therefore does not build is a control channel into a running pipeline —
 * R-VID-07's adaptive bitrate in M9 cannot be built without one, so it carries
 * that cost rather than this milestone paying it early.
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

  constructor(opts: { spawner?: ProcessSpawner; clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.spawner = opts.spawner ?? (() => { throw new Error("no spawner configured"); });
  }

  start(id: string, argv: string[]): void {
    const existing = this.entries.get(id);
    if (existing && (existing.run.state === "starting" || existing.run.state === "running")) return;
    const entry: Entry = existing ?? {
      run: { id, state: "stopped", since: this.clock.now(), restarts: 0 },
      argv, proc: null, settle: null, retry: null, stopping: false,
    };
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

  private spawn(id: string, entry: Entry): void {
    entry.run = { ...entry.run, state: "starting", since: this.clock.now() };
    const proc = this.spawner(entry.argv);
    entry.proc = proc;

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
