// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { EncoderChannel } from "./encoder.js";
import { compose } from "./pipeline.js";
import { Supervisor, type ProcessSpawner, type SpawnedProcess } from "./supervisor.js";
import { noCapabilities, present } from "./capability.js";
import type { Camera } from "../schema/config.js";

const CAMERA: Camera = {
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
};
const CAPS = {
  ...noCapabilities(),
  formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30, 24, 15] }]),
};
const HW = {
  element: "v4l2h264enc" as const, device: "/dev/video11", hardware: true,
  codec: "h264" as const, detail: "hardware H.264 on /dev/video11",
};
const SOFT = {
  element: "x264enc" as const, device: null, hardware: false,
  codec: "h264" as const, detail: "software",
};

const argvFor = (camera: Camera = CAMERA, encoder = HW): string[] => compose({
  camera, capabilities: CAPS, encoder, rtspBase: "rtsp://127.0.0.1:8554",
});

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

interface Command {
  id: number;
  camera: string;
  op: string;
  sets: { element: string; property: string; value: string }[];
}

/**
 * A pipeline process that records what it is sent and answers for itself.
 *
 * **It reports its own pid and its own timestamp continuity**, and the test
 * decides what it says. That is the whole point: a channel that reported
 * continuity from a flag it set itself would prove nothing, so every claim
 * about the main branch surviving has to come from here — and a fake that
 * *claims* continuity while answering from a new pid is exactly the lie the
 * channel has to catch.
 *
 * `answer()` reads the last command back off the wire and derives what it
 * observed from what it was told, the way a real runner reads a control back
 * off the encoder. A value asserted in a test therefore travelled the whole
 * way: `encodeControl` → `Supervisor.send` → JSON → here → JSON → back.
 */
function fakeSpawner(opts: { controllable?: boolean } = {}) {
  const controllable = opts.controllable ?? true;
  let nextPid = 4200;
  const spawned: {
    argv: string[]; proc: SpawnedProcess; pid: number; sent: Command[];
    answer(over?: { pid?: number; continuous?: boolean; observed?: unknown }): void;
    exit(code: number): void;
  }[] = [];

  const spawner: ProcessSpawner = (argv) => {
    const pid = nextPid++;
    const sent: Command[] = [];
    const inbox: ((line: string) => void)[] = [];
    const handlers: Record<string, ((a: unknown) => void)[]> = { exit: [], error: [] };
    const proc: SpawnedProcess = {
      kill: vi.fn(),
      on: (event, fn) => { handlers[event].push(fn); },
      ...(controllable
        ? {
          send: (line: string) => { sent.push(JSON.parse(line) as Command); },
          onMessage: (fn: (line: string) => void) => { inbox.push(fn); },
        }
        : {}),
    };
    const answer = (over: { pid?: number; continuous?: boolean; observed?: unknown } = {}): void => {
      const last = sent[sent.length - 1];
      const reply = {
        id: last.id,
        pid: over.pid ?? pid,
        continuous: over.continuous ?? true,
        observed: "observed" in over ? over.observed : observedFor(last),
      };
      for (const fn of inbox) fn(JSON.stringify(reply));
    };
    spawned.push({
      argv, proc, pid, sent, answer,
      exit: (code) => handlers.exit.forEach((h) => { h(code); }),
    });
    return proc;
  };
  return { spawner, spawned };
}

/** What the encoder reads back, derived from what it was actually told. */
function observedFor(command: Command): unknown {
  if (command.op === "retune") {
    const value = command.sets[0].value;
    const bits = /video_bitrate=(\d+)/.exec(value);
    return bits ? Number(bits[1]) / 1000 : Number(value);
  }
  const caps = command.sets.map((s) => s.value).join(" ");
  const size = /width=(\d+),height=(\d+)/.exec(caps);
  const fps = /framerate=(\d+)\/1/.exec(caps);
  return { size: `${size?.[1]}x${size?.[2]}`, fps: Number(fps?.[1]) };
}

