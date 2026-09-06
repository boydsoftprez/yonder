// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PipelineRenderer } from "./renderer.js";
import { compose } from "./pipeline.js";
import { Supervisor, type ProcessSpawner, type SpawnedProcess } from "./supervisor.js";
import { noCapabilities } from "./capability.js";
import type { Encoder } from "./probe/encoder.js";
import { RTSP_BASE } from "../media/ports.js";
import { ApplyEngine } from "../apply/engine.js";
import { saveConfig } from "../config/save.js";
import { DEFAULT_CONFIG, type Camera, type Config } from "../schema/config.js";
import type { Clock } from "../apply/types.js";

/**
 * The board's encoder, as `probe/encoder.ts` reports this one.
 *
 * Hardware, because that is what K-48 was measured on: `extra-controls=
 * controls,video_bitrate=100000` in the running launch line while
 * `config.yaml` said 2000.
 */
const HW: Encoder = {
  element: "v4l2h264enc", device: "/dev/video11", hardware: true,
  codec: "h264", detail: "hardware H.264 on /dev/video11",
};

function camera(id: string, over: Partial<Camera> = {}): Camera {
  return {
    id, name: `camera ${id}`, source: "usb",
    device: `platform-fd500000.pcie-pci-0000:01:00.0-usb-0:1.3:1.0-video-index0-${id}`,
    enabled: true, autostart: false,
    width: 1280, height: 720, framerate: 30, codec: "h264", bitrate_kbps: 2000,
    preview: {
      mode: "fixed", size: "auto", ladder_top: "1280x720", ladder_bottom: "640x360",
      floor_kbps: 300, ceiling_kbps: 2000, bitrate_kbps: 400, framerate: 15,
    },
    controls: { brightness: null, contrast: null, rotation: 0 },
    outputs: [{ kind: "rtsp", enabled: true, password: { secret: "rtsp_password" } }],
    stream: { mode: "fixed", floor_kbps: 2000, ceiling_kbps: 2000 },
    ...over,
  };
}

function configWith(...cameras: Camera[]): Config {
  return { ...structuredClone(DEFAULT_CONFIG), cameras };
}

/** The line the start route would compose for this camera. */
function lineFor(cam: Camera): string[] {
  return compose({ camera: cam, capabilities: noCapabilities(), encoder: HW, rtspBase: RTSP_BASE });
}

interface Spawn {
  /** Stands for the pid: a new number is a new process, which is the whole
   *  question a restart test is asking. */
  readonly pid: number;
  readonly argv: readonly string[];
  killed: boolean;
}

/**
 * `gst-launch-1.0`'s shape: a process that carries a pipeline and answers
 * nothing (K-53). No `send`, no `onMessage` — the same spawner the daemon
 * really has, so nothing here can pass by talking to an encoder that does not
 * listen.
 */
function fakeSpawner() {
  const spawns: Spawn[] = [];
  let pid = 1000;
  let refusing = false;
  const spawner: ProcessSpawner = (argv) => {
    if (refusing) throw new Error("no pipeline runner on this board");
    const handlers: ((a: unknown) => void)[] = [];
    const record: Spawn = { pid: ++pid, argv: [...argv], killed: false };
    spawns.push(record);
    const proc: SpawnedProcess = {
      kill: () => { record.killed = true; },
      on: (event, fn) => { if (event === "exit") handlers.push(fn); },
    };
    return proc;
  };
  /** Every process ever started for this camera, oldest first. Keyed on the
   *  preview path, which `compose()` builds from the camera's id alone. */
  const forCamera = (id: string): Spawn[] =>
    spawns.filter((s) => s.argv.join(" ").includes(`/${id}-preview`));
  /** From here on nothing will start — a board whose pipeline runner has gone
   *  missing, met by a camera that is already running. */
  const refuseFromNowOn = (): void => { refusing = true; };
  return { spawner, spawns, forCamera, refuseFromNowOn };
}

function fakeClock() {
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => t,
    setTimer: (ms, fn) => { const h = next++; timers.set(h, { at: t + ms, fn }); return h; },
    clearTimer: (h) => { timers.delete(h as number); },
  };
  return {
    clock,
    advance(ms: number) {
      t += ms;
      for (const [h, timer] of [...timers]) {
        if (timer.at <= t) { timers.delete(h); timer.fn(); }
      }
    },
  };
}

/** A renderer, its supervisor, and the spawner underneath both. */
function harness(opts: { encoder?: () => Promise<Encoder> } = {}) {
  const { spawner, forCamera, refuseFromNowOn } = fakeSpawner();
  const { clock } = fakeClock();
  const supervisor = new Supervisor({ spawner, clock });
  const log: string[] = [];
  const renderer = new PipelineRenderer({
    supervisor,
    encoder: opts.encoder ?? (async () => HW),
    log: (line) => log.push(line),
  });
  return { supervisor, renderer, forCamera, log, refuseFromNowOn };
}

