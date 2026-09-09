// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import {
  Supervisor, preferring, type ProcessSpawner, type SpawnedProcess,
} from "./supervisor.js";

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
  /** A spawn that never got as far as a process: ENOENT, EACCES. */
  error(reason: unknown): void;
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
      error: (reason) => handlers.error.forEach((h) => h(reason)),
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
  it("keeps retrying an autostart pipeline until its media server returns, and honors Stop", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV, { retryForever: true });
    for (let i = 0; i < 8; i++) {
      spawned[spawned.length - 1].exit(1);
      advance(30_000);
    }
    expect(spawned).toHaveLength(9);
    advance(3000);
    expect(s.state("cam0").state).toBe("running");
    s.stop("cam0");
    spawned[spawned.length - 1].exit(0);
    advance(60_000);
    expect(spawned).toHaveLength(9);
    expect(s.state("cam0").state).toBe("stopped");
  });

  it("handles a synchronous spawn failure without wedging startup or losing retries", () => {
    const { spawner, spawned } = fakeSpawner();
    const { clock, advance } = fakeClock();
    let ready = false;
    const s = new Supervisor({ clock, spawner: (argv) => {
      if (!ready) throw new Error("pipeline host unavailable");
      return spawner(argv);
    } });
    expect(() => s.start("cam0", ARGV, { retryForever: true })).not.toThrow();
    expect(s.state("cam0").state).toBe("failed");
    ready = true;
    advance(1000);
    expect(spawned).toHaveLength(1);
    advance(3000);
    expect(s.state("cam0").state).toBe("running");
  });

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

/**
 * Choosing a runner, and surviving the one that is new.
 *
 * `installer/payload/yonder-pipeline` replaces the one part of the video path
 * that is known to work on hardware, so the rule this describes is rule 6's:
 * **nothing may take the picture away.** Two ways the host can be unavailable
 * and they are different facts about the device — it was never installed, and
 * it is installed and will not start — and a board hitting either must still
 * carry video, on the runner that has always carried it.
 */