function running(opts: { controllable?: boolean; camera?: Camera; encoder?: typeof HW | typeof SOFT } = {}) {
  const { clock, advance } = fakeClock();
  const { spawner, spawned } = fakeSpawner({ controllable: opts.controllable });
  const supervisor = new Supervisor({ spawner, clock });
  const camera = opts.camera ?? CAMERA;
  supervisor.start(camera.id, argvFor(camera, opts.encoder ?? HW));
  advance(2_000);   // past SETTLE_MS: the pipeline is running
  const channel = new EncoderChannel({ supervisor, clock });
  return { channel, supervisor, spawned, advance, clock, camera };
}

describe("EncoderChannel.retune", () => {
  it("sends the command to the running pipeline and returns the rate it observed", async () => {
    const { channel, spawned, camera, clock } = running();
    const pending = channel.retune(camera, "stream", 3000);
    // Addressed to the element by name, carrying the encoder's own units.
    expect(spawned[0].sent).toHaveLength(1);
    expect(spawned[0].sent[0].op).toBe("retune");
    expect(spawned[0].sent[0].sets).toEqual([{
      element: "enc-stream", property: "extra-controls",
      value: "controls,video_bitrate=3000000",
    }]);
    spawned[0].answer();
    expect(await pending).toEqual({
      requested: 3000, observed: 3000, continuous: true, at: clock.now(),
    });
  });

  it("keeps the preview's short keyframe interval when it retunes it", () => {
    // `extra-controls` is a whole structure: a retune carrying only
    // video_bitrate would drop h264_i_frame_period and stretch the preview's
    // GOP back to the encoder's default — R-VID-09 undone by a bitrate
    // change, with nothing in any log to see.
    const { channel, spawned, camera } = running();
    void channel.retune(camera, "preview", 800);
    expect(spawned[0].sent[0].sets[0]).toEqual({
      element: "enc-preview", property: "extra-controls",
      value: "controls,video_bitrate=800000,h264_i_frame_period=15",
    });
  });

  it("speaks the software encoder's own units where that is what is running", async () => {
    const { channel, spawned, camera } = running({ encoder: SOFT });
    const pending = channel.retune(camera, "stream", 1500);
    expect(spawned[0].sent[0].sets[0]).toEqual({
      element: "enc-stream", property: "bitrate", value: "1500",
    });
    spawned[0].answer();
    expect(await pending).toMatchObject({ observed: 1500 });
  });

  it("relays the rate it is given and never a rate of its own", () => {
    // R-CMD-04/R-CMD-05: the envelope is the rate controller's business
    // (Task 31) and the operator's before that. A channel that clamped here
    // would be a second policy, disagreeing silently with the first.
    const { channel, spawned, camera } = running();
    void channel.retune(camera, "stream", 9999);
    expect(spawned[0].sent[0].sets[0].value).toBe("controls,video_bitrate=9999000");
  });
});

