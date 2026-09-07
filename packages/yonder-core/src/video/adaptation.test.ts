// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adaptation, RATE_THRESHOLDS } from "./adaptation.js";
import { Viewers } from "./viewers.js";
import { EncoderChannel } from "./encoder.js";
import { compose, ENCODE_ELEMENT } from "./pipeline.js";
import { Supervisor, type ProcessSpawner, type SpawnedProcess } from "./supervisor.js";
import { noCapabilities, present } from "./capability.js";
import { atIp } from "./present.js";
import type { RateChannel } from "./rate.js";
import type { Camera } from "../schema/config.js";
import type { Encoder } from "./probe/encoder.js";
import { createRouter } from "../daemon/routes.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import { RTSP_BASE } from "../media/ports.js";
import { SecretStore } from "../secrets/store.js";
import { AdminCredential, ADMIN_PASSWORD_SECRET } from "../console/credential.js";
import { hashPassword } from "../console/password.js";
import type { Clock, Renderer } from "../apply/types.js";

/**
 * The join `rate.ts` did not have (R-VID-07, R-VID-11).
 *
 * `RateController` was built and proved and left with **no production
 * caller**: nothing constructed one, nothing gave it a measurement, nothing
 * ticked it. Two correct halves that never met, which from the operator's
 * seat is an Adaptive switch that does nothing — K-49 again, one layer out.
 *
 * So these tests follow one browser's statistic all the way: in at the
 * daemon's own route, through `Viewers` deciding it is evidence, into a
 * controller, out through `EncoderChannel` and `Supervisor.send`, and into
 * the `extra-controls` property of a running element — with the pipeline's
 * process id unchanged, because the picture must not restart.
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
  outputs: [],
  stream: { mode: "adaptive", floor_kbps: 500, ceiling_kbps: 4000 },
} as unknown as Camera;

const SECOND = { ...CAMERA, id: "cam1", name: "Tail" } as unknown as Camera;

const CAPS = {
  ...noCapabilities(),
  formats: present([{ fourcc: "MJPG", width: 1280, height: 720, rates: [30, 24, 15] }]),
};
const HW: Encoder = {
  element: "v4l2h264enc", h265: null, decoder: null, device: "/dev/video11", hardware: true,
  detail: "hardware H.264 on /dev/video11",
};

interface Sent {
  id: number;
  op: string;
  sets: { element: string; property: string; value: string }[];
}

/**
 * A board with a pipeline on it that answers.
 *
 * The process speaks the control protocol `installer/payload/yonder-pipeline`
 * speaks: it reads a `retune`, echoes back the rate it was actually set to,
 * and reports the same process id every time — which is what makes
 * `Ack.continuous` mean *the picture did not restart* rather than *nobody
 * checked*.
 */
function board(opts: { cameras?: readonly Camera[] } = {}) {
  const applied = { cameras: opts.cameras ?? [CAMERA] };
  const sent: Sent[] = [];
  const spawns: string[][] = [];
  const timers: { at: number; fn: () => void }[] = [];
  let now = 1_000_000;
  let pid = 4200;
  const clock: Clock = {
    now: () => now,
    setTimer: (ms, fn) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
  };

  const spawner: ProcessSpawner = (argv) => {
    spawns.push([...argv]);
    const mine = ++pid;
    const inbox: ((line: string) => void)[] = [];
    return {
      kill: vi.fn(), on: vi.fn(),
      onMessage: (fn: (line: string) => void) => { inbox.push(fn); },
      send: (line: string) => {
        const command = JSON.parse(line) as Sent;
        sent.push(command);
        const observed = command.op === "retune"
          ? Number(/video_bitrate=(\d+)/.exec(command.sets[0]?.value ?? "")?.[1] ?? 0) / 1000
          : shapeOf(command);
        for (const fn of inbox) {
          fn(JSON.stringify({ id: command.id, pid: mine, continuous: true, observed }));
        }
      },
    } as SpawnedProcess;
  };

  const supervisor = new Supervisor({ spawner, clock });
  const channel = new EncoderChannel({ supervisor, clock });
  let adaptation: Adaptation | undefined;
  const viewers = new Viewers({
    cameras: () => applied.cameras,
    inForce: (id) => channel.inForce(id),
    clock,
    onReport: (report) => { adaptation?.observe(report); },
  });
  adaptation = new Adaptation({
    channel,
    cameras: () => applied.cameras,
    clock,
    onTick: (at) => { viewers.sweep(at); },
    onDecisions: (decisions) => { viewers.decided(decisions); },
  });

  return {
    applied, sent, spawns, supervisor, channel, viewers,
    adaptation,
    clock,
    at: () => now,
    pid: () => pid,
    start(camera: Camera = CAMERA) {
      supervisor.start(camera.id, compose({
        camera, capabilities: CAPS, encoder: HW, rtspBase: RTSP_BASE,
      }));
    },
    advance(ms: number) {
      now += ms;
      for (const t of [...timers]) if (t.at <= now) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    },
  };
}

