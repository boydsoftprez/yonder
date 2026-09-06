// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { Supervisor, type ProcessSpawner, type SpawnedProcess } from "./supervisor.js";

function fakeClock() {
  let now = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    clock: {
      now: () => now,
      setTimer: (ms: number, fn: () => void) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
      clearTimer: (h: unknown) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers]) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    },
  };
}

interface Spawned {
  argv: string[];
  proc: SpawnedProcess;
  exit(code: number): void;
  /** Every line the supervisor wrote to this process's control channel. */
  sent: string[];
  /** One line back from this process, as its own acknowledgement would be. */
  emit(line: string): void;
}

/**
 * `channel: false` is `gst-launch-1.0`: a process that carries a pipeline and
 * takes no instruction once it is carrying it. The distinction is the point
 * of `SpawnedProcess.send` being optional at all, so both shapes are spawnable
 * here.
 */
function fakeSpawner(opts: { channel?: boolean } = {}) {
  const spawned: Spawned[] = [];
  const spawner: ProcessSpawner = (argv) => {
    const handlers: Record<string, ((a: unknown) => void)[]> = { exit: [], error: [] };
    const sent: string[] = [];
    const inbox: ((line: string) => void)[] = [];
    const proc: SpawnedProcess = {
      kill: vi.fn(),
      on: (event, fn) => { handlers[event].push(fn); },
      ...(opts.channel === false ? {} : {
        send: (line: string) => { sent.push(line); },
        onMessage: (fn: (line: string) => void) => { inbox.push(fn); },
      }),
    };
    spawned.push({
      argv, proc, sent,
      exit: (code) => handlers.exit.forEach((h) => h(code)),
      emit: (line) => inbox.forEach((fn) => { fn(line); }),
    });
    return proc;
  };
  return { spawner, spawned };
}

/**
 * A spawner whose `kill()` does not merely request termination but resolves
 * it inline, delivering `exit` before `kill()` returns rather than on a
 * later tick. Real child processes never do this — SIGTERM is always
 * answered asynchronously — but `ProcessSpawner`'s contract does not forbid
 * it, and `Supervisor.stop()` has to be correct regardless of which kind of
 * spawner it is holding. It exists to isolate `entry.stopping` from the
 * separate stale-process guard: see the test below for why the two are not
 * the same guard wearing two hats.
 */
function reentrantKillSpawner() {
  const spawned: { argv: string[]; proc: SpawnedProcess }[] = [];
  const spawner: ProcessSpawner = (argv) => {
    const handlers: Record<string, ((a: unknown) => void)[]> = { exit: [], error: [] };
    const proc: SpawnedProcess = {
      kill: vi.fn(() => { handlers.exit.forEach((h) => h(0)); }),
      on: (event, fn) => { handlers[event].push(fn); },
    };
    spawned.push({ argv, proc });
    return proc;
  };
  return { spawner, spawned };
}

const ARGV = ["gst-launch-1.0", "-q", "v4l2src"];

