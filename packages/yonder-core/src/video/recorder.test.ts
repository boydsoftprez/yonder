// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Recorder, isRefusal,
  type Answer, type Capture, type CameraMedium, type PipelineChannel,
} from "./recorder.js";
import type { RunningEncodes } from "./pipeline.js";
import type { RunState } from "./supervisor.js";
import type { Camera } from "../schema/config.js";

/**
 * Recording to the board and taking a still, with no board (R-CAM-17,
 * R-CAM-18, R-STO-06).
 *
 * **Nothing here touches a real disk to answer a question about space.** The
 * free-space reader is injected, so the reserve — the one behaviour that
 * cannot be exercised any other way without filling a card — is driven from
 * a number a test sets. Captures themselves *are* written, into a temporary
 * directory, by a stand-in for the pipeline host: the listing, the fetch and
 * the delete are then the real ones reading a real directory rather than a
 * description of one.
 *
 * `host.test.ts` is where the GStreamer half is proved, against the real
 * Python program. This file is the other half: what the daemon does with it.
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

/** A second camera, and the one the tests give an own recorder to. */
const POCKET = { ...CAMERA, id: "cam1", name: "Pocket" } as unknown as Camera;

const RUNNING: RunningEncodes = {
  stream: 2000, preview: 900, shape: { size: "854x480", fps: 15 },
};

const MB = 1024 * 1024;
const RESERVE_MB = 1024;
/** 2000 kb/s is 250 000 bytes a second. */
const BYTES_PER_SECOND = (2000 * 1000) / 8;

/**
 * Timers this test fires by hand, so the reserve watch is driven rather than
 * waited for. `Viewers`' own tests take the same shape and for the same
 * reason: a test that slept would be measuring the machine it ran on.
 */
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

/** Let every queued microtask and promise run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => { setImmediate(r); });
}

interface BoardOptions {
  cameras?: readonly Camera[];
  free?: number;
  reserveMb?: number;
  running?: Record<string, RunState>;
  inForce?: (id: string) => RunningEncodes | null;
  onCamera?: CameraMedium;
  watchMs?: number;
  /** The host answers nothing at all — a pipeline with no control channel. */
  deaf?: boolean;
  /** The host refuses a still: no fresh frame to give. */
  noFreshFrame?: boolean;
  /** What the host says about the main branch. True unless a test says not. */
  continuous?: boolean;
}

/**
 * A recorder with a stand-in for the pipeline host under it.
 *
 * The stand-in behaves as `installer/payload/yonder-pipeline` does — it
 * answers on the same envelope, it writes the file it is told to write, and
 * it refuses in the same shape — so what is under test here is the daemon's
 * half and only that.
 */
function board(opts: BoardOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "yonder-captures-"));
  const clock = fakeClock();
  const sent: Record<string, unknown>[] = [];
  const listeners: ((camera: string, line: string) => void)[] = [];
  const freeReads: number[] = [];
  let free = opts.free ?? 8 * 1024 * MB;
  const running: Record<string, RunState> = opts.running ?? { cam0: "running", cam1: "running" };
  const recorded = new Map<string, string>();

  /** What the host would write and answer, one command at a time. */
  const answer = (camera: string, message: Record<string, unknown>): void => {
    const op = String(message.op);
    const path = typeof message.path === "string" ? message.path : "";
    let observed: unknown;
    if (op === "still" && opts.noFreshFrame) {
      observed = { refused: "the pipeline delivered no fresh frame within 2.0 s, so nothing was written" };
    } else if (op === "still") {
      writeFileSync(path, "a jpeg");
      observed = { path, bytes: 6, width: CAMERA.width, height: CAMERA.height };
    } else if (op === "record") {
      writeFileSync(path, "mkv");
      recorded.set(camera, path);
      observed = { path, recording: true };
    } else if (op === "record-stop") {
      const held = recorded.get(camera);
      if (held === undefined) observed = { refused: "this camera is not recording" };
      else {
        recorded.delete(camera);
        observed = { path: held, bytes: 3, recording: false };
      }
    }
    const line = JSON.stringify({
      id: message.id, pid: 4242, continuous: opts.continuous ?? true, observed,
    });
    for (const fn of listeners) fn(camera, line);
  };

  let deaf = opts.deaf === true;
  const channel: PipelineChannel = {
    send(camera, message) {
      sent.push(message as Record<string, unknown>);
      if (deaf) return false;
      queueMicrotask(() => { answer(camera, message as Record<string, unknown>); });
      return true;
    },
    onMessage(fn) { listeners.push(fn); },
    state: (camera) => ({
      id: camera, state: running[camera] ?? "stopped", since: 0, restarts: 0,
    }),
  };

  const recorder = new Recorder({
    channel,
    cameras: () => opts.cameras ?? [CAMERA, POCKET],
    reserveMb: () => opts.reserveMb ?? RESERVE_MB,
    freeBytes: () => { freeReads.push(free); return Promise.resolve(free); },
    root,
    clock: clock.clock,
    inForce: opts.inForce ?? ((id) => (running[id] === undefined ? null : RUNNING)),
    ...(opts.onCamera === undefined ? {} : { onCamera: opts.onCamera }),
    watchMs: opts.watchMs ?? 5_000,
  });

  return {
    recorder, root, clock, sent, freeReads,
    ops: (): string[] => sent.map((m) => String(m.op)),
    setFree(bytes: number): void { free = bytes; },
    /** The pipeline stops taking instruction — its control channel is gone. */
    goDeaf(): void { deaf = true; },
    stopPipeline(id: string): void { running[id] = "failed"; },
    cleanup(): void { rmSync(root, { recursive: true, force: true }); },
  };
}

