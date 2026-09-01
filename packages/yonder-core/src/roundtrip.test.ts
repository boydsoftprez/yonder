// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyEngine } from "./apply/engine.js";
import { loadConfig } from "./config/load.js";
import { saveConfig } from "./config/save.js";
import { SecretStore } from "./secrets/store.js";
import { DEFAULT_CONFIG } from "./schema/config.js";
import type { Clock, Renderer } from "./apply/types.js";
import type { Config } from "./schema/config.js";

let dir: string, configPath: string, journalPath: string;

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-e2e-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("M0 exit criterion", () => {
  it("validates, applies and reverts a configuration", async () => {
    // A device is provisioned: secrets are generated, config is written.
    const secrets = new SecretStore(join(dir, "secrets.yaml"));
    const psk = secrets.ensure("ap_psk", "psk");
    const editor = secrets.ensure("editor_password", "password");
    expect(psk.created).toBe(true);
    expect(editor.created).toBe(true);
    expect(psk.value).not.toBe(editor.value);

    saveConfig(configPath, DEFAULT_CONFIG);
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder");

    const applied: string[] = [];
    const renderer: Renderer = {
      name: "recorder",
      async render(c) { applied.push(c.network.ap.ssid); },
    };
    const { clock, advance } = fakeClock();
    const engine = new ApplyEngine({
      configPath, journalPath, renderers: [renderer], clock, timeoutMs: 120_000,
    });

    // An invalid change is refused and changes nothing.
    await expect(engine.apply({ version: 1, nonsense: true })).rejects.toThrow();
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder");

    // A valid change is applied and rendered.
    const next: Config = structuredClone(DEFAULT_CONFIG);
    next.network.ap.ssid = "yonder-field";
    const { id } = await engine.apply(next);
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder-field");
    expect(applied).toEqual(["yonder-field"]);

    // Nobody confirms. The window closes. Everything goes back.
    advance(121_000);
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder");
    expect(applied).toEqual(["yonder-field", "yonder"]);
    expect(engine.status().state).toBe("idle");

    // The same change, confirmed this time, stays.
    const second = await engine.apply(next);
    engine.confirm(second.id);
    advance(500_000);
    expect(loadConfig(configPath).network.ap.ssid).toBe("yonder-field");
    expect(id).not.toBe(second.id);
  });
});