describe("Supervisor", () => {
  it("starts stopped, because video does not autocast", () => {
    const s = new Supervisor({ spawner: fakeSpawner().spawner, clock: fakeClock().clock });
    expect(s.state("cam0")).toMatchObject({ state: "stopped", restarts: 0 });
  });

  it("reports starting, then running once the pipeline has held", () => {
    const { spawner } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    // R-UI-05: sent is not taken effect. A pipeline that exits after 200 ms
    // was never running, and a page that said "running" on the spawn call
    // would have reported the command, not its effect.
    expect(s.state("cam0").state).toBe("starting");
    advance(3000);
    expect(s.state("cam0").state).toBe("running");
  });

  it("is failed, with the reason, when the pipeline exits during start-up", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(500);
    spawned[0].exit(255);
    expect(s.state("cam0")).toMatchObject({ state: "failed" });
    expect(s.state("cam0").reason).toContain("255");
  });

  it("restarts a pipeline that dies after it was running, with backoff", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(3000);
    spawned[0].exit(1);
    expect(s.state("cam0").state).toBe("starting");
    advance(1000);
    expect(spawned).toHaveLength(2);
    expect(s.state("cam0").restarts).toBe(1);
  });

  it("gives up after repeated failures rather than restarting for ever", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    for (let i = 0; i < 6; i++) { advance(3000); spawned[spawned.length - 1].exit(1); advance(30_000); }
    expect(s.state("cam0").state).toBe("failed");
    expect(s.state("cam0").reason).toContain("gave up");
  });

  it("stops on request, and does not restart what an operator stopped", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(3000);
    s.stop("cam0");
    expect(spawned[0].proc.kill).toHaveBeenCalled();
    spawned[0].exit(0);
    advance(60_000);
    expect(spawned).toHaveLength(1);
    expect(s.state("cam0").state).toBe("stopped");
  });

  /**
   * **Start, on a camera that has just failed, is the ordinary case** — it is
   * the state the page invites it in — and a failed camera has a retry armed
   * for between one and thirty seconds. A `start()` that did not cancel it
   * spawned one pipeline, the backoff spawned a second, and `entry.proc` then
   * held only the second: the first was a live `gst-launch-1.0` the supervisor
   * had lost the handle to, holding the camera's `/dev/video*` node open. Every
   * later start got `EBUSY` from `v4l2src`, and mediamtx refused it as a second
   * publisher on the same path, so from the console the camera was permanently
   * unstartable until somebody rebooted the board. Verified on hardware.
   */
  it("cancels a pending retry, so Start on a failed camera orphans nothing", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });

    s.start("cam0", ARGV);
    advance(500);
    spawned[0].exit(1);
    expect(s.state("cam0").state).toBe("failed");

    // The operator presses Start while the backoff is still pending.
    s.start("cam0", ARGV);
    expect(spawned).toHaveLength(2);
    advance(30_000);
    // The retry that was armed before the press does not spawn a third.
    expect(spawned).toHaveLength(2);

    // And the one process there is, is the one stop() kills.
    s.stop("cam0");
    expect(spawned[1].proc.kill).toHaveBeenCalled();
  });

  it("ignores Start on a camera that is already starting or running", () => {
    // This is what makes the entry `start()` inherits incapable of holding a
    // live process: the only states that reach the body are `stopped`, where
    // `stop()` has already killed and nulled, and `failed`, where `ended`
    // nulled before it armed the retry the test above cancels.
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });

    s.start("cam0", ARGV);
    s.start("cam0", ARGV);
    expect(spawned).toHaveLength(1);
    advance(3_000);
    expect(s.state("cam0").state).toBe("running");
    s.start("cam0", ARGV);
    expect(spawned).toHaveLength(1);
  });

  it("does not settle a new pipeline on the old one's timer", () => {
    // The settle timer says "this pipeline has held for two seconds". Left
    // armed across a restart it belongs to a process that is gone, and the
    // page turns green on the strength of a dead one.
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });

    s.start("cam0", ARGV);
    advance(1_500);
    spawned[0].exit(1);
    s.start("cam0", ARGV);
    // 500 ms short of this spawn's own settle, and 500 ms past the first's.
    advance(1_500);
    expect(s.state("cam0").state).toBe("starting");
    advance(500);
    expect(s.state("cam0").state).toBe("running");
  });

  it("keeps each camera's state apart", () => {
    const { spawner } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(3000);
    expect(s.state("cam1").state).toBe("stopped");
    expect(s.all().map((r) => r.id).sort()).toEqual(["cam0"]);
  });
});

/**
 * The two guards in `ended()` — `entry.proc !== proc` and `entry.stopping`
 * — read as one belt-and-braces check until something exercises them
 * separately. In every test above, `stop()` has already nulled `entry.proc`
 * by the time the fake spawner's `exit()` is invoked from a later,
 * independent statement, so the stale-process guard alone is what makes
 * those assertions true; a `Supervisor` that forgot `entry.stopping`
 * entirely would still pass all seven cases above. These two tests each
 * force the one guard the other cannot reach.
 */