/** The value of an answer that must have succeeded. */
function ok<T>(answer: Answer<T>): T {
  if (isRefusal(answer)) throw new Error(`expected an answer, got: ${answer.refused}`);
  return answer.ok;
}

/** The camera's own medium: `cam1` holds one file, and Yonder never saw it. */
const ON_CAMERA: Capture = {
  name: "DJI_0001.MP4", at: 1_699_000_000_000, bytes: 91_000_000,
  width: 1920, height: 1080, held: "camera",
};
const CARD: CameraMedium = {
  holds: (id) => id === "cam1",
  captures: (id) => Promise.resolve(id === "cam1" ? [ON_CAMERA] : []),
};

let boards: { cleanup(): void }[] = [];
beforeEach(() => { boards = []; });
afterEach(() => { for (const b of boards) b.cleanup(); });

function on(opts: BoardOptions = {}): ReturnType<typeof board> {
  const made = board(opts);
  boards.push(made);
  return made;
}

describe("recording to the board", () => {
  it("starts, and reports what is being written and since when", async () => {
    const b = on();
    const state = ok(await b.recorder.record("cam0", "start"));
    expect(state).toMatchObject({ recording: true, since: b.clock.at(), destination: "board" });
    expect(b.sent[0]).toMatchObject({ camera: "cam0", op: "record" });
    // The path is under this camera's own directory, and its name is the
    // moment it was taken with the shape it was taken at — which is what
    // makes the listing sortable and a collision impossible.
    expect(String(b.sent[0]?.path)).toMatch(/cam0\/[\d-]+T[\d-]+Z-1280x720\.mkv$/);
  });

  it("stops, and the state stops saying it is recording", async () => {
    const b = on();
    await b.recorder.record("cam0", "start");
    const stopped = ok(await b.recorder.record("cam0", "stop"));
    expect(stopped).toMatchObject({ recording: false, since: null });
    expect(b.ops()).toEqual(["record", "record-stop"]);
    // An operator's own stop needs no explanation, so none is offered.
    expect(stopped.ended).toBeNull();
  });

  it("refuses a start on a camera with no pipeline to record from", async () => {
    const b = on({ running: { cam0: "stopped" } });
    const answer = await b.recorder.record("cam0", "start");
    expect(answer).toMatchObject({ because: "not-running" });
    expect(b.sent).toEqual([]);
  });

  it("refuses a start on a camera this device does not have", async () => {
    const b = on();
    expect(await b.recorder.record("nope", "start")).toMatchObject({ because: "not-found" });
  });

  it("keeps the recording open when the pipeline says nothing to a stop", async () => {
    // A pipeline that did not answer may still be writing. Forgetting it here
    // would leave a branch on the tee that nothing could ever stop, and a card
    // filling with a file the console had stopped counting.
    const b = on();
    await b.recorder.record("cam0", "start");
    b.goDeaf();
    const answer = await b.recorder.record("cam0", "stop");
    expect(answer).toMatchObject({ because: "unanswered" });
    expect(isRefusal(answer) && answer.refused).toContain("still running");
    expect((await b.recorder.state("cam0")).recording).toBe(true);
  });
});

