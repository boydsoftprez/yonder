// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stills } from "./stills.js";
import { isRefusal, type PipelineChannel } from "./recorder.js";
import { STILLS_INTERVAL_MS } from "./viewers.js";
import type { RunState } from "./supervisor.js";
import type { Camera } from "../schema/config.js";

/**
 * Periodic stills, with no board (R-VID-14, R-VID-11, R-STO-01; spec §8.6).
 *
 * `host.test.ts` proves the host's `still` op against the real Python
 * program; `recorder.test.ts` proves what a *photo* does with it. This file
 * is the third thing: the op on a timer, for whoever is watching, and the
 * two rules that make the strip honest — **one frame per camera per interval
 * however many browsers want it**, and **no frame at all for a camera nobody
 * does**. The stand-in for the host answers on the same envelope and writes
 * the file it is told to write, so the rename, the read and the age are the
 * real ones over a real directory rather than a description of one.
 */

const CAMERA = {
  id: "cam0", name: "Nose", source: "usb",
  device: "platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0",
  enabled: true, autostart: false,
  width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
  preview: {
    mode: "adaptive", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
    floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
  },
  controls: { brightness: null, contrast: null, rotation: 0 },
  outputs: [{ kind: "rtp", enabled: true, host: "192.168.1.50", port: 5600 }],
  stream: { mode: "adaptive", floor_kbps: 500, ceiling_kbps: 4000 },
} as unknown as Camera;

const SECOND = { ...CAMERA, id: "cam1", name: "Tail" } as unknown as Camera;

/** A JPEG's first bytes, so a test reading the file back is reading bytes. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function fakeClock(from = 1_700_000_000_000) {
  let now = from;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimer: (ms: number, fn: () => void): number => {
        seq += 1;
        timers.set(seq, { at: now + ms, fn });
        return seq;
      },
      clearTimer: (h: unknown): void => { timers.delete(h as number); },
    },
    at: (): number => now,
    pending: (): number => timers.size,
    /** Move time on, fire what falls due, and let what it started settle. */
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.fn();
        }
      }
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => { setImmediate(r); });
}

interface BoardOptions {
  /** Read fresh on every tick, as the applied configuration is. */
  cameras?: () => readonly Camera[];
  wanted?: () => readonly string[];
  running?: Record<string, RunState>;
  /** The host answers nothing at all. */
  deaf?: boolean;
  /** The host accepts the request but never answers it. */
  silent?: boolean;
  /** The host refuses a still: no fresh frame to give. */
  noFreshFrame?: boolean;
  /** The host answers, but writes nothing. */
  empty?: boolean;
  /** What the host says about the main branch. */
  continuous?: boolean;
  /** Hold every answer until `release()` is called. */
  gated?: boolean;
  intervalMs?: number;
  generations?: Record<string, number>;
}