function shapeOf(command: Sent): { size: string; fps: number } {
  const caps = command.sets.map((s) => s.value).join(" ");
  const width = /width=(\d+)/.exec(caps)?.[1] ?? "0";
  const height = /height=(\d+)/.exec(caps)?.[1] ?? "0";
  const fps = /framerate=(\d+)\//.exec(caps)?.[1] ?? "15";
  return { size: `${width}x${height}`, fps: Number(fps) };
}

const retunes = (sent: readonly Sent[], element: string): Sent[] =>
  sent.filter((s) => s.op === "retune" && s.sets[0]?.element === element);

describe("Adaptation, the caller the rate controller did not have", () => {
  it("moves a real encoder from a browser's own statistic, without restarting the picture", async () => {
    const b = board();
    b.start();
    const spawnedOnce = b.spawns.length;

    // A browser opens the picture and reports what its path is carrying.
    b.viewers.subscribe("v1", "cam0", "video");
    b.viewers.report("v1", { camera: "cam0", rtt: 40, loss: 0, egress: 900, capacity: 40_000 });

    // One tick of the daemon's own clock.
    b.adaptation.tick();
    await b.adaptation.settled();

    const stream = retunes(b.sent, ENCODE_ELEMENT.stream);
    expect(stream).toHaveLength(1);
    // Its own applied ceiling, not the link's 40 Mb/s.
    expect(stream[0].sets[0].value).toBe("controls,video_bitrate=4000000");
    expect(b.channel.inForce("cam0")).toMatchObject({ stream: 4000 });
    // The pipeline was never respawned: one process, one launch line, and the
    // picture on screen never went black.
    expect(b.spawns).toHaveLength(spawnedOnce);
    expect(b.supervisor.state("cam0").restarts).toBe(0);
  });

  it("holds, and says why, when no browser has reported anything", () => {
    const b = board();
    b.start();
    const decisions = b.adaptation.tick();
    expect(b.sent).toEqual([]);
    for (const d of decisions) expect(d.action).toMatch(/^hold-/);
    expect(decisions[0].reason).toContain("no fresh report from any viewer");
  });

  it("carries every decision to the picture, reason and all", () => {
    const b = board();
    b.start();
    b.viewers.subscribe("v1", "cam0", "video");
    b.viewers.report("v1", { camera: "cam0", rtt: 40, loss: 0, egress: 900, capacity: 40_000 });
    b.adaptation.tick();
    const state = b.viewers.state("cam0", "v1");
    expect(state.shared.step).not.toBeNull();
    expect(state.overlay.step).toContain("kb/s");
  });

  it("keeps one camera's evidence off another camera's encoder", async () => {
    const b = board({ cameras: [CAMERA, SECOND] });
    b.start(CAMERA);
    b.start(SECOND);
    b.viewers.subscribe("v1", "cam0", "video");
    b.viewers.subscribe("v1", "cam1", "video");
    // Only cam0's browser has measured anything.
    b.viewers.report("v1", { camera: "cam0", rtt: 40, loss: 0, egress: 900, capacity: 40_000 });
    const decisions = b.adaptation.tick();
    await b.adaptation.settled();

    expect(b.sent.length).toBeGreaterThan(0);
    const forTail = decisions.filter((d) => d.camera === "cam1");
    expect(forTail).toHaveLength(3);
    for (const d of forTail) expect(d.action).toMatch(/^hold-/);
    expect(b.channel.inForce("cam1")).toMatchObject({ stream: 2000 });
  });

  it("drops a report for a camera this device is not configured with", () => {
    const b = board();
    b.start();
    b.adaptation.observe({
      camera: "ghost", viewer: "v1", rtt: 40, loss: 0, egress: 0, capacity: 40_000, at: b.at(),
    });
    b.adaptation.tick();
    expect(b.sent).toEqual([]);
  });

  it("lets go of a controller for a camera an apply removed", async () => {
    const b = board({ cameras: [CAMERA, SECOND] });
    b.start(CAMERA);
    b.start(SECOND);
    b.viewers.subscribe("v1", "cam1", "video");
    b.viewers.report("v1", { camera: "cam1", rtt: 40, loss: 0, egress: 900, capacity: 40_000 });
    b.adaptation.tick();
    await b.adaptation.settled();
    expect(retunes(b.sent, ENCODE_ELEMENT.stream).length).toBeGreaterThan(0);

    // The operator removed the tail camera and applied it.
    b.applied.cameras = [CAMERA];
    const after = b.adaptation.tick();
    expect(after.every((d) => d.camera === "cam0")).toBe(true);
  });

  it("ticks on its own clock once started, and stops for good when told to", async () => {
    const b = board();
    b.start();
    b.viewers.subscribe("v1", "cam0", "video");
    b.viewers.report("v1", { camera: "cam0", rtt: 40, loss: 0, egress: 900, capacity: 40_000 });

    b.adaptation.start();
    b.advance(1_000);
    await b.adaptation.settled();
    const moved = retunes(b.sent, ENCODE_ELEMENT.stream).length;
    expect(moved).toBe(1);

    // A fresh statistic, narrow enough that a tick would certainly act on it,
    // and a full tick period: nothing decides anything.
    b.adaptation.stop();
    b.viewers.report("v1", { camera: "cam0", rtt: 40, loss: 0, egress: 900, capacity: 1_000 });
    b.advance(1_000);
    await b.adaptation.settled();
    expect(retunes(b.sent, ENCODE_ELEMENT.stream)).toHaveLength(moved);

    // And a start after a stop does not bring the loop back — with the
    // evidence just as fresh, so what is being asserted is the latch and not
    // a report that went stale while the test was not looking.
    b.adaptation.start();
    b.viewers.report("v1", { camera: "cam0", rtt: 40, loss: 0, egress: 900, capacity: 1_000 });
    b.advance(1_000);
    await b.adaptation.settled();
    expect(retunes(b.sent, ENCODE_ELEMENT.stream)).toHaveLength(moved);
  });

  it("lets go of a full-rate hold before it works out what the link affords", () => {
    const b = board();
    b.start();
    b.viewers.subscribe("v1", "cam0", "video");
    b.viewers.fullRate("v1", "cam0", true);
    expect(b.viewers.state("cam0", "v1").mine.fullRate).toBe(true);
    b.advance(20_000);
    b.adaptation.tick();
    expect(b.viewers.state("cam0", "v1").mine.fullRate).toBe(false);
  });

  it("names its thresholds rather than burying them", () => {
    expect(RATE_THRESHOLDS.tDown).toBeGreaterThan(0);
    expect(RATE_THRESHOLDS.tUp).toBeGreaterThan(RATE_THRESHOLDS.tDown);
    expect(RATE_THRESHOLDS.hysteresisKbps).toBeGreaterThan(0);
  });

  it("survives a policy that will not load, rather than taking the daemon down", () => {
    const channel: RateChannel = {
      inForce: () => null,
      retune: () => Promise.resolve({ notControllable: "no" }),
      reconfigurePreview: () => Promise.resolve({ notControllable: "no" }),
    };
    const timers: { at: number; fn: () => void }[] = [];
    let now = 0;
    const clock: Clock = {
      now: () => now,
      setTimer: (ms, fn) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
      clearTimer: (h) => { const i = timers.indexOf(h as never); if (i >= 0) timers.splice(i, 1); },
    };
    const adaptation = new Adaptation({
      channel, clock,
      cameras: () => { throw new Error("config.yaml is not readable"); },
    });
    adaptation.start();
    now += 1_000;
    expect(() => { for (const t of [...timers]) { timers.splice(timers.indexOf(t), 1); t.fn(); } })
      .not.toThrow();
    // And it armed itself again, rather than stopping at the first failure.
    expect(timers).toHaveLength(1);
    adaptation.stop();
  });
});