describe("PipelineRenderer", () => {
  /**
   * K-48, in one test.
   *
   * The operator changes a bitrate, applies it and confirms it. Before this
   * renderer existed `config.yaml` took the new value, the console said
   * `confirmed`, and the encoder went on running the old one — same pid,
   * twenty seconds later, no restart logged.
   */
  it("restarts a camera whose bitrate changed, on the new launch line", async () => {
    const { supervisor, renderer, forCamera } = harness();
    const before = camera("cam0");
    supervisor.start("cam0", lineFor(before));

    const after = camera("cam0", { bitrate_kbps: 1000 });
    await renderer.render(configWith(after));

    const runs = forCamera("cam0");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.pid).not.toBe(runs[0]!.pid);
    expect(runs[0]!.killed).toBe(true);
    // The rate the encoder is now being told, read off the line it is running
    // rather than off the configuration — which is the whole of K-48.
    expect(runs[0]!.argv.join(" ")).toContain("video_bitrate=2000000");
    expect(supervisor.argv("cam0")?.join(" ")).toContain("video_bitrate=1000000");
    expect(supervisor.argv("cam0")).toEqual(lineFor(after));
  });

  /**
   * The other camera's pid is the assertion. A renderer that restarted
   * everything on every apply would pass every test above and would drop a
   * second aircraft camera's picture for a change that never named it.
   */
  it("restarts the camera the change names, and no other", async () => {
    const { supervisor, renderer, forCamera } = harness();
    const edited = camera("cam0");
    const untouched = camera("cam1");
    supervisor.start("cam0", lineFor(edited));
    supervisor.start("cam1", lineFor(untouched));

    const pidBefore = forCamera("cam1")[0]!.pid;
    await renderer.render(configWith(camera("cam0", { bitrate_kbps: 1000 }), untouched));

    expect(forCamera("cam0")).toHaveLength(2);
    const after = forCamera("cam1");
    expect(after).toHaveLength(1);
    expect(after[0]!.pid).toBe(pidBefore);
    expect(after[0]!.killed).toBe(false);
    expect(supervisor.argv("cam1")).toEqual(lineFor(untouched));
  });

  /**
   * The composer-agnostic half of the design, and the reason it is a
   * comparison rather than a list of interesting fields. `name` is what an
   * operator types most often and it reaches no launch line, so it must cost
   * nobody a picture.
   */
  it("restarts nothing when the change reaches no launch line", async () => {
    const { supervisor, renderer, forCamera } = harness();
    const before = camera("cam0");
    supervisor.start("cam0", lineFor(before));
    const pid = forCamera("cam0")[0]!.pid;

    await renderer.render(configWith(camera("cam0", { name: "Tail" })));

    expect(forCamera("cam0")).toHaveLength(1);
    expect(forCamera("cam0")[0]!.pid).toBe(pid);
    expect(forCamera("cam0")[0]!.killed).toBe(false);
  });

  /**
   * The line this renderer composes and the line `POST /cameras/:id/run`
   * composes have to be the same line, or every apply would find every
   * running pipeline different from the configuration it already matches and
   * would restart every camera on the aircraft — for a change to the Wi-Fi.
   * The shared `RTSP_BASE` is what keeps them equal; this is the test that
   * notices if a second answer to *where does a pipeline publish* appears.
   */
  it("restarts nothing at all when the configuration has not changed", async () => {
    const { supervisor, renderer, forCamera } = harness();
    const only = camera("cam0");
    supervisor.start("cam0", lineFor(only));

    await renderer.render(configWith(only));
    await renderer.render(configWith(only));

    expect(forCamera("cam0")).toHaveLength(1);
    expect(forCamera("cam0")[0]!.killed).toBe(false);
  });

  /**
   * R-CTL-01. Start and Stop are runtime actions that survive no apply: a
   * configuration change must never put a camera on the air that the operator
   * took off it — including, on a flying aircraft, one they stopped to give
   * the uplink to another.
   */
  it("leaves a camera the operator stopped stopped, whatever the change", async () => {
    const { supervisor, renderer, forCamera } = harness();
    supervisor.start("cam0", lineFor(camera("cam0")));
    supervisor.stop("cam0");
    expect(forCamera("cam0")).toHaveLength(1);

    await renderer.render(configWith(camera("cam0", { bitrate_kbps: 1000 })));

    expect(forCamera("cam0")).toHaveLength(1);
    expect(supervisor.state("cam0").state).toBe("stopped");
    expect(supervisor.argv("cam0")).toBeNull();
  });

  it("starts nothing for a camera that was never started", async () => {
    const { supervisor, renderer, forCamera } = harness();
    await renderer.render(configWith(camera("cam0", { autostart: true })));
    expect(forCamera("cam0")).toHaveLength(0);
    expect(supervisor.state("cam0").state).toBe("stopped");
  });

  /**
   * Rule 6, and K-19's shape. Renderers run in sequence; this one is last so
   * that a camera it cannot restart costs nothing behind it — but it must not
   * fail the apply either, or a board whose encoder has stopped answering
   * (K-51 is that board) could not be given a network change.
   */
  it("does not fail the apply when the spawner refuses, and says which camera", async () => {
    const { supervisor, renderer, log, refuseFromNowOn } = harness();
    supervisor.start("cam0", lineFor(camera("cam0")));
    // Refused only from here, so the camera is genuinely running when the
    // restart is attempted — which is the state this branch exists for.
    refuseFromNowOn();

    await expect(renderer.render(configWith(camera("cam0", { bitrate_kbps: 1000 }))))
      .resolves.toBeUndefined();
    expect(log.join("\n")).toContain("cam0");
    expect(log.join("\n")).toContain("could not be started again");
  });

  it("does not fail the apply when the board's encoder will not answer", async () => {
    const { supervisor, renderer, forCamera, log } = harness({
      encoder: async () => { throw new Error("v4l2-ctl: Connection timed out"); },
    });
    supervisor.start("cam0", lineFor(camera("cam0")));

    await expect(renderer.render(configWith(camera("cam0", { bitrate_kbps: 1000 }))))
      .resolves.toBeUndefined();
    // And the running pipeline is left exactly where it was, rather than
    // being stopped on the strength of a comparison nothing could make.
    expect(forCamera("cam0")).toHaveLength(1);
    expect(forCamera("cam0")[0]!.killed).toBe(false);
    expect(log.join("\n")).toContain("could not be read");
  });

  /**
   * `compose()` throws on an SRT output — the one configuration it refuses to
   * build, because `srtsink` would listen on every interface with no
   * passphrase (R-SEC-13, R-VID-06). That camera keeps its pipeline; every
   * other camera is still considered, and the apply still succeeds.
   */
  it("keeps going past a camera whose configuration cannot be composed", async () => {
    const { supervisor, renderer, forCamera, log } = harness();
    supervisor.start("cam0", lineFor(camera("cam0")));
    supervisor.start("cam1", lineFor(camera("cam1")));

    await expect(renderer.render(configWith(
      camera("cam0", { outputs: [{ kind: "srt", enabled: true, port: 8890 }] }),
      camera("cam1", { bitrate_kbps: 1000 }),
    ))).resolves.toBeUndefined();

    expect(forCamera("cam0")).toHaveLength(1);
    expect(forCamera("cam0")[0]!.killed).toBe(false);
    expect(forCamera("cam1")).toHaveLength(2);
    expect(log.join("\n")).toContain("cam0's configuration could not be composed");
  });

  /** No camera running is no work at all — not even the `v4l2-ctl` sweep the
   *  encoder probe costs. Start-up renders every configuration exactly once,
   *  and at start-up nothing has been started. */
  it("reads no encoder when no pipeline is running", async () => {
    let probes = 0;
    const { renderer } = harness({ encoder: async () => { probes++; return HW; } });
    await renderer.render(configWith(camera("cam0")));
    expect(probes).toBe(0);
  });
});