/** A generator with a stand-in for the pipeline host under it. */
function board(opts: BoardOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "yonder-stills-"));
  const clock = fakeClock();
  const sent: Record<string, unknown>[] = [];
  const listeners: ((camera: string, line: string) => void)[] = [];
  const running: Record<string, RunState> = opts.running ?? { cam0: "running", cam1: "running" };
  const generations = opts.generations ?? { cam0: 1, cam1: 1 };
  const held: (() => void)[] = [];
  let wanted: readonly string[] = [];

  const answer = (camera: string, message: Record<string, unknown>): void => {
    const path = typeof message.path === "string" ? message.path : "";
    let observed: unknown;
    if (opts.noFreshFrame) {
      observed = { refused: "the pipeline delivered no fresh frame within 2.0 s, so nothing was written" };
    } else if (opts.empty) {
      writeFileSync(path, "");
      observed = { path, bytes: 0 };
    } else {
      writeFileSync(path, JPEG);
      observed = { path, bytes: JPEG.length, width: 1280, height: 720 };
    }
    const line = JSON.stringify({
      id: message.id, pid: 4242, continuous: opts.continuous ?? true, observed,
    });
    for (const fn of listeners) fn(camera, line);
  };

  const channel: PipelineChannel = {
    send(camera, message) {
      sent.push(message as Record<string, unknown>);
      if (opts.deaf) return false;
      if (opts.silent) return true;
      const deliver = (): void => { answer(camera, message as Record<string, unknown>); };
      if (opts.gated) held.push(deliver);
      else queueMicrotask(deliver);
      return true;
    },
    onMessage(fn) { listeners.push(fn); },
    state: (camera) => ({
      id: camera, state: running[camera] ?? "stopped", since: 0, restarts: 0,
    }),
  };

  const stills = new Stills({
    channel,
    cameras: opts.cameras ?? (() => [CAMERA, SECOND]),
    wanted: opts.wanted ?? (() => wanted),
    generation: (id) => generations[id] ?? 0,
    root,
    clock: clock.clock,
    ...(opts.intervalMs === undefined ? {} : { intervalMs: opts.intervalMs }),
    stillMs: 6_000,
  });

  return {
    stills, root, clock, sent,
    /** Which cameras the generator is asked for, per tick. */
    want(...ids: string[]): void { wanted = ids; },
    ops: (): string[] => sent.map((m) => String(m.op)),
    took: (id: string): number => sent.filter((m) => m.op === "still" && m.camera === id).length,
    stopPipeline(id: string): void { running[id] = "stopped"; },
    restartPipeline(id: string): void { generations[id] = (generations[id] ?? 0) + 1; running[id] = "running"; },
    /** A line off the pipe that this generator did not ask for. */
    inject(camera: string, line: string): void { for (const fn of listeners) fn(camera, line); },
    /** Let the host answer what it has been holding. */
    async release(): Promise<void> {
      for (const deliver of held.splice(0)) deliver();
      await settle();
    },
    cleanup(): void { rmSync(root, { recursive: true, force: true }); },
  };
}

let boards: { cleanup(): void }[] = [];
beforeEach(() => { boards = []; });
afterEach(() => { for (const b of boards) b.cleanup(); vi.restoreAllMocks(); });

function on(opts: BoardOptions = {}): ReturnType<typeof board> {
  const made = board(opts);
  boards.push(made);
  return made;
}

/** Everything the daemon wrote to the journal while `work` ran. */
async function journal(work: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((c) => { lines.push(String(c)); return true; });
  try {
    await work();
  } finally {
    stderr.mockRestore();
  }
  return lines.join("");
}

describe("one still per camera per interval, whoever is watching (spec §8.6)", () => {
  it("takes one frame for a camera two viewers coincide on, and none for one nobody wants", async () => {
    const b = on();
    // `wanted` is what `Viewers.wantingStills()` answers: a camera once,
    // however many browsers are on it. Here two are on cam0 and nobody is on
    // cam1 — and what reaches the pipeline is one `still` for cam0, none for
    // cam1. **The mutation this catches:** a generator that took one frame
    // per *viewer* would send two, and one that ignored `wanted` would send
    // a frame for cam1 that nobody asked for.
    b.want("cam0");
    await b.stills.tick();

    expect(b.took("cam0")).toBe(1);
    expect(b.took("cam1")).toBe(0);
    expect(b.ops()).toEqual(["still"]);
  });

  it("takes one per wanted camera per tick, and the next tick takes another", async () => {
    const b = on();
    b.want("cam0", "cam1");
    await b.stills.tick();
    await b.stills.tick();
    expect(b.took("cam0")).toBe(2);
    expect(b.took("cam1")).toBe(2);
  });

  it("stops taking frames for a camera the moment nobody wants them", async () => {
    const b = on();
    b.want("cam0");
    await b.stills.tick();
    b.want();
    await b.stills.tick();
    expect(b.took("cam0")).toBe(1);
    // The last still is kept — with its age growing, which the page shows —
    // rather than thrown away and re-taken the moment somebody comes back.
    expect(b.stills.latest("cam0")).not.toBeNull();
  });

  it("does not ask a second time while the host is still answering the first", async () => {
    const b = on({ gated: true });
    b.want("cam0");
    const first = b.stills.tick();
    const second = b.stills.tick();
    expect(b.took("cam0")).toBe(1);
    await b.release();
    await Promise.all([first, second]);
    expect(b.took("cam0")).toBe(1);
    expect(b.stills.latest("cam0")).not.toBeNull();
  });
});