/**
 * The same journey, but starting at the daemon's own route.
 *
 * `createRouter` rather than a direct call on `Viewers`, because the seam
 * this proves is the one a browser actually crosses: a POST arrives with a
 * viewer id and a statistic in it, and a bitrate comes out at the far end.
 */
describe("a browser statistic, in at the route", () => {
  const noop: Renderer = { name: "noop", async render() {} };

  /** A device somebody has already set a password on: the router refuses
   *  every configuration route on one that nobody has (R-SEC-09). */
  function provisioned(dir: string): AdminCredential {
    const secrets = new SecretStore(join(dir, "secrets.yaml"));
    secrets.ensureValue(ADMIN_PASSWORD_SECRET, hashPassword("an operator's password"));
    return new AdminCredential(secrets);
  }

  function routed() {
    const dir = mkdtempSync(join(tmpdir(), "yonder-viewers-"));
    const configPath = join(dir, "config.yaml");
    saveConfig(configPath, { ...DEFAULT_CONFIG, cameras: [CAMERA] } as never);
    const b = board();
    const engine = new ApplyEngine({
      configPath, journalPath: join(dir, "apply.json"), renderers: [noop], clock: b.clock,
    });
    const route = createRouter({
      engine, configPath, credential: provisioned(dir), viewers: b.viewers,
    });
    return { ...b, route, configPath, done: () => { rmSync(dir, { recursive: true, force: true }); } };
  }

  it("reaches a running encoder, and answers with the picture's own state", async () => {
    const r = routed();
    try {
      r.start();
      const answer = await r.route("POST", "/cameras/cam0/viewers/abc123", {
        want: "video",
        stats: { rtt: 42, loss: 0, egress: 900, capacity: 40_000, frameAge: 120 },
      });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        camera: "cam0", viewer: "abc123", revision: 2,
        mine: { delivery: "video", source: "cam0-preview", frameAge: 120 },
      });

      r.adaptation.tick();
      await r.adaptation.settled();
      const stream = retunes(r.sent, ENCODE_ELEMENT.stream);
      expect(stream).toHaveLength(1);
      expect(stream[0].sets[0].value).toBe("controls,video_bitrate=4000000");
      expect(r.spawns).toHaveLength(1);
    } finally {
      r.done();
    }
  });

  it("takes the arrival stamp from this daemon, never from the browser", async () => {
    const r = routed();
    try {
      r.start();
      await r.route("POST", "/cameras/cam0/viewers/abc123", {
        want: "video",
        // A browser insisting its reading is from the future, or from 1970.
        stats: { rtt: 42, loss: 0, egress: 900, capacity: 40_000, at: 9_999_999_999 },
      });
      expect(r.viewers.state("cam0", "abc123").mine.statsAt).toBe(r.at());

      // And once it has gone stale in this daemon's clock, nothing acts on it.
      r.advance(7_000);
      r.adaptation.tick();
      expect(r.sent).toEqual([]);
    } finally {
      r.done();
    }
  });

  it("holds a full rate the operator is holding, and ends it when they let go", async () => {
    const r = routed();
    try {
      r.start();
      await r.route("POST", "/cameras/cam0/viewers/abc123", { want: "video" });
      await r.route("POST", "/cameras/cam0/viewers/abc123", { fullRate: true });
      expect(r.viewers.state("cam0", "abc123").mine).toMatchObject({ fullRate: true, source: "cam0" });
      const answer = await r.route("POST", "/cameras/cam0/viewers/abc123", { fullRate: false });
      expect(answer.body).toMatchObject({ mine: { fullRate: false, source: "cam0-preview" } });
    } finally {
      r.done();
    }
  });

  it("ends one page's subscription without touching a configured output", async () => {
    const r = routed();
    try {
      r.applied.cameras = [{
        ...CAMERA, outputs: [{ kind: "rtp", enabled: true, host: "10.0.0.2", port: 5600 }],
      } as unknown as Camera];
      r.start();
      await r.route("POST", "/cameras/cam0/viewers/abc123", { want: "video" });
      const answer = await r.route("DELETE", "/cameras/cam0/viewers/abc123", undefined);
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ mine: { delivery: "off" } });
      expect(r.applied.cameras[0].outputs[0].enabled).toBe(true);
      // The output is still leaving the aircraft, and still charged for.
      expect(r.viewers.state("cam0", "abc123").cost.path).toBe(atIp(2000));
    } finally {
      r.done();
    }
  });

  it("refuses a statistic that is not one, rather than quietly dropping it", async () => {
    const r = routed();
    try {
      r.start();
      for (const stats of [
        { rtt: 42, loss: 4, egress: 900, capacity: 40_000 },
        { rtt: -1, loss: 0, egress: 900, capacity: 40_000 },
        { rtt: 42, loss: 0, egress: 900 },
        "a statistic",
      ]) {
        const answer = await r.route("POST", "/cameras/cam0/viewers/abc123", { stats });
        expect(answer.status).toBe(400);
      }
      expect(r.viewers.state("cam0", "abc123").mine.statsAt).toBeNull();
    } finally {
      r.done();
    }
  });

  it("refuses a viewer id that could address another route", async () => {
    const r = routed();
    try {
      const answer = await r.route("POST", "/cameras/cam0/viewers/..%2Frun", { want: "video" });
      expect(answer.status).toBe(404);
    } finally {
      r.done();
    }
  });

  it("refuses a want that is not one of the three", async () => {
    const r = routed();
    try {
      const answer = await r.route("POST", "/cameras/cam0/viewers/abc123", { want: "everything" });
      expect(answer.status).toBe(400);
    } finally {
      r.done();
    }
  });

  it("says so, rather than pretending nobody is watching, with no video layer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-viewers-"));
    try {
      const configPath = join(dir, "config.yaml");
      saveConfig(configPath, { ...DEFAULT_CONFIG, cameras: [CAMERA] } as never);
      const engine = new ApplyEngine({
        configPath, journalPath: join(dir, "apply.json"), renderers: [noop],
      });
      const route = createRouter({ engine, configPath, credential: provisioned(dir) });
      const answer = await route("POST", "/cameras/cam0/viewers/abc123", { want: "video" });
      expect(answer.status).toBe(503);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