describe("the reserve (R-STO-06)", () => {
  it("refuses a start when the card is already at the reserve, and writes nothing", async () => {
    const b = on({ free: RESERVE_MB * MB });
    const answer = await b.recorder.record("cam0", "start");
    expect(isRefusal(answer) && answer.because).toBe("no-space");
    expect(isRefusal(answer) && answer.refused).toContain("reserved");
    // Refused **before** anything reached the pipeline: a check made after
    // the branch is on the tee is a check made after the card was written to.
    expect(b.sent).toEqual([]);
  });

  it("ends a recording by itself on the first reading at the reserve, and says so", async () => {
    const b = on({ free: RESERVE_MB * MB + 200 * MB, watchMs: 5_000 });
    await b.recorder.record("cam0", "start");
    expect((await b.recorder.state("cam0")).recording).toBe(true);

    // The card reaches the floor between one look and the next.
    b.setFree(RESERVE_MB * MB);
    await b.clock.advance(5_000);

    // Over already — not on the tick after this one. R-STO-06 is "ends by
    // itself when it is reached rather than by exhausting the card", and a
    // stop one interval late is a stop after another interval of video went
    // on to the card.
    const state = await b.recorder.state("cam0");
    expect(state.recording).toBe(false);
    expect(b.ops()).toEqual(["record", "record-stop"]);
    expect(state.ended?.reason).toContain("1024 MB is reserved");
    expect(state.ended?.at).toBe(b.clock.at());
  });

  it("goes on recording while there is room, and looks again", async () => {
    const b = on({ free: RESERVE_MB * MB + 200 * MB, watchMs: 5_000 });
    await b.recorder.record("cam0", "start");
    await b.clock.advance(5_000);
    await b.clock.advance(5_000);
    expect((await b.recorder.state("cam0")).recording).toBe(true);
    expect(b.ops()).toEqual(["record"]);
  });

  it("shows the remaining time against the reserve, not against an empty card", async () => {
    const b = on({ free: RESERVE_MB * MB + 500 * MB });
    const state = await b.recorder.state("cam0");
    // 500 MB of headroom at 2000 kb/s, and not 1524 MB: the reserve is not
    // the operator's to spend.
    expect(state.remainingSeconds).toBe(Math.floor((500 * MB) / BYTES_PER_SECOND));
  });

  it("shows less as the card fills, and none at the floor", async () => {
    const b = on({ free: RESERVE_MB * MB + 500 * MB });
    const before = (await b.recorder.state("cam0")).remainingSeconds ?? 0;
    b.setFree(RESERVE_MB * MB + 100 * MB);
    const after = (await b.recorder.state("cam0")).remainingSeconds ?? 0;
    expect(after).toBeLessThan(before);
    b.setFree(RESERVE_MB * MB);
    expect((await b.recorder.state("cam0")).remainingSeconds).toBe(0);
  });

  /**
   * L-46: the same headroom, in the unit Photo mode works in. A page that
   * answered "118 min free" under a key that takes photographs would be
   * stating the free space in a unit nothing on the screen is about.
   */
  it("counts the stills that fit, against the reserve and at the camera's own shape", async () => {
    const b = on({ free: RESERVE_MB * MB + 500 * MB });
    const state = await b.recorder.state("cam0");
    // 1280×720 at the measured 0.15 bytes a pixel, out of 500 MB of headroom
    // — the reserve is not the operator's to spend here either.
    const perStill = 1280 * 720 * 0.15;
    expect(state.remainingPhotos).toBe(Math.floor((500 * MB) / perStill));

    b.setFree(RESERVE_MB * MB);
    expect((await b.recorder.state("cam0")).remainingPhotos).toBe(0);
  });

  /**
   * A count is not a rate: a camera whose encoder has been retuned, or that
   * has none at all, still writes stills of a size its own shape predicts. So
   * the two headroom figures are independently null — the recording's is
   * unknown, the photograph's is not.
   */
  it("still counts stills on a feed whose recording rate nothing knows", async () => {
    const b = on({
      free: RESERVE_MB * MB + 500 * MB,
      inForce: () => ({ stream: null, preview: 400, shape: null }),
    });
    const state = await b.recorder.state("cam0");
    expect(state.remainingSeconds).toBeNull();
    expect(state.remainingPhotos).toBeGreaterThan(0);
  });

  it("says nothing at all where the rate is unknown", async () => {
    // A pipeline that is running and carries the source's own encoding: there
    // is no encoder on the feed, so nothing knows what a second of recording
    // costs, and a number worked out from the configuration would be an
    // invention. K-48 is what config-shaped answers look like.
    const b = on({ inForce: () => ({ stream: null, preview: 400, shape: null }) });
    expect((await b.recorder.state("cam0")).remainingSeconds).toBeNull();
  });

  it("prefers the rate the encoder is holding to the one the document asks for", async () => {
    // The adaptive controller has taken this camera down to 500 kb/s. The card
    // therefore lasts four times as long as `bitrate_kbps` would suggest, and
    // the number an operator plans with has to be the true one.
    const b = on({
      free: RESERVE_MB * MB + 500 * MB,
      inForce: () => ({ stream: 500, preview: 300, shape: null }),
    });
    expect((await b.recorder.state("cam0")).remainingSeconds)
      .toBe(Math.floor((500 * MB) / ((500 * 1000) / 8)));
  });

  it("treats a medium it cannot measure as having nothing spare", async () => {
    const b = on();
    const recorder = new Recorder({
      channel: { send: () => true, onMessage: () => {}, state: () => ({ id: "cam0", state: "running", since: 0, restarts: 0 }) },
      cameras: () => [CAMERA],
      reserveMb: () => RESERVE_MB,
      freeBytes: () => Promise.reject(new Error("no such device")),
      root: b.root,
      clock: b.clock.clock,
    });
    // The safe direction: a refused recording costs a capture, and the other
    // way round costs the card.
    expect(await recorder.record("cam0", "start")).toMatchObject({ because: "no-space" });
  });
});