describe("where a still lives, and what is known about it (R-STO-01)", () => {
  it("lands as <id>.jpg under the root, and only the latest is kept", async () => {
    const b = on();
    b.want("cam0");
    await b.stills.tick();
    expect(readdirSync(b.root)).toEqual(["cam0.jpg"]);
    await b.stills.tick();
    // Overwritten, never accumulated: two ticks, one file.
    expect(readdirSync(b.root)).toEqual(["cam0.jpg"]);
  });

  it("is written to a .next file and renamed, so a read never sees a frame in progress", async () => {
    const b = on({ gated: true });
    b.want("cam0");
    const tick = b.stills.tick();
    // The host has been asked to write beside the served name, not over it.
    expect(String(b.sent[0]?.path)).toBe(join(b.root, "cam0.next.jpg"));
    expect(existsSync(join(b.root, "cam0.jpg"))).toBe(false);
    await b.release();
    await tick;
    expect(readdirSync(b.root)).toEqual(["cam0.jpg"]);
  });

  it("reports when it was taken, its size and its shape", async () => {
    const b = on();
    b.want("cam0");
    const asked = b.clock.at();
    await b.stills.tick();
    expect(b.stills.latest("cam0")).toEqual({
      at: asked, bytes: JPEG.length, width: 1280, height: 720,
    });
  });

  it("dates a frame when the complete JPEG becomes available", async () => {
    const b = on({ gated: true });
    b.want("cam0");
    const tick = b.stills.tick();
    await b.clock.advance(2_500);
    await b.release();
    await tick;

    expect(b.stills.latest("cam0")?.at).toBe(b.clock.at());
    expect(!isRefusal(b.stills.read("cam0")) && b.stills.read("cam0").ok.age).toBe(0);
  });

  it("hands over the bytes, unchanged, with the facts beside them", async () => {
    const b = on();
    b.want("cam0");
    await b.stills.tick();
    const answer = b.stills.read("cam0");
    if (isRefusal(answer)) throw new Error(answer.refused);
    expect(answer.ok.body).toEqual(JPEG);
    expect(answer.ok.contentType).toBe("image/jpeg");
    expect(answer.ok).toMatchObject({ bytes: JPEG.length, width: 1280, height: 720, age: 0 });
    // The age is the frame's, by the clock that stamped it — what the route
    // puts in a header so a browser can show how old the picture is.
    await b.clock.advance(2_500);
    const later = b.stills.read("cam0");
    expect(!isRefusal(later) && later.ok.age).toBe(2_500);
  });

  it("clears what an earlier daemon left, because nothing knows when it was taken", async () => {
    const b = on();
    writeFileSync(join(b.root, "cam0.jpg"), JPEG);
    writeFileSync(join(b.root, "cam1.next.jpg"), JPEG);
    // Not served: a file with no `at` this process knows is not a still.
    expect(b.stills.latest("cam0")).toBeNull();
    expect(isRefusal(b.stills.read("cam0"))).toBe(true);
    // And gone the moment this process takes its first — cam1's stale one
    // included, though nobody asked for cam1.
    b.want("cam0");
    await b.stills.tick();
    expect(readdirSync(b.root)).toEqual(["cam0.jpg"]);
    expect(b.stills.latest("cam0")?.at).toBe(b.clock.at());
  });

  it("touches no directory at all until somebody asks for a still", async () => {
    const b = on();
    const untouched = join(b.root, "never-made");
    const stills = new Stills({
      channel: { send: () => true, onMessage: () => {}, state: (id) => ({ id, state: "running", since: 0, restarts: 0 }) },
      cameras: () => [CAMERA],
      wanted: () => [],
      root: untouched,
    });
    await stills.tick();
    expect(existsSync(untouched)).toBe(false);
  });

  it("says so, once, when the directory cannot be made", async () => {
    // A file where the directory should be: `mkdir -p` cannot make it.
    const blocked = join(mkdtempSync(join(tmpdir(), "yonder-stills-blocked-")), "file");
    writeFileSync(blocked, "not a directory");
    const b = on();
    const stills = new Stills({
      channel: { send: () => true, onMessage: () => {}, state: (id) => ({ id, state: "running", since: 0, restarts: 0 }) },
      cameras: () => [CAMERA],
      wanted: () => ["cam0"],
      root: blocked,
      clock: b.clock.clock,
    });
    const lines = await journal(async () => { await stills.tick(); await stills.tick(); });
    expect(lines.match(/could not be prepared/g) ?? []).toHaveLength(1);
    expect(stills.latest("cam0")).toBeNull();
  });

  it("promises the interval it actually ticks at", () => {
    const b = on();
    expect(b.stills.interval).toBe(STILLS_INTERVAL_MS);
  });
});

