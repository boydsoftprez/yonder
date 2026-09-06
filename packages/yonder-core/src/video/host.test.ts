// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EncoderChannel } from "./encoder.js";
import { compose } from "./pipeline.js";
import { Supervisor, controlledSpawner } from "./supervisor.js";
import { noCapabilities, present } from "./capability.js";
import type { Camera } from "../schema/config.js";

/**
 * `installer/payload/yonder-pipeline`, run.
 *
 * **The real program, not a description of it.** CI has no GStreamer and no
 * camera, so the temptation is a TypeScript stand-in that speaks the protocol
 * — and that is precisely the defect this branch keeps meeting: a value that
 * travels partway and stops. Here the actual Python starts, parses the actual
 * argv `compose()` emits, walks a graph built from it, sets properties and
 * answers over its own stdout, with `src/video/fake-gi` standing in for
 * PyGObject underneath it. A rate asserted below went the whole way:
 * `encodeControl` → `Supervisor.send` → a pipe → Python → an element's
 * property → back off that element → a pipe → `Ack.observed`.
 *
 * What it cannot prove is what only a board can: that `v4l2h264enc` honours
 * `extra-controls` while playing, and that the picture does not break when it
 * does. Task 1 measured the first (`docs/hardware/runtime-encoder-control.md`)
 * and the board proof for this host measures the second.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..", "..");
const HOST = join(ROOT, "installer", "payload", "yonder-pipeline");
const FAKE_GI = join(HERE, "fake-gi");

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

/** The queue `compose()` puts on every branch, for the hand-written launch
 *  lines below that exist to be refused. */
const QUEUE = "queue leaky=downstream max-size-time=200000000 "
  + "max-size-buffers=0 max-size-bytes=0";