describe("a still (R-CAM-18)", () => {
  it("answers only once the file is written, and with the capture", async () => {
    const b = on();
    const capture = ok(await b.recorder.photo("cam0"));
    expect(capture).toMatchObject({ width: 1280, height: 720, held: "board", bytes: 6 });
    expect(existsSync(join(b.root, "cam0", capture.name))).toBe(true);
  });

  it("refuses with the reason when there is no fresh frame, and reports no capture", async () => {
    // Never an old frame as a new one. The pipeline waits for its second
    // buffer and refuses if it does not come; this carries that refusal out
    // in the pipeline's own words rather than inventing a capture.
    const b = on({ noFreshFrame: true });
    const answer = await b.recorder.photo("cam0");
    expect(isRefusal(answer) && answer.refused).toContain("no fresh frame");
    expect(ok(await b.recorder.captures("cam0"))).toEqual([]);
  });

  it("refuses when there is no pipeline to take a frame from", async () => {
    const b = on({ running: { cam0: "stopped" } });
    expect(await b.recorder.photo("cam0")).toMatchObject({ because: "not-running" });
    expect(b.sent).toEqual([]);
  });

  it("leaves the source untouched and a recording running", async () => {
    // The spiked property, from the daemon's side: taking a still sends one
    // command and one only — nothing restarts the pipeline, nothing stops the
    // recording, and the recording that was open is the same recording
    // afterwards.
    const b = on();
    const started = ok(await b.recorder.record("cam0", "start"));
    const capture = ok(await b.recorder.photo("cam0"));

    expect(b.ops()).toEqual(["record", "still"]);
    const during = await b.recorder.state("cam0");
    expect(during).toMatchObject({ recording: true, since: started.since, ended: null });
    // Both files are there, and they are different files.
    const held = ok(await b.recorder.captures("cam0"));
    expect(held.map((c) => c.name)).toContain(capture.name);
    expect(held.filter((c) => c.name.endsWith(".mkv"))).toHaveLength(1);

    // And the recording is still the one that was running: it stops.
    expect(ok(await b.recorder.record("cam0", "stop"))).toMatchObject({ recording: false });
  });

  it("writes the break to the journal when the pipeline says the main stream broke", async () => {
    // Not a refusal: the capture was written either way and an operator who
    // asked for a photograph should get one. What must not happen is the
    // break going unrecorded — it is the one measured property this whole
    // mechanism rests on.
    const b = on({ continuous: false });
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write")
      .mockImplementation((c) => { lines.push(String(c)); return true; });
    try {
      ok(await b.recorder.photo("cam0"));
    } finally {
      stderr.mockRestore();
    }
    expect(lines.join("")).toContain("the main stream broke while taking a still");
  });
});