describe("EncoderChannel.reconfigurePreview", () => {
  it("moves the preview branch and leaves the main branch untouched", async () => {
    const { channel, spawned, supervisor, camera, clock } = running();
    const before = spawned[0].pid;

    const pending = channel.reconfigurePreview(camera, { size: "854x480", fps: 10 });
    expect(spawned[0].sent[0].op).toBe("reconfigure-preview");
    expect(spawned[0].sent[0].sets).toEqual([
      { element: "preview-scale", property: "caps", value: "video/x-raw,width=854,height=480" },
      { element: "preview-rate", property: "caps", value: "video/x-raw,framerate=10/1" },
    ]);
    spawned[0].answer();
    expect(await pending).toEqual({
      requested: { size: "854x480", fps: 10 },
      observed: { size: "854x480", fps: 10 },
      continuous: true, at: clock.now(),
    });

    // Nothing addresses the main encode, nothing respawns, and the process
    // that answered is the one that was already running.
    expect(spawned).toHaveLength(1);
    expect(spawned[0].pid).toBe(before);
    expect(spawned[0].proc.kill).not.toHaveBeenCalled();
    expect(supervisor.state(camera.id)).toMatchObject({ state: "running", restarts: 0 });
    expect(spawned[0].sent.flatMap((c) => c.sets).map((s) => s.element))
      .not.toContain("enc-stream");
  });

  it("reports a break when the process that answers is not the one that answered before", async () => {
    // The pid is the witness the channel cannot fake for itself. A process
    // claiming its timestamps ran clean is claiming it about *its* pipeline,
    // and a new pipeline is precisely the break being asked about.
    const { channel, spawned, camera } = running();
    const first = channel.retune(camera, "preview", 500);
    spawned[0].answer();
    await first;

    const second = channel.reconfigurePreview(camera, { size: "854x480", fps: 10 });
    spawned[0].answer({ pid: 9999, continuous: true });
    expect(await second).toMatchObject({ continuous: false });
  });

  it("reports a break when the process says its timestamps broke", async () => {
    const { channel, spawned, camera } = running();
    const pending = channel.reconfigurePreview(camera, { size: "854x480", fps: 10 });
    spawned[0].answer({ continuous: false });
    expect(await pending).toMatchObject({
      observed: { size: "854x480", fps: 10 }, continuous: false,
    });
  });

  it("reports a break when the pipeline was respawned across the request", async () => {
    // The third witness, and the only one that does not come from the
    // process: a pipeline that died and came back mid-request answers as a
    // new process and the supervisor has counted the restart.
    const { channel, spawned, supervisor, camera, advance } = running();
    const pending = channel.reconfigurePreview(camera, { size: "854x480", fps: 10 });
    spawned[0].exit(1);
    advance(1_000);                       // the backoff fires; a second process
    expect(spawned).toHaveLength(2);
    expect(supervisor.state(camera.id).restarts).toBe(1);
    advance(5_000);                       // the replacement never saw the request
    expect(await pending).toEqual({
      requested: { size: "854x480", fps: 10 },
      // The rung the replacement was started at, not the one that was asked
      // for and not the one the dead process might have reached.
      observed: { size: "640x360", fps: 15 },
      continuous: false,
      at: expect.any(Number) as number,
    });
  });
});

describe("EncoderChannel, when the request does not land", () => {
  it("keeps the last confirmed state and names the request that failed", async () => {
    const { channel, spawned, camera, advance } = running();
    const first = channel.retune(camera, "stream", 3000);
    spawned[0].answer();
    await first;

    const second = channel.retune(camera, "stream", 3500);
    advance(2_000);                       // nothing answers
    expect(await second).toMatchObject({ requested: 3500, observed: 3000 });
  });

  it("starts from what the launch line is running, not from what was applied since", async () => {
    // K-48 exactly: config.yaml at 2000 kb/s while the pipeline that is
    // running was started at 100. A channel that seeded from the camera it
    // was handed would report the configuration's number back and be wrong
    // in the same direction as the defect it exists to fix.
    const { channel, advance } = running({ camera: { ...CAMERA, bitrate_kbps: 100 } });
    const pending = channel.retune({ ...CAMERA, bitrate_kbps: 2000 }, "stream", 3000);
    advance(2_000);
    expect(await pending).toMatchObject({ requested: 3000, observed: 100 });
  });

  it("does not claim a break the pipeline never had", async () => {
    // A request that went unanswered did nothing at all, so the picture is
    // as continuous as it was — the failure is `requested` against
    // `observed`, and continuity is a separate value (spec section 8.1).
    const { channel, camera, advance } = running();
    const pending = channel.retune(camera, "stream", 3000);
    advance(2_000);
    expect(await pending).toMatchObject({ continuous: true });
  });

  it("treats an answer it cannot read as no answer at all", async () => {
    const { channel, spawned, camera, advance } = running();
    const pending = channel.retune(camera, "stream", 3000);
    spawned[0].answer({ observed: "much faster" });
    advance(2_000);
    expect(await pending).toMatchObject({ requested: 3000, observed: 2000 });
  });

  it("does not take an answer from a different camera's pipeline", async () => {
    // Request ids are handed out by this channel across every camera it
    // serves, so an id alone does not say which pipeline a line came from.
    // Two cameras retuning at once is the ordinary case, not a corner.
    const { clock, advance } = fakeClock();
    const { spawner, spawned } = fakeSpawner();
    const supervisor = new Supervisor({ spawner, clock });
    supervisor.start("cam0", argvFor());
    supervisor.start("cam1", argvFor({ ...CAMERA, id: "cam1", bitrate_kbps: 1000 }));
    advance(2_000);
    const channel = new EncoderChannel({ supervisor, clock });

    const pending = channel.retune(CAMERA, "stream", 3000);
    // cam1's process answers cam0's request id, claiming 3000 kb/s.
    spawned[1].sent.push(spawned[0].sent[0]);
    spawned[1].answer();
    advance(2_000);
    expect(await pending).toMatchObject({ requested: 3000, observed: 2000 });
  });

  it("stops holding a dead process's rate the moment a new one answers", async () => {
    // A retune that landed on the pipeline that has since been replaced says
    // nothing about the pipeline running now — which was started from
    // config.yaml again, at the rate the launch line carries. Reporting the
    // old process's confirmed rate would be K-48's own mistake with an extra
    // step.
    const { channel, spawned, camera, advance } = running();
    const first = channel.retune(camera, "stream", 3000);
    spawned[0].answer();
    expect(await first).toMatchObject({ observed: 3000 });

    const second = channel.retune(camera, "stream", 3500);
    spawned[0].answer({ pid: 9999, observed: "not a rate" });
    advance(2_000);
    expect(await second).toMatchObject({
      requested: 3500, observed: 2000, continuous: false,
    });
  });

  it("does not take an answer meant for a different request", async () => {
    const { channel, spawned, camera, advance } = running();
    const pending = channel.retune(camera, "stream", 3000);
    const command = spawned[0].sent[0];
    // A reply carrying somebody else's request id.
    spawned[0].sent.push({ ...command, id: command.id + 100 });
    spawned[0].answer();
    advance(2_000);
    expect(await pending).toMatchObject({ observed: 2000 });
  });
});