let dir: string;
let traces = 0;
const running: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "yonder-host-")); traces = 0; });
afterEach(() => {
  for (const child of running.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

function traceFile(): string {
  const path = join(dir, `trace-${++traces}.ndjson`);
  writeFileSync(path, "");
  return path;
}

function traced(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` is true, or give up. Used instead of a fixed sleep so the
 *  timing of a test is a fact about the program rather than about the
 *  machine it is running on. */
async function until(what: string, fn: () => boolean, budget = 10_000): Promise<void> {
  const deadline = Date.now() + budget;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await sleep(20);
  }
}

/** Frames are moving through the `main` tee. The stall half of a continuity
 *  claim is only meaningful once something was arriving to stop. */
const flowing = (trace: string): Promise<void> =>
  until("frames to flow", () => traced(trace).some((e) => e.event === "flowing"));

/** The host, spawned as the installer installs it and spoken to by hand. */
function startHost(tokens: string[], env: Record<string, string> = {}) {
  const trace = traceFile();
  const child = spawn(HOST, tokens, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONPATH: FAKE_GI, YONDER_FAKE_GST_TRACE: trace, ...env },
  });
  running.push(child);
  let out = "";
  let err = "";
  const replies: Record<string, unknown>[] = [];
  let code: number | null = null;
  let done = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
    for (;;) {
      const at = out.indexOf("\n");
      if (at < 0) break;
      replies.push(JSON.parse(out.slice(0, at)) as Record<string, unknown>);
      out = out.slice(at + 1);
    }
  });
  child.stderr.on("data", (chunk: string) => { err += chunk; });
  child.on("exit", (status) => { code = status; done = true; });

  return {
    trace,
    traced: () => traced(trace),
    stderr: () => err,
    exited: () => done,
    code: () => code,
    flowing: () => flowing(trace),
    replies: () => [...replies],
    /** One command down the wire, with no reply expected. */
    tell(command: unknown): void {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    async ask(command: unknown): Promise<Record<string, unknown>> {
      const had = replies.length;
      child.stdin.write(`${JSON.stringify(command)}\n`);
      await until("a reply", () => replies.length > had);
      return replies[had];
    },
    async ended(): Promise<void> { await until("the host to exit", () => done); },
  };
}

const RETUNE_HW = [{
  element: "enc-stream", property: "extra-controls",
  value: "controls,video_bitrate=3000000",
}];
const PREVIEW = [
  { element: "preview-scale", property: "caps", value: "video/x-raw,width=854,height=480" },
  { element: "preview-rate", property: "caps", value: "video/x-raw,framerate=10/1" },
];

describe("the pipeline host runs the pipeline it was given", () => {
  it("is installed as something that can be run", () => {
    // `controlledSpawner` spawns this path, and `preferring` chooses it on
    // exactly this bit. A payload that lost the mode bit is a file that is
    // there and cannot start, which is the fallback path rather than the
    // control channel.
    expect(statSync(HOST).mode & 0o111).toBeGreaterThan(0);
  });

  it("plays the argv compose() emitted, token for token, and composes nothing", async () => {
    // The whole contract. A spike whose pipeline differed from the daemon's
    // cost this project three fix rounds and produced video that never
    // started, because it dropped the level capsfilter, io-mode=4 and the
    // leaky queue.
    const argv = argvFor();
    const host = startHost(argv.slice(1));
    await host.flowing();
    const parsed = host.traced().find((e) => e.event === "parse_launchv");
    // gst-launch-1.0's own `-q` is consumed as the option it is, and every
    // token after it reaches GStreamer untouched — no element added, none
    // dropped, none rewritten.
    const [program, quiet, ...description] = argv;
    expect([program, quiet]).toEqual(["gst-launch-1.0", "-q"]);
    expect(parsed?.tokens).toEqual(description);
  });

  it("watches the tee the pipeline already has, and adds nothing to hold a probe", async () => {
    // K-53, the plan and the spike all say `identity name=tap`, and that is
    // the spike's substrate showing through: a gst-launch string has no
    // other way to hang a probe. This program holds the graph object, so it
    // probes the sink pad of the `main` tee `compose()` already emits —
    // exactly the buffers every ground-station output and every board
    // recording are fed — and the graph under test is the graph that ships.
    const host = startHost(argvFor().slice(1));
    await host.flowing();
    const probes = host.traced().filter((e) => e.event === "add_probe");
    expect(probes.map((e) => e.pad)).toEqual(["main.sink"]);
    const parsed = host.traced().find((e) => e.event === "parse_launchv");
    expect(parsed?.tokens).not.toContain("identity");
  });

  it("will not run a pipeline whose main branch it cannot witness", async () => {
    // Every `continuous` it reported would be a claim it could not see. It
    // refuses instead, and `preferring` then carries the video on
    // gst-launch-1.0 with no channel — which is a true report rather than a
    // continuity claim nobody earned.
    const host = startHost([
      "-q", "v4l2src", "!", "jpegdec", "!", "x264enc", "name=enc-stream", "bitrate=2000",
      "!", "h264parse", "!", "udpsink", "host=127.0.0.1", "port=5600",
    ]);
    await host.ended();
    expect(host.code()).not.toBe(0);
    expect(host.stderr()).toContain("no `main` tee");
  });

  it("refuses an option it does not understand rather than dropping it", async () => {
    const host = startHost(["-q", "--eos-on-shutdown", "videotestsrc", "!", "fakesink"]);
    await host.ended();
    expect(host.code()).not.toBe(0);
    expect(host.stderr()).toContain("--eos-on-shutdown");
  });
});

describe("the pipeline host answers for what the encoder is running", () => {
  it("reports the hardware encoder's rate in the units the channel reads", async () => {
    const host = startHost(argvFor().slice(1));
    await host.flowing();
    expect(await host.ask({ id: 4, camera: "cam0", op: "retune", sets: RETUNE_HW }))
      .toMatchObject({ id: 4, continuous: true, observed: 3000 });
  }, 20_000);

  it("says nothing at all to an op it does not implement", async () => {
    // Silence, not a reply saying nothing happened: the channel reports an
    // unanswered request as a request that did not land, which is what it
    // was, and a reply would have had to invent an `observed`.
    const host = startHost(argvFor().slice(1));
    await host.flowing();
    host.tell({ id: 5, camera: "cam0", op: "restart", sets: [] });
    await until("the refusal", () => host.stderr().includes("no such op"));
    // The next command still answers, so the silence was this op's and not
    // the process having stopped listening.
    expect(await host.ask({ id: 6, camera: "cam0", op: "retune", sets: RETUNE_HW }))
      .toMatchObject({ id: 6 });
    expect(host.replies().map((r) => r.id)).toEqual([6]);
  }, 20_000);

  it("keeps the picture when a command goes wrong", async () => {
    // The instruction is lost either way. What must not be lost is the
    // camera: an unhandled fault here would end the process, and ending the
    // process is the picture stopping — for a bitrate change.
    const host = startHost(argvFor().slice(1));
    await host.flowing();
    host.tell({ id: 20, camera: "cam0", op: "retune", sets: [42] });
    await until("the complaint", () => host.stderr().includes("still running"));
    expect(host.exited()).toBe(false);
    expect(await host.ask({ id: 21, camera: "cam0", op: "retune", sets: RETUNE_HW }))
      .toMatchObject({ id: 21, observed: 3000 });
  }, 20_000);

  it("reports a break when the main branch's timestamps jump", async () => {
    const host = startHost(argvFor().slice(1), { YONDER_FAKE_GST_GAP_AFTER_SET: "1" });
    await host.flowing();
    expect(await host.ask({ id: 7, camera: "cam0", op: "retune", sets: RETUNE_HW }))
      .toMatchObject({ continuous: false, observed: 3000 });
  }, 20_000);

  it("reports a break when the main branch stops delivering at all", async () => {
    // The half a gap count cannot see: frames that stop arriving leave no
    // gap, because they leave nothing.
    const host = startHost(argvFor().slice(1), { YONDER_FAKE_GST_STALL_AFTER_SET: "1" });
    await host.flowing();
    expect(await host.ask({ id: 8, camera: "cam0", op: "retune", sets: RETUNE_HW }))
      .toMatchObject({ continuous: false });
  }, 20_000);
});

describe("the pipeline host moves the preview and nothing else", () => {
  it("reports the shape the pads negotiated, not the shape it was asked for", async () => {
    const host = startHost(argvFor().slice(1));
    await host.flowing();
    expect(await host.ask({ id: 9, camera: "cam0", op: "reconfigure-preview", sets: PREVIEW }))
      .toMatchObject({ continuous: true, observed: { size: "854x480", fps: 10 } });
  }, 20_000);

  it("restarts the preview branch alone where the elements will not renegotiate", async () => {
    // The one command that may cost a restart, and only ever the preview
    // branch's. The branch is found by walking the graph from the elements
    // the instruction names — a list of element names here would be a second
    // copy of compose()'s shape, and the copy that goes stale is the one
    // nothing runs.
    const host = startHost(argvFor().slice(1), { YONDER_FAKE_GST_REFUSE_RENEGOTIATE: "1" });
    await host.flowing();
    const reply = await host.ask({
      id: 10, camera: "cam0", op: "reconfigure-preview", sets: PREVIEW,
    });
    expect(reply).toMatchObject({ continuous: true, observed: { size: "854x480", fps: 10 } });

    const cycled = host.traced().filter((e) => e.event === "sync_state")
      .map((e) => String(e.element));
    expect(cycled).toContain("preview-scale");
    expect(cycled).toContain("preview-rate");
    expect(cycled).toContain("enc-preview");
    // The operator's stream, its outputs and anything recording off them.
    for (const untouched of ["enc-stream", "main", "raw", "v4l2src0", "jpegdec2"]) {
      expect(cycled, `${untouched} was restarted to move a preview`)
        .not.toContain(untouched);
    }
  }, 30_000);

  it("will not restart a branch that runs through the main stream", async () => {
    // The walk's guard. A launch line where the preview capsfilters sit on
    // the main chain would have the restart take the ground station's stream
    // down to move a browser preview; the picture is worth more than the
    // reconfigure, so nothing is restarted and the reply says what the
    // pipeline really holds.
    const line = ("-q v4l2src ! image/jpeg,width=1280,height=720,framerate=30/1 "
      + `! jpegdec ! tee name=raw raw. ! ${QUEUE} `
      + "! capsfilter name=preview-scale caps=video/x-raw,width=640,height=360 "
      + "! videorate ! capsfilter name=preview-rate caps=video/x-raw,framerate=15/1 "
      + "! x264enc name=enc-stream bitrate=2000 ! h264parse ! tee name=main "
      + `main. ! ${QUEUE} ! udpsink host=127.0.0.1 port=5600`).split(" ");
    const host = startHost(line, { YONDER_FAKE_GST_REFUSE_RENEGOTIATE: "1" });
    await host.flowing();
    const reply = await host.ask({
      id: 11, camera: "cam0", op: "reconfigure-preview", sets: PREVIEW,
    });
    expect(host.traced().filter((e) => e.event === "sync_state")).toEqual([]);
    expect(host.stderr()).toContain("runs through the main stream");
    // And it says so by reporting no shape at all, so the channel keeps the
    // last state the pipeline actually confirmed.
    expect(reply.observed).toBeNull();
  }, 30_000);

  it("restarts nothing when the elements are not on a branch of their own", async () => {
    const line = ("-q v4l2src ! image/jpeg,width=1280,height=720,framerate=30/1 ! jpegdec "
      + "! capsfilter name=preview-scale caps=video/x-raw,width=640,height=360 "
      + "! videorate ! capsfilter name=preview-rate caps=video/x-raw,framerate=15/1 "
      + "! x264enc name=enc-stream bitrate=2000 ! h264parse ! tee name=main "
      + `main. ! ${QUEUE} ! udpsink host=127.0.0.1 port=5600`).split(" ");
    const host = startHost(line, { YONDER_FAKE_GST_REFUSE_RENEGOTIATE: "1" });
    await host.flowing();
    await host.ask({ id: 12, camera: "cam0", op: "reconfigure-preview", sets: PREVIEW });
    expect(host.traced().filter((e) => e.event === "sync_state")).toEqual([]);
    expect(host.stderr()).toContain("not on a branch of their own");
  }, 30_000);
});

/**
 * The whole way, with nothing standing in for anything.
 *
 * The channel that answered `notControllable` on real hardware (K-53) put
 * against the program that answers. Every value below crossed a real pipe,
 * was set on an element by the real host and was read back off that element
 * before it came home.
 */
describe("EncoderChannel over the real host", () => {
  function board(encoder: typeof HW | typeof SOFT = HW, env: Record<string, string> = {}) {
    const trace = traceFile();
    const spawner = controlledSpawner(HOST, {
      PYTHONPATH: FAKE_GI, YONDER_FAKE_GST_TRACE: trace, ...env,
    });
    const supervisor = new Supervisor({ spawner });
    const argv = argvFor(CAMERA, encoder);
    supervisor.start(CAMERA.id, argv);
    return {
      supervisor, argv, trace,
      channel: new EncoderChannel({ supervisor }),
      ready: () => flowing(trace),
      stop: () => { supervisor.stop(CAMERA.id); },
    };
  }

  it("moves a running hardware encoder to the rate it was told, and the picture holds", async () => {
    const { channel, ready, stop } = board(HW);
    await ready();
    expect(await channel.retune(CAMERA, "stream", 3000)).toMatchObject({
      requested: 3000, observed: 3000, continuous: true,
    });
    stop();
  }, 20_000);

  it("hands the host exactly what gst-launch-1.0 would have been handed", async () => {
    // Asserted again here, and deliberately: the test above builds the
    // arguments itself, so it proves what the *host* does with them. This one
    // goes through `controlledSpawner`, which is the seam that decides what
    // the host is given — and a spawner passing the program name through
    // survives every other test in this file while composing, on a board, a
    // pipeline whose first element is `gst-launch-1.0`.
    const { argv, ready, trace, stop } = board(HW);
    await ready();
    const parsed = traced(trace).find((e) => e.event === "parse_launchv");
    expect(parsed?.tokens).toEqual(argv.slice(2));
    stop();
  }, 20_000);

  it("speaks the software encoder's own units all the way to the element and back", async () => {
    // x264enc counts in kb/s in a plain property and v4l2h264enc in bits per
    // second inside a structure. The host reads back whatever the element
    // holds, so a unit invented on either side fails here rather than on a
    // board.
    const { channel, ready, stop } = board(SOFT);
    await ready();
    expect(await channel.retune(CAMERA, "stream", 1500)).toMatchObject({
      requested: 1500, observed: 1500, continuous: true,
    });
    stop();
  }, 20_000);

  it("keeps the preview's short keyframe interval through a retune of it", async () => {
    // `extra-controls` is a whole structure: a retune carrying only
    // video_bitrate drops h264_i_frame_period and stretches the preview's
    // GOP back to the encoder's default — R-VID-09 undone by a bitrate
    // change. Asserted at the element, which is where it would be lost.
    const { channel, ready, trace, stop } = board(HW);
    await ready();
    expect(await channel.retune(CAMERA, "preview", 800))
      .toMatchObject({ requested: 800, observed: 800 });
    const set = traced(trace).filter((e) => e.event === "set_arg").pop();
    expect(set?.value).toBe("controls,video_bitrate=800000,h264_i_frame_period=15");
    stop();
  }, 20_000);

  it("holds the preview at a new shape without disturbing the main branch", async () => {
    const { channel, supervisor, ready, stop } = board(HW);
    await ready();
    expect(await channel.reconfigurePreview(CAMERA, { size: "854x480", fps: 10 }))
      .toMatchObject({
        requested: { size: "854x480", fps: 10 },
        observed: { size: "854x480", fps: 10 },
        continuous: true,
      });
    expect(supervisor.state(CAMERA.id).restarts).toBe(0);
    stop();
  }, 30_000);

  it("keeps the last confirmed rate when the pipeline says something it cannot read", async () => {
    // A feed with no encoder on it: the channel refuses before anything is
    // sent, from the launch line the process is running.
    const { channel, supervisor, ready, stop } = board(HW);
    await ready();
    const ack = await channel.retune({ ...CAMERA, id: "cam9" }, "stream", 3000);
    expect(ack).toEqual({
      notControllable: expect.stringContaining("cam9 is not running") as string,
    });
    expect(supervisor.state(CAMERA.id).state).not.toBe("failed");
    stop();
  }, 20_000);
});