describe("one operation at a time, per camera", () => {
  it("refuses a second record while the first is still in flight", async () => {
    const b = on();
    const first = b.recorder.record("cam0", "start");
    const second = await b.recorder.record("cam0", "start");
    expect(second).toMatchObject({ because: "busy" });
    ok(await first);
    // A second press must be refused, not queued: exactly one command left.
    expect(b.ops()).toEqual(["record"]);
  });

  it("refuses a second photo while the first is still in flight", async () => {
    const b = on();
    const first = b.recorder.photo("cam0");
    const second = await b.recorder.photo("cam0");
    expect(second).toMatchObject({ because: "busy" });
    ok(await first);
    expect(b.ops()).toEqual(["still"]);
  });

  it("refuses a photo while a record is in flight, and the other way round", async () => {
    const b = on();
    const record = b.recorder.record("cam0", "start");
    expect(await b.recorder.photo("cam0")).toMatchObject({ because: "busy" });
    ok(await record);
    expect(b.ops()).toEqual(["record"]);
  });

  it("holds each camera's operations apart from the other's", async () => {
    // The guard is per camera, because the pipelines are. A second camera
    // must not be blocked by the first one's shutter.
    const b = on({ onCamera: { holds: () => false, captures: () => Promise.resolve([]) } });
    const [one, two] = await Promise.all([
      b.recorder.photo("cam0"),
      b.recorder.photo("cam1"),
    ]);
    ok(one);
    ok(two);
    expect(b.ops()).toEqual(["still", "still"]);
  });

  it("lets the next operation through once the first has finished", async () => {
    const b = on();
    ok(await b.recorder.photo("cam0"));
    ok(await b.recorder.photo("cam0"));
    expect(b.ops()).toEqual(["still", "still"]);
  });
});

describe("the captures this device is holding", () => {
  it("lists them newest first, with the shape and the size of each", async () => {
    const b = on();
    const first = ok(await b.recorder.photo("cam0"));
    await b.clock.advance(1_000);
    const second = ok(await b.recorder.photo("cam0"));

    const held = ok(await b.recorder.captures("cam0"));
    expect(held.map((c) => c.name)).toEqual([second.name, first.name]);
    expect(held[0]).toMatchObject({
      at: second.at, bytes: 6, width: 1280, height: 720, held: "board",
    });
  });

  it("leaves out anything in the directory that is not a capture", async () => {
    const b = on();
    mkdirSync(join(b.root, "cam0"), { recursive: true });
    writeFileSync(join(b.root, "cam0", "notes.txt"), "hello");
    ok(await b.recorder.photo("cam0"));
    expect(ok(await b.recorder.captures("cam0")).map((c) => c.name))
      .not.toContain("notes.txt");
  });

  it("answers with an empty list for a camera nothing has been taken from", async () => {
    const b = on();
    expect(ok(await b.recorder.captures("cam0"))).toEqual([]);
  });

  it("hands over the bytes of one, with a content type", async () => {
    const b = on();
    const capture = ok(await b.recorder.photo("cam0"));
    const body = ok(await b.recorder.fetch("cam0", capture.name));
    expect(body.contentType).toBe("image/jpeg");
    expect(body.bytes.toString("utf8")).toBe("a jpeg");
  });

  it("gives a recording its own content type", async () => {
    const b = on();
    await b.recorder.record("cam0", "start");
    await b.recorder.record("cam0", "stop");
    const [recording] = ok(await b.recorder.captures("cam0"));
    expect(ok(await b.recorder.fetch("cam0", recording?.name ?? "")).contentType)
      .toBe("video/x-matroska");
  });

  it("refuses a name it never wrote", async () => {
    const b = on();
    expect(await b.recorder.fetch("cam0", "../../etc/yonder/secrets.yaml"))
      .toMatchObject({ because: "not-found" });
  });

  it("deletes one, and it is gone from the disk and from the listing", async () => {
    const b = on();
    const capture = ok(await b.recorder.photo("cam0"));
    expect(ok(await b.recorder.remove("cam0", capture.name))).toEqual({ name: capture.name });
    expect(existsSync(join(b.root, "cam0", capture.name))).toBe(false);
    expect(ok(await b.recorder.captures("cam0"))).toEqual([]);
  });

  it("refuses to delete the file a recording is still being written to", async () => {
    const b = on();
    await b.recorder.record("cam0", "start");
    const [open] = ok(await b.recorder.captures("cam0"));
    expect(await b.recorder.remove("cam0", open?.name ?? "")).toMatchObject({ because: "busy" });
    expect(existsSync(join(b.root, "cam0", open?.name ?? ""))).toBe(true);
  });

  it("refuses a delete of something that is not there", async () => {
    const b = on();
    expect(await b.recorder.remove("cam0", "2026-01-01T00-00-00-000Z-1280x720.jpg"))
      .toMatchObject({ because: "not-found" });
  });
});

