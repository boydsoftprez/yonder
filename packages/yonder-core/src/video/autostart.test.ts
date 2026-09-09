// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRenderers } from "../daemon/server.js";
import { DEFAULT_CONFIG, ConfigSchema, type Config } from "../schema/config.js";
import { noCapabilities, present } from "./capability.js";
import type { DetectResult } from "./probe/camera.js";
import type { SpawnedProcess } from "./supervisor.js";

let dir: string;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "yonder-boot-video-")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function config(): Config {
  return ConfigSchema.parse({ ...structuredClone(DEFAULT_CONFIG), cameras: [{
    id: "cam1", name: "Nose", source: "usb", device: "stable-usb-socket",
    enabled: true, autostart: true, width: 1280, height: 720, framerate: 30,
    codec: "h264", bitrate_kbps: 2100,
    outputs: [{ kind: "rtsp", enabled: true, password: { secret: "rtsp_password" } }],
  }] });
}
const detected: DetectResult = { found: [{
  device: "/dev/video2", card: "Nose", byPath: "stable-usb-socket", byPathStable: true,
  capabilities: { ...noCapabilities(), formats: present([
    { fourcc: "MJPG", width: 1280, height: 720, rates: [30] },
  ]) },
}], rejected: [] };

function harness() {
  let detect: () => Promise<DetectResult> = async () => detected;
  let encoderReady = true;
  const spawned: { argv: string[]; exit: () => void; killed: boolean }[] = [];
  const built = buildRenderers({
    secretsPath: join(dir, "secrets.yaml"), remoteStatePath: join(dir, "remote.json"),
    runner: async () => { throw new Error("unexpected real probe"); }, log: () => {},
    cameraLayer: {
      cameras: { detect: () => detect(), probe: async () => detected.found[0]! },
      encoder: async () => {
        if (!encoderReady) throw new Error("encoder not ready");
        return { element: "v4l2h264enc", device: "/dev/video11", hardware: true,
          codec: "h264", detail: "hardware H.264" };
      },
      rtspPassword: () => null,
    },
    spawner: (argv) => {
      let ended: (arg: unknown) => void = () => {};
      const record = { argv, exit: () => ended(1), killed: false };
      spawned.push(record);
      return { kill: () => { record.killed = true; },
        on: (event, fn) => { if (event === "exit") ended = fn; },
      } satisfies SpawnedProcess;
    },
  });
  return { built, spawned, render: (c: Config) => built.renderers.at(-1)!.render(c),
    setDetect: (read: () => Promise<DetectResult>) => { detect = read; },
    encoderReady: (ready: boolean) => { encoderReady = ready; },
  };
}

describe("camera boot startup through the daemon wiring", () => {
  it("starts the saved camera once, using its stable identity and RTSP path", async () => {
    const h = harness();
    await h.render(config());
    await vi.advanceTimersByTimeAsync(2100);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.argv).toContain("device=/dev/v4l/by-path/stable-usb-socket");
    expect(h.spawned[0]!.argv.join(" ")).toContain("/cam1");
    expect(h.spawned[0]!.argv.join(" ")).toContain("video_bitrate=2100000");
    expect(h.built.supervisor.state("cam1").state).toBe("running");
    await h.render(config());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(1);
  });

  it("waits for late USB enumeration and a late encoder without giving up", async () => {
    const h = harness();
    h.setDetect(async () => ({ found: [], rejected: [] }));
    await h.render(config());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.spawned).toHaveLength(0);
    h.setDetect(async () => detected);
    h.encoderReady(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(0);
    h.encoderReady(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(1);
  });

  it.each(["disabled", "manual", "removed"])("does not start a %s camera", async (mode) => {
    const h = harness();
    const c = config();
    if (mode === "disabled") c.cameras[0]!.enabled = false;
    if (mode === "manual") c.cameras[0]!.autostart = false;
    if (mode === "removed") c.cameras = [];
    await h.render(c);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(0);
  });

  it("uses the latest saved settings when a delayed camera appears", async () => {
    const h = harness();
    h.setDetect(async () => ({ found: [], rejected: [] }));
    await h.render(config());
    await vi.advanceTimersByTimeAsync(1);
    const changed = config();
    changed.cameras[0]!.bitrate_kbps = 1100;
    await h.render(changed);
    h.setDetect(async () => detected);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]!.argv.join(" ")).toContain("video_bitrate=1100000");
  });

  it("cancels a delayed startup when config disables it", async () => {
    const h = harness();
    h.setDetect(async () => ({ found: [], rejected: [] }));
    await h.render(config());
    await vi.advanceTimersByTimeAsync(1);
    const changed = config(); changed.cameras[0]!.autostart = false;
    await h.render(changed);
    h.setDetect(async () => detected);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(0);
  });

  it("honors Stop while a hardware probe is in flight", async () => {
    const h = harness();
    let release!: (result: DetectResult) => void;
    h.setDetect(() => new Promise((resolve) => { release = resolve; }));
    await h.render(config());
    await vi.advanceTimersByTimeAsync(1);
    h.built.supervisor.stop("cam1");
    release(detected);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(0);
  });

  it("restores a waiting camera when a configuration change rolls back", async () => {
    const h = harness();
    h.setDetect(async () => ({ found: [], rejected: [] }));
    await h.render(config());
    await vi.advanceTimersByTimeAsync(1);
    const changed = config(); changed.cameras[0]!.autostart = false;
    await h.render(changed);
    await h.render(config());
    h.setDetect(async () => detected);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(1);
  });

  it("restores a running camera stopped by a configuration that rolls back", async () => {
    const h = harness();
    await h.render(config());
    await vi.advanceTimersByTimeAsync(2100);
    const changed = config(); changed.cameras[0]!.enabled = false;
    await h.render(changed);
    expect(h.built.supervisor.state("cam1").state).toBe("stopped");
    await h.render(config());
    await vi.advanceTimersByTimeAsync(2100);
    expect(h.spawned).toHaveLength(2);
    expect(h.built.supervisor.state("cam1").state).toBe("running");
  });

  it("honors a later operator Stop when a disabled configuration rolls back", async () => {
    const h = harness();
    await h.render(config());
    await vi.advanceTimersByTimeAsync(2100);
    const changed = config(); changed.cameras[0]!.enabled = false;
    await h.render(changed);
    h.built.supervisor.stop("cam1");
    await h.render(config());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(1);
    expect(h.built.supervisor.state("cam1").state).toBe("stopped");
  });

  it("cannot launch after shutdown while a probe is in flight", async () => {
    const h = harness();
    let release!: (result: DetectResult) => void;
    h.setDetect(() => new Promise((resolve) => { release = resolve; }));
    await h.render(config());
    await vi.advanceTimersByTimeAsync(1);
    h.built.cameraAutostart.close();
    release(detected);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(0);
  });

  it("does not resurrect an operator-stopped camera on a later apply", async () => {
    const h = harness();
    await h.render(config());
    await vi.advanceTimersByTimeAsync(2100);
    h.built.supervisor.stop("cam1");
    await h.render(config());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spawned).toHaveLength(1);
    expect(h.built.supervisor.state("cam1").state).toBe("stopped");
  });
});