/**
 * The rollback, driven by the real engine.
 *
 * This is why the fix is a `Renderer` and not a hook on the apply route: it
 * inherits validate → snapshot → apply → confirm-or-revert without a line of
 * new machinery, so a bitrate the operator did not keep takes the pipeline
 * back with it. R-CFG-03, applied to the picture.
 */
describe("a camera whose apply is reverted", () => {
  let dir: string, configPath: string, journalPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yonder-video-render-"));
    configPath = join(dir, "config.yaml");
    journalPath = join(dir, "apply.json");
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("ends up back on the launch line it was running before", async () => {
    const { supervisor, renderer, forCamera } = harness();
    const { clock } = fakeClock();
    const before = camera("cam0");
    saveConfig(configPath, configWith(before));
    supervisor.start("cam0", lineFor(before));

    const engine = new ApplyEngine({
      configPath, journalPath, renderers: [renderer], clock,
    });

    const after = camera("cam0", { bitrate_kbps: 1000 });
    const { id } = await engine.apply(configWith(after));
    // The change is live on the encoder, which is the half K-48 never had.
    expect(supervisor.argv("cam0")).toEqual(lineFor(after));

    await engine.revertNow(id);

    // And the rollback is the half that makes it safe: the aircraft is back
    // on the settings that were working, not left on a rate nobody kept.
    expect(supervisor.argv("cam0")).toEqual(lineFor(before));
    const runs = forCamera("cam0");
    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((r) => r.pid)).size).toBe(3);
    expect(runs[2]!.argv).toEqual(lineFor(before));
  });
});