describe("a camera with nothing to give", () => {
  it("answers a stopped camera in words, and holds no still for it", async () => {
    const b = on();
    b.want("cam0");
    await b.stills.tick();
    expect(existsSync(join(b.root, "cam0.jpg"))).toBe(true);

    b.stopPipeline("cam0");
    // Known the moment it is asked, not one tick later.
    expect(b.stills.latest("cam0")).toBeNull();
    const answer = b.stills.read("cam0");
    expect(isRefusal(answer) && answer.because).toBe("not-running");
    expect(isRefusal(answer) && answer.refused).toContain("cam0 is not running");

    // And the next tick removes the frame from before it stopped rather than
    // leaving it to age on the tmpfs.
    await b.stills.tick();
    expect(existsSync(join(b.root, "cam0.jpg"))).toBe(false);
    expect(b.took("cam0")).toBe(1);
  });

  it("answers in words before the first still has been taken", () => {
    const b = on();
    const answer = b.stills.read("cam0");
    expect(isRefusal(answer) && answer.because).toBe("not-found");
    expect(isRefusal(answer) && answer.refused).toMatch(/no still of cam0 yet/);
    expect(isRefusal(answer) && answer.refused).toContain("5 s");
  });

  it("answers in words for a camera this device does not have", () => {
    const b = on();
    const answer = b.stills.read("nope");
    expect(isRefusal(answer) && answer.because).toBe("not-found");
  });

  it("keeps the last still, and says so once, when the host has no fresh frame", async () => {
    const b = on();
    b.want("cam0");
    await b.stills.tick();
    const before = b.stills.latest("cam0");

    const refusing = on({ noFreshFrame: true });
    refusing.want("cam0");
    const lines = await journal(async () => {
      await refusing.stills.tick();
      await refusing.stills.tick();
      await refusing.stills.tick();
    });
    // One line for the failure, not one per interval for as long as it lasts.
    expect(lines.match(/no still this interval/g) ?? []).toHaveLength(1);
    expect(lines).toContain("no fresh frame");
    expect(refusing.stills.latest("cam0")).toBeNull();
    // The other board's still is untouched by any of this.
    expect(b.stills.latest("cam0")).toEqual(before);
    // And the file the host may have opened does not survive the refusal.
    expect(readdirSync(refusing.root)).toEqual([]);
  });

  it("keeps the last still when the host says nothing at all", async () => {
    const b = on();
    b.want("cam0");
    await b.stills.tick();
    const before = b.stills.latest("cam0");

    const deaf = on({ deaf: true });
    deaf.want("cam0");
    await deaf.stills.tick();
    expect(deaf.stills.latest("cam0")).toBeNull();
    expect(b.stills.latest("cam0")).toEqual(before);
  });

  it("bounds an accepted request when the host never answers", async () => {
    const b = on({ silent: true });
    b.want("cam0");
    let settled = false;
    const tick = b.stills.tick().then(() => { settled = true; });
    await b.clock.advance(5_999);
    expect(settled).toBe(false);
    await b.clock.advance(1);
    await tick;

    expect(settled).toBe(true);
    expect(b.stills.latest("cam0")).toBeNull();
    expect(readdirSync(b.root)).toEqual([]);
  });

  it("does not report a file with nothing in it as a still", async () => {
    const b = on({ empty: true });
    b.want("cam0");
    await b.stills.tick();
    expect(b.stills.latest("cam0")).toBeNull();
    expect(readdirSync(b.root)).toEqual([]);
  });

  it("lets go of a still for a camera an apply removed", async () => {
    // `cameras` is read fresh on every tick, as the applied configuration
    // is; the apply is the list changing underneath.
    const applied = { cameras: [CAMERA, SECOND] as readonly Camera[] };
    const b = on({ cameras: () => applied.cameras });
    b.want("cam0", "cam1");
    await b.stills.tick();
    expect(readdirSync(b.root).sort()).toEqual(["cam0.jpg", "cam1.jpg"]);

    applied.cameras = [CAMERA];
    // Configuration is read on access as well as on the timer: a removed
    // source must not remain current for the rest of this interval.
    expect(b.stills.latest("cam1")).toBeNull();
    await b.stills.tick();
    expect(b.stills.latest("cam1")).toBeNull();
    expect(readdirSync(b.root)).toEqual(["cam0.jpg"]);
    // And no frame was asked of a camera that is no longer configured.
    expect(b.took("cam1")).toBe(1);
  });

  it("invalidates the previous process's frame immediately across a restart", async () => {
    const b = on();
    b.want("cam0");
    await b.stills.tick();
    expect(b.stills.latest("cam0")).not.toBeNull();

    b.restartPipeline("cam0");
    expect(b.stills.latest("cam0")).toBeNull();
    expect(isRefusal(b.stills.read("cam0"))).toBe(true);

    await b.stills.tick();
    expect(b.took("cam0")).toBe(2);
    expect(b.stills.latest("cam0")).not.toBeNull();
  });

  it("drops a completed frame when the process restarted while the host was answering", async () => {
    const b = on({ gated: true });
    b.want("cam0");
    const old = b.stills.tick();
    b.restartPipeline("cam0");
    await b.release();
    await old;

    expect(b.stills.latest("cam0")).toBeNull();
    expect(readdirSync(b.root)).toEqual([]);

    const fresh = b.stills.tick();
    await b.release();
    await fresh;
    expect(b.stills.latest("cam0")).not.toBeNull();
  });

  it("writes the break to the journal when the pipeline says the main stream broke", async () => {
    const b = on({ continuous: false });
    b.want("cam0");
    const lines = await journal(async () => { await b.stills.tick(); });
    expect(lines).toContain("the main stream broke while taking a still");
    // The still was still taken: the strip gets its frame, and the journal
    // gets the fact.
    expect(b.stills.latest("cam0")).not.toBeNull();
  });
});