describe("preferring one runner over another", () => {
  function pair() {
    const host = fakeSpawner();
    const plain = fakeSpawner({ channel: false });
    return { host, plain };
  }

  function build(opts: { usable: boolean; graceMs?: number }) {
    const { host, plain } = pair();
    const { clock, advance } = fakeClock();
    const notes: string[] = [];
    const spawner = preferring({
      first: host.spawner, second: plain.spawner,
      usable: () => opts.usable, clock,
      ...(opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
      note: (m) => { notes.push(m); },
    });
    return { spawner, host, plain, advance, clock, notes };
  }

  it("runs the host, over a channel, where the host can be run", () => {
    const { spawner, host, plain } = build({ usable: true });
    const proc = spawner(ARGV);
    expect(host.spawned).toHaveLength(1);
    expect(host.spawned[0].argv).toEqual(ARGV);
    expect(plain.spawned).toHaveLength(0);
    proc.send?.('{"id":1}');
    expect(host.spawned[0].sent).toEqual(['{"id":1}']);
  });

  it("runs the old runner, and offers no channel, where there is no host", () => {
    // Not a degraded control channel: none at all. `EncoderChannel` reads
    // the absence and reports `notControllable`, which is the true answer
    // and is the whole difference from K-48.
    const { spawner, host, plain } = build({ usable: false });
    const proc = spawner(ARGV);
    expect(plain.spawned).toHaveLength(1);
    expect(host.spawned).toHaveLength(0);
    expect(proc.send).toBeUndefined();
  });

  it("carries video on the old runner when the host will not start", () => {
    // A board with no python3-gi, or a GStreamer too old to address: the
    // host exits at once and the camera must still stream.
    const { spawner, host, plain, notes } = build({ usable: true, graceMs: 3_000 });
    const exits: unknown[] = [];
    const proc = spawner(ARGV);
    proc.on("exit", (code) => exits.push(code));

    host.spawned[0].exit(1);
    expect(plain.spawned).toHaveLength(1);
    expect(plain.spawned[0].argv).toEqual(ARGV);
    // The supervisor is never told the first one died, because from the
    // camera's point of view nothing did — a reported exit here would count
    // a restart and burn one of the five a camera is allowed.
    expect(exits).toEqual([]);
    expect(notes.join(" ")).toContain("falling back");
  });

  it("takes the channel away when it falls back, rather than writing into a pipe nothing reads", () => {
    const { spawner, host } = build({ usable: true });
    const proc = spawner(ARGV);
    expect(proc.send).toBeDefined();
    host.spawned[0].exit(1);
    expect(proc.send).toBeUndefined();
  });

  it("passes on what the runner it fell back to says", () => {
    const { spawner, host, plain } = build({ usable: true });
    const exits: unknown[] = [];
    const proc = spawner(ARGV);
    proc.on("exit", (code) => exits.push(code));
    host.spawned[0].exit(1);
    plain.spawned[0].exit(9);
    // Falls back once. The second failure is a pipeline that failed, which
    // is the supervisor's business and gets its backoff.
    expect(plain.spawned).toHaveLength(1);
    expect(exits).toEqual([9]);
  });

  it("reports an exit the host takes after it has proved itself", () => {
    // A host that ran for an hour and then died is not a host that would not
    // start, and swapping runners under a working camera would be this file
    // making a decision it already made.
    const { spawner, host, plain, advance } = build({ usable: true, graceMs: 3_000 });
    const exits: unknown[] = [];
    const proc = spawner(ARGV);
    proc.on("exit", (code) => exits.push(code));
    advance(3_001);
    host.spawned[0].exit(1);
    expect(plain.spawned).toHaveLength(0);
    expect(exits).toEqual([1]);
    expect(proc.send).toBeDefined();
  });

  it("does not fall back over a process it was told to kill", () => {
    // stop() kills, the child exits because it was told to, and a fallback
    // here would start a pipeline the operator had just stopped.
    const { spawner, host, plain } = build({ usable: true });
    const proc = spawner(ARGV);
    proc.kill("SIGTERM");
    host.spawned[0].exit(0);
    expect(plain.spawned).toHaveLength(0);
  });

  it("falls back on a spawn that errors, not only on one that exits", () => {
    // ENOENT and EACCES arrive as `error`, never as `exit`, and they are the
    // likeliest shape of "the host is not really there".
    const { spawner, host, plain } = build({ usable: true });
    spawner(ARGV);
    host.spawned[0].error(new Error("ENOENT"));
    expect(plain.spawned).toHaveLength(1);
  });

  it("gives the supervisor one process, whichever runner ends up behind it", () => {
    // The supervisor holds the wrapper and compares it by identity to decide
    // whether a message is stale (see `ended` above). A fallback that handed
    // back a different object would make every later line look stale.
    const { spawner, host } = build({ usable: true });
    const { clock } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    const heard: string[] = [];
    s.onMessage((_, line) => heard.push(line));
    s.start("cam0", ARGV);
    host.spawned[0].emit('{"id":1,"pid":2,"continuous":true,"observed":3000}');
    expect(heard).toEqual(['{"id":1,"pid":2,"continuous":true,"observed":3000}']);
    expect(s.send("cam0", { id: 1 })).toBe(true);
  });

  it("stops offering the channel to the supervisor once it has fallen back", () => {
    const { spawner, host } = build({ usable: true });
    const { clock } = fakeClock();
    const s = new Supervisor({ spawner, clock });
    s.start("cam0", ARGV);
    expect(s.send("cam0", { id: 1 })).toBe(true);
    host.spawned[0].exit(1);
    expect(s.send("cam0", { id: 2 })).toBe(false);
    expect(s.state("cam0")).toMatchObject({ restarts: 0 });
  });
});
