// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, DEFAULT_CONFIG } from "../schema/config.js";
import { saveConfig } from "../config/save.js";
import { loadConfig } from "../config/load.js";
import { ApplyEngine } from "../apply/engine.js";
import { Supervisor, type SpawnedProcess } from "./supervisor.js";
import { EncoderChannel } from "./encoder.js";
import { PipelineRenderer } from "./renderer.js";
import { RTSP_BASE } from "../media/ports.js";
import { compose, encodesIn } from "./pipeline.js";
import { noCapabilities } from "./capability.js";
import { createRouter } from "../daemon/routes.js";
import { AdminCredential } from "../console/credential.js";
import { SecretStore } from "../secrets/store.js";

let dir: string;
beforeEach(() => { vi.useFakeTimers(); dir = mkdtempSync(join(tmpdir(), "yonder-live-apply-")); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
const encoder = { element: "mpph264enc", h265: "mpph265enc", decoder: "mppjpegdec", hardware: true, device: "/dev/mpp_service", detail: "MPP" } as const;
function harness(codec: "h264" | "h265", mode: "live" | "absent" | "silence" | "wrong" | "gap" | "held" = "live") {
  const config = ConfigSchema.parse({ ...structuredClone(DEFAULT_CONFIG), cameras: [{
    id: "cam0", name: "Camera", source: "usb", device: "usb-video-index0", enabled: true,
    width: 1280, height: 720, framerate: 30, codec, bitrate_kbps: 2000,
    stream: { mode: "fixed", floor_kbps: 2000, ceiling_kbps: 2000 },
    preview: { mode: "fixed", size: "640x360", bitrate_kbps: 400 },
  }] });
  const spawns: { argv: string[]; rates: { stream: number | null; preview: number | null }; killed: boolean; exit(): void }[] = [];
  let spawnFailure = false;
  let reply: () => void = () => {};
  const supervisor = new Supervisor({ spawner: (argv) => {
    if (spawnFailure) throw new Error("runner unavailable");
    const listeners: ((line: string) => void)[] = [];
    let ended: (code: unknown) => void = () => {};
    const record = { argv: [...argv], rates: { ...encodesIn(argv) }, killed: false, exit: () => ended(1) };
    spawns.push(record);
    const pid = spawns.length;
    const proc: SpawnedProcess = {
      kill() { record.killed = true; },
      on(event, fn) { if (event === "exit") ended = fn; },
      onMessage(fn) { listeners.push(fn); },
    };
    if (mode !== "absent") proc.send = (line) => {
      const command = JSON.parse(line);
      const set = command.sets[0];
      const branch = set.element === "enc-stream" ? "stream" : "preview";
      if (mode === "silence") return;
      reply = () => {
        if (mode !== "wrong") record.rates[branch] = Number(set.value) / 1000;
        for (const fn of listeners) fn(JSON.stringify({ id: command.id, pid, observed: record.rates[branch], continuous: mode !== "gap" }));
      };
      if (mode !== "held") reply();
    };
    return proc;
  } });
  const channel = new EncoderChannel({ supervisor });
  const renderer = new PipelineRenderer({ supervisor, encoder: async () => encoder, channel });
  const configPath = join(dir, "config.yaml");
  saveConfig(configPath, config);
  let rejectApply = false;
  const engine = new ApplyEngine({ configPath, journalPath: join(dir, "journal.json"), renderers: [renderer, {
    name: "downstream", async render(config) {
      if (rejectApply && config.cameras[0].bitrate_kbps === 3500) throw new Error("apply failed after retune");
    },
  }] });
  const credential = new AdminCredential(new SecretStore(join(dir, "secrets.yaml")));
  credential.set("a sufficiently long password");
  const router = createRouter({ engine, configPath, credential, supervisor, pipelineRenderer: renderer,
    encoder: async () => encoder,
    cameras: { detect: async () => ({ found: [], rejected: [] }), probe: async () => { throw new Error("not probed"); } },
  });
  supervisor.start("cam0", compose({ camera: config.cameras[0], capabilities: noCapabilities(), encoder, rtspBase: RTSP_BASE }));
  const next = structuredClone(config);
  next.cameras[0].bitrate_kbps = 3500;
  next.cameras[0].stream.floor_kbps = 3500;
  next.cameras[0].stream.ceiling_kbps = 3500;
  return { config, next, engine, supervisor, channel, renderer, spawns, router, configPath, rejectApply: () => { rejectApply = true; }, reply: () => reply(), failSpawn: () => { spawnFailure = true; } };
}

describe("manual MPP apply through the real engine, channel and supervisor", () => {
  it.each(["h264", "h265"] as const)("retunes %s continuously, rolls back, confirms, and keeps the recipe on crash restart", async (codec) => {
    const h = harness(codec);
    await vi.advanceTimersByTimeAsync(2000);
    const since = h.supervisor.state("cam0").since;
    const result = await h.engine.apply(h.next);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].rates.stream).toBe(3500);
    expect(h.channel.inForce("cam0")?.stream).toBe(3500);
    expect(h.supervisor.state("cam0").since).toBe(since);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    await h.engine.revertNow(result.id);
    expect(h.spawns[0].rates.stream).toBe(2000);
    expect(h.spawns).toHaveLength(1);
    const kept = await h.engine.apply(h.next);
    await h.engine.confirm(kept.id);
    const renamed = structuredClone(h.next);
    renamed.cameras[0].name = "Renamed";
    await h.engine.apply(renamed);
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].rates.stream).toBe(3500);
    h.spawns[0].exit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1].rates.stream).toBe(3500);
    expect(h.channel.inForce("cam0")?.stream).toBe(3500);
  });

  it("compares a manual target with the same channel's observed adaptive rate", async () => {
    const h = harness("h264");
    await vi.advanceTimersByTimeAsync(2000);
    await h.channel.retune(h.config.cameras[0], "stream", 2700);
    expect(h.spawns[0].rates.stream).toBe(2700);
    const applied = await h.engine.apply(h.next);
    expect(h.spawns[0].rates.stream).toBe(3500);
    await h.engine.revertNow(applied.id);
    expect(h.spawns[0].rates.stream).toBe(2000);
    expect(h.spawns).toHaveLength(1);
  });

  it.each(["absent", "silence", "wrong"] as const)("falls back with truthful interruption when the host is %s", async (mode) => {
    const h = harness("h264", mode);
    await vi.advanceTimersByTimeAsync(2000);
    const applying = h.router("POST", "/cameras/cam0/apply", { streamBitrate: 3500 });
    await vi.advanceTimersByTimeAsync(2100);
    const response = await applying;
    expect(response.status).toBe(200);
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1].rates.stream).toBe(3500);
    expect(response.body).toMatchObject({ interruption: ["restarts the picture"], video: { outcome: "restarted" } });
  });

  it("reports host-witnessed interruption without restarting an accepted retune", async () => {
    const h = harness("h265", "gap");
    await vi.advanceTimersByTimeAsync(2000);
    const response = await h.router("POST", "/cameras/cam0/apply", { streamBitrate: 3500 });
    expect(h.spawns).toHaveLength(1);
    expect(response.body).toMatchObject({ interruption: ["the encoder reported a break in the picture"], video: { outcome: "retuned", continuous: false } });
  });

  it("reports fallback spawn failure without claiming the bitrate reached a running pipeline", async () => {
    const h = harness("h264", "absent");
    await vi.advanceTimersByTimeAsync(2000);
    h.failSpawn();
    const response = await h.router("POST", "/cameras/cam0/apply", { streamBitrate: 3500 });
    expect(response.body).toMatchObject({ video: { outcome: "failed" } });
    expect((response.body as { interruption: string[] }).interruption.join(" ")).toContain("could not");
    expect(h.supervisor.argv("cam0")).toBeNull();
  });

  it("lets the real confirmation timer restore the running rate", async () => {
    const h = harness("h265");
    await vi.advanceTimersByTimeAsync(2000);
    const pending = await h.engine.apply(h.next);
    await vi.advanceTimersByTimeAsync(pending.expiresAt! - Date.now());
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].rates.stream).toBe(2000);
    expect(loadConfig(h.configPath).cameras[0].stream.ceiling_kbps).toBe(2000);
  });

  it("restores the actual rate when a later renderer rejects the apply", async () => {
    const h = harness("h264");
    h.rejectApply();
    await expect(h.engine.apply(h.next)).rejects.toThrow("apply failed after retune");
    expect(h.spawns[0].rates.stream).toBe(2000);
    expect(h.channel.inForce("cam0")?.stream).toBe(2000);
    expect(h.spawns).toHaveLength(1);
  });

  it("rolls back a fallback restart to the old running recipe", async () => {
    const h = harness("h264", "absent");
    const pending = await h.engine.apply(h.next);
    expect(h.spawns[1].rates.stream).toBe(3500);
    await h.engine.revertNow(pending.id);
    expect(h.spawns[2].rates.stream).toBe(2000);
  });

  it("restores the fixed target even when the launch recipe already names it", async () => {
    const h = harness("h264");
    await h.channel.retune(h.config.cameras[0], "stream", 2700);
    await h.engine.apply(h.config);
    expect(h.spawns[0].rates.stream).toBe(2000);
    expect(h.spawns).toHaveLength(1);
  });

  it("preserves the live rate when the starting process settles", async () => {
    const h = harness("h264");
    await h.engine.apply(h.next);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.channel.inForce("cam0")?.stream).toBe(3500);
    expect(h.spawns).toHaveLength(1);
  });

  it("applies both rates and restores both through rollback", async () => {
    const h = harness("h264");
    h.next.cameras[0].preview.bitrate_kbps = 800;
    const pending = await h.engine.apply(h.next);
    expect(h.spawns[0].rates).toMatchObject({ stream: 3500, preview: 800 });
    await h.engine.revertNow(pending.id);
    expect(h.spawns[0].rates).toMatchObject({ stream: 2000, preview: 400 });
    expect(h.spawns).toHaveLength(1);
  });

  it("does not resurrect a camera stopped during a live request", async () => {
    const h = harness("h264", "held");
    const applying = h.engine.apply(h.next);
    await vi.advanceTimersByTimeAsync(1);
    h.supervisor.stop("cam0");
    h.reply();
    await vi.advanceTimersByTimeAsync(2100);
    await applying;
    expect(h.spawns).toHaveLength(1);
    expect(h.supervisor.state("cam0").state).toBe("stopped");
    expect(h.renderer.report("cam0")?.outcome).toBe("failed");
  });

  it("does not reset an unchanged adaptive policy on an unrelated apply", async () => {
    const h = harness("h264");
    const adaptive = structuredClone(h.config);
    adaptive.cameras[0].stream.mode = "adaptive";
    const pending = await h.engine.apply(adaptive);
    await h.engine.confirm(pending.id);
    await h.channel.retune(adaptive.cameras[0], "stream", 1500);
    adaptive.cameras[0].name = "Renamed";
    await h.engine.apply(adaptive);
    expect(h.spawns[0].rates.stream).toBe(1500);
    expect(h.spawns).toHaveLength(1);
  });

  it("still restarts for a codec or source-size change", async () => {
    const h = harness("h264");
    await vi.advanceTimersByTimeAsync(2000);
    h.next.cameras[0].codec = "h265";
    h.next.cameras[0].width = 640;
    h.next.cameras[0].height = 480;
    await h.engine.apply(h.next);
    expect(h.spawns).toHaveLength(2);
    expect(h.spawns[1].argv).toContain("mpph265enc");
  });
});
