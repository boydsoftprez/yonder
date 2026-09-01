// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyEngine } from "./engine.js";
import type { Renderer, Clock } from "./types.js";
import { saveConfig } from "../config/save.js";
import { loadConfig } from "../config/load.js";
import { DEFAULT_CONFIG } from "../schema/config.js";
import type { Config } from "../schema/config.js";

let dir: string, configPath: string, journalPath: string;

/** A clock the test drives by hand, so no test ever waits on real time. */
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

function renderer(name = "test"): Renderer & { calls: Config[] } {
  const calls: Config[] = [];
  return { name, calls, async render(c) { calls.push(structuredClone(c)); } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yonder-apply-"));
  configPath = join(dir, "config.yaml");
  journalPath = join(dir, "apply.json");
  saveConfig(configPath, DEFAULT_CONFIG);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function changed(): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.system.hostname = "changed";
  return c;
}

describe("ApplyEngine", () => {
  it("starts idle", () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    expect(e.status().state).toBe("idle");
  });

  it("rejects a config that fails validation, leaving the old one in place", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await expect(e.apply({ version: 1 } as unknown as Config)).rejects.toThrow();
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("writes the new config and enters pending", async () => {
    const { clock } = fakeClock();
    const r = renderer();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });
    const { id } = await e.apply(changed());
    expect(id).toBeTruthy();
    expect(e.status().state).toBe("pending");
    expect(loadConfig(configPath).system.hostname).toBe("changed");
    expect(r.calls).toHaveLength(1);
  });

  it("stays applied once confirmed, even after the timeout passes", async () => {
    const { clock, advance } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    const { id } = await e.apply(changed());
    e.confirm(id);
    expect(e.status().state).toBe("confirmed");
    advance(200_000);
    expect(loadConfig(configPath).system.hostname).toBe("changed");
  });

  it("reverts when the confirmation window expires", async () => {
    const { clock, advance } = fakeClock();
    const r = renderer();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [r], clock, timeoutMs: 120_000 });
    await e.apply(changed());
    advance(119_000);
    expect(loadConfig(configPath).system.hostname).toBe("changed");
    advance(2_000);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1].system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("ignores confirmation of an id it does not recognise", async () => {
    const { clock, advance } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await e.apply(changed());
    expect(() => e.confirm("not-the-id")).toThrow(/unknown apply/);
    advance(200_000);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
  });

  it("refuses a second apply while one is pending", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await e.apply(changed());
    await expect(e.apply(changed())).rejects.toThrow(/already pending/);
  });

  it("reverts when a renderer throws, and reports the failure", async () => {
    const { clock } = fakeClock();
    const bad: Renderer = { name: "bad", async render() { throw new Error("nope"); } };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [bad], clock });
    await expect(e.apply(changed())).rejects.toThrow(/nope/);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("reverts an apply left pending by a crash, on recover()", async () => {
    const { clock, advance } = fakeClock();
    const first = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await first.apply(changed());
    // Simulate a crash: a fresh engine over the same journal, nothing in memory.
    const r = renderer();
    const second = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });
    await second.recover();
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(second.status().state).toBe("idle");
    advance(200_000);
  });

  it("does nothing on recover() when no apply was in flight", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await e.recover();
    expect(e.status().state).toBe("idle");
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
  });
});