describe("a camera that holds its own captures (R-CAM-17, R-CAM-18)", () => {
  it("reports the camera as the medium doing the work", async () => {
    const b = on({ onCamera: CARD });
    expect((await b.recorder.state("cam1")).destination).toBe("camera");
    expect((await b.recorder.state("cam0")).destination).toBe("board");
  });

  it("does not report this board's headroom under a camera's own medium", async () => {
    // R-CAM-17 asks for the remaining time on the medium *doing the work*. A
    // camera recording to its own card is not spending this board's, and a
    // number about the wrong medium is worse than none, because an operator
    // would plan with it.
    const b = on({ onCamera: CARD, free: RESERVE_MB * MB + 500 * MB });
    expect((await b.recorder.state("cam1")).remainingSeconds).toBeNull();
    expect((await b.recorder.state("cam0")).remainingSeconds).toBeGreaterThan(0);
  });

  it("lists a camera-held capture as the camera's, beside the board's own", async () => {
    const b = on({ onCamera: CARD });
    const held = ok(await b.recorder.captures("cam1"));
    expect(held).toEqual([ON_CAMERA]);
    expect(held[0]?.held).toBe("camera");
  });

  it("will not fetch one, and says why", async () => {
    // Yonder never saw the file. Offering it and failing later would be the
    // console claiming something it does not have.
    const b = on({ onCamera: CARD });
    const answer = await b.recorder.fetch("cam1", ON_CAMERA.name);
    expect(isRefusal(answer) && answer.because).toBe("on-camera");
    expect(isRefusal(answer) && answer.refused).toContain("never saw the file");
  });

  it("will not delete one either", async () => {
    const b = on({ onCamera: CARD });
    expect(await b.recorder.remove("cam1", ON_CAMERA.name)).toMatchObject({ because: "on-camera" });
  });

  it("does not drive the camera's own recorder or its shutter", async () => {
    // Modelled, and deliberately not driven: phase 5 waits for hardware, and
    // a driver for a device nobody can test is a claim rather than a feature.
    const b = on({ onCamera: CARD });
    expect(await b.recorder.record("cam1", "start")).toMatchObject({ because: "on-camera" });
    expect(await b.recorder.photo("cam1")).toMatchObject({ because: "on-camera" });
    expect(b.sent).toEqual([]);
  });
});

describe("a recording whose pipeline goes away", () => {
  it("is over, and the state says what ended it", async () => {
    const b = on();
    await b.recorder.record("cam0", "start");
    b.stopPipeline("cam0");
    const state = await b.recorder.state("cam0");
    expect(state.recording).toBe(false);
    expect(state.ended?.reason).toContain("pipeline stopped");
  });

  it("is not asked to stop by the reserve watch either", async () => {
    const b = on({ free: RESERVE_MB * MB + 200 * MB, watchMs: 5_000 });
    await b.recorder.record("cam0", "start");
    b.stopPipeline("cam0");
    await b.clock.advance(5_000);
    expect(b.ops()).toEqual(["record"]);
    expect((await b.recorder.state("cam0")).recording).toBe(false);
  });
});

describe('native accessory capture dispatch', () => {
  it('uses observed camera recording state and never spends board space or invents photo files', async () => {
    const observed = { recording: true, since: 1000, destination: 'camera' as const, remainingSeconds: 120, remainingPhotos: 40, bytes: null, ended: null, observed: true, phase: 'recording' };
    const medium: CameraMedium = { holds: id => id === 'cam1', captures: async () => [], state: vi.fn(async () => observed),
      record: vi.fn(async () => observed), photo: vi.fn(async () => ({ destination: 'camera', kind: 'photo' })) };
    const b = on({ onCamera: medium, running: { cam0: 'running', cam1: 'stopped' } });
    expect(await b.recorder.state('cam1')).toEqual(observed);
    expect(await b.recorder.record('cam1', 'start')).toEqual({ ok: observed });
    expect(medium.record).toHaveBeenCalledWith('cam1', 'start');
    expect(await b.recorder.photo('cam1')).toEqual({ ok: { destination: 'camera', kind: 'photo' } });
    expect(b.sent).toEqual([]); expect(b.freeReads).toEqual([]);
  });
  it('reports an absent native card without silently recording to the board', async () => {
    const b = on({ onCamera: { holds: () => true, captures: async () => [], record: async () => { throw new Error('No recognized camera card'); } } });
    expect(await b.recorder.record('cam1', 'start')).toEqual({ refused: 'No recognized camera card', because: 'unanswered' });
    expect(b.sent).toEqual([]);
  });
});