describe("EncoderChannel, where there is nothing to control", () => {
  it("says so when the camera is not running", async () => {
    const { clock } = fakeClock();
    const { spawner } = fakeSpawner();
    const supervisor = new Supervisor({ spawner, clock });
    const channel = new EncoderChannel({ supervisor, clock });
    expect(await channel.retune(CAMERA, "stream", 3000))
      .toEqual({ notControllable: expect.stringContaining("cam0 is not running") as string });
  });

  it("says so when the running pipeline takes no instruction", async () => {
    // `gst-launch-1.0` reads its pipeline from argv and then listens to
    // nobody. Reporting that is the difference between a control that
    // refuses and a control that appears to work (K-48).
    const { channel, camera } = running({ controllable: false });
    const ack = await channel.retune(camera, "stream", 3000);
    expect(ack).toEqual({ notControllable: expect.stringContaining("no control channel") as string });
  });

  it("says so for a feed that carries the source's own encoding", async () => {
    // A fixed-passthrough main feed has no encoder element in its launch
    // line, so there is nothing named to address — derived from the pipeline
    // that is running rather than declared anywhere.
    const { clock, advance } = fakeClock();
    const { spawner } = fakeSpawner();
    const supervisor = new Supervisor({ spawner, clock });
    const passthrough = argvFor().filter((t, i, all) => {
      const at = all.indexOf("name=enc-stream");
      return i < at - 1 || i > at + 1;    // the element, its name and its bitrate
    });
    supervisor.start("cam0", passthrough);
    advance(2_000);
    const channel = new EncoderChannel({ supervisor, clock });
    const ack = await channel.retune(CAMERA, "stream", 3000);
    expect(ack).toEqual({
      notControllable: expect.stringContaining("no encoder on it to retune") as string,
    });
    // ...and the preview of that same camera is still controllable: this is
    // one feed's answer, not the camera's.
    const pending = channel.retune(CAMERA, "preview", 700);
    advance(2_000);
    expect(await pending).toMatchObject({ requested: 700, observed: 400 });
  });
});