describe("the timer", () => {
  it("ticks on its own clock once started, at the interval, and stops for good", async () => {
    const b = on({ intervalMs: 5_000 });
    b.want("cam0");
    b.stills.start();
    expect(b.took("cam0")).toBe(0);

    await b.clock.advance(4_999);
    expect(b.took("cam0")).toBe(0);
    await b.clock.advance(1);
    expect(b.took("cam0")).toBe(1);
    await b.clock.advance(5_000);
    expect(b.took("cam0")).toBe(2);

    b.stills.stop();
    await b.clock.advance(20_000);
    expect(b.took("cam0")).toBe(2);
    // And a start after a stop brings nothing back.
    b.stills.start();
    await b.clock.advance(20_000);
    expect(b.took("cam0")).toBe(2);
  });

  it("starts once, however many times it is asked to", async () => {
    const b = on({ intervalMs: 5_000 });
    b.want("cam0");
    b.stills.start();
    b.stills.start();
    await b.clock.advance(5_000);
    expect(b.took("cam0")).toBe(1);
  });

  it("ignores a reply addressed to a photo or a retune, and answers only its own", async () => {
    // Three tables of outstanding ids share one pipe: `EncoderChannel`'s
    // numbers, `Recorder`'s `rec-…`, and this file's `still-…`. A reply to
    // either of the others, on the same camera, must not settle a still —
    // and the wrong camera's reply to *our* id must not either.
    const b = on({ gated: true });
    b.want("cam0");
    const tick = b.stills.tick();
    const id = String(b.sent[0]?.id);
    expect(id).toMatch(/^still-\d+$/);

    const foreign = (reply: Record<string, unknown>): string =>
      JSON.stringify({ pid: 1, continuous: true, observed: { path: "/nowhere", bytes: 99 }, ...reply });
    b.inject("cam0", foreign({ id: "rec-1" }));
    b.inject("cam0", foreign({ id: 1 }));
    b.inject("cam1", foreign({ id }));
    await settle();
    // Still waiting: none of those was an answer to this request.
    expect(b.stills.latest("cam0")).toBeNull();

    await b.release();
    await tick;
    expect(b.stills.latest("cam0")).not.toBeNull();
  });
});