describe("Supervisor, the two guards in ended()", () => {
  it("ignores a late exit from a process a restart has already superseded", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(3000); // cam0's first process holds and is running.
    spawned[0].exit(1); // it crashes; a restart is scheduled.
    advance(1000); // the backoff elapses; a second process is spawned.
    expect(spawned).toHaveLength(2);
    advance(3000); // the second process holds too.
    expect(s.state("cam0")).toMatchObject({ state: "running", restarts: 1 });

    // The first process's own exit event arrives late — a real SIGKILL or a
    // slow OS teardown outliving the process that superseded it. Without the
    // `entry.proc !== proc` guard this would be read as the *second*
    // process crashing, spawning a spurious third and inflating the restart
    // count for a process nobody is running any more.
    spawned[0].exit(9);
    expect(spawned).toHaveLength(2);
    expect(s.state("cam0")).toMatchObject({ state: "running", restarts: 1 });
  });

  it("does not let a kill's own exit event resurrect what an operator stopped", () => {
    // fakeSpawner's kill() is inert; every test above learns about an exit
    // only from a later, separate statement, by which point stop() has
    // already nulled entry.proc — so entry.proc !== proc alone would explain
    // every assertion above even if entry.stopping did nothing at all. Here
    // kill() resolves inline, so the exit callback runs while entry.proc
    // still equals the process being killed, and only entry.stopping stands
    // between that and a scheduled restart.
    const { spawner, spawned } = reentrantKillSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    advance(3000); // holds and is running.
    s.stop("cam0");
    expect(s.state("cam0").state).toBe("stopped");

    // Nothing may be left pending that would undo that: advancing well past
    // every backoff in the table must spawn nothing further.
    advance(60_000);
    expect(spawned).toHaveLength(1);
    expect(s.state("cam0").state).toBe("stopped");
  });
});

describe("Supervisor's control channel", () => {
  // R-VID-07's half of this file. Tested here rather than only through
  // `EncoderChannel`, because a channel's whole promise passes through this
  // one hop: a command that never leaves the supervisor, or an answer that
  // never reaches it, is a green suite and a picture that does not change.

  it("writes one line to the running process, and says it did", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    expect(s.send("cam0", { op: "retune", kbps: 3000 })).toBe(true);
    expect(spawned[0].sent).toEqual(['{"op":"retune","kbps":3000}']);
  });

  it("refuses to send to a camera that is not running, and sends nothing", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    s.stop("cam0");
    expect(s.send("cam0", { op: "retune" })).toBe(false);
    expect(spawned[0].sent).toEqual([]);
    expect(s.send("cam9", { op: "retune" })).toBe(false);
  });

  it("refuses to send to a process that takes no instruction", () => {
    // The honest answer for `gst-launch-1.0`, and the reason `send` is
    // optional on SpawnedProcess: a pipe nothing reads would swallow every
    // command in silence, which is K-48 one layer down.
    const { spawner } = fakeSpawner({ channel: false });
    const { clock } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    expect(s.send("cam0", { op: "retune" })).toBe(false);
  });

  it("delivers a line from a pipeline tagged with the camera it came from", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    const heard: [string, string][] = [];
    s.onMessage((id, line) => heard.push([id, line]));
    s.start("cam0", ARGV);
    s.start("cam1", ARGV);
    spawned[1].emit('{"id":1}');
    expect(heard).toEqual([["cam1", '{"id":1}']]);
  });

  it("drops a line from a process a restart has already superseded", () => {
    // A dying pipeline can still be draining its output. Its late
    // acknowledgement carries a bitrate the *dead* encoder confirmed, and
    // delivering it as the live one's would be a reading of an encoder that
    // no longer exists.
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    const heard: string[] = [];
    s.onMessage((_, line) => heard.push(line));
    s.start("cam0", ARGV);
    advance(3000);
    spawned[0].exit(1);
    advance(1000);                    // the backoff fires; a second process
    expect(spawned).toHaveLength(2);
    spawned[0].emit('{"stale":true}');
    spawned[1].emit('{"live":true}');
    expect(heard).toEqual(['{"live":true}']);
  });

  it("hands out the line a running pipeline was started with, and nothing else", () => {
    // `entry.argv` outlives the process that ran it, so a stopped camera
    // must answer null rather than a command line for an encoder that
    // exited: it is what the channel addresses its commands by.
    const { spawner } = fakeSpawner();
    const { clock } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    expect(s.argv("cam0")).toBeNull();
    s.start("cam0", ARGV);
    expect(s.argv("cam0")).toEqual(ARGV);
    s.stop("cam0");
    expect(s.argv("cam0")).toBeNull();
  });
});
