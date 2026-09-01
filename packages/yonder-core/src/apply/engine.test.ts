// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

  it("keeps the rollback record on disk only while the change is unconfirmed", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    const { id } = await e.apply(changed());

    // While pending, the journal names the apply and the configuration to go
    // back to — not the one being applied.
    const entry = JSON.parse(readFileSync(journalPath, "utf8")) as {
      id: string;
      previous: Config;
    };
    expect(entry.id).toBe(id);
    expect(entry.previous.system.hostname).toBe("yonder");

    e.confirm(id);
    expect(existsSync(journalPath)).toBe(false);
  });

  it("leaves a confirmed change in place when the daemon restarts", async () => {
    const { clock } = fakeClock();
    const first = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    const { id } = await first.apply(changed());
    first.confirm(id);

    // Crash and restart. A journal left behind by confirm() would make the
    // next start undo a change the operator explicitly kept — the exact
    // inverse of the safety property.
    const r = renderer();
    const second = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });
    await second.recover();
    expect(loadConfig(configPath).system.hostname).toBe("changed");
    expect(r.calls).toHaveLength(0);
  });

  it("leaves no journal behind when a renderer fails, so a restart does not re-revert", async () => {
    const { clock } = fakeClock();
    const bad: Renderer = { name: "bad", async render() { throw new Error("nope"); } };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [bad], clock });
    await expect(e.apply(changed())).rejects.toThrow(/nope/);
    expect(existsSync(journalPath)).toBe(false);

    const r = renderer();
    const second = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });
    await second.recover();
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(r.calls).toHaveLength(0);
  });

  it("refuses a second apply while the first is still rendering", async () => {
    const { clock } = fakeClock();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: Renderer = { name: "slow", async render() { await gate; } };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [slow], clock });

    const first = e.apply(changed());
    // The renderer has not returned, so the reservation must already be held:
    // M1's network renderer takes seconds, and a second apply accepted here
    // would journal the first apply's unconfirmed configuration as its
    // rollback target and orphan its countdown.
    expect(e.status().state).toBe("applying");

    const other = structuredClone(DEFAULT_CONFIG);
    other.system.hostname = "second";
    await expect(e.apply(other)).rejects.toThrow(/already pending/);

    release();
    await first;
    expect(loadConfig(configPath).system.hostname).toBe("changed");
    const entry = JSON.parse(readFileSync(journalPath, "utf8")) as { previous: Config };
    expect(entry.previous.system.hostname).toBe("yonder");
  });

  it("reports how the last apply ended, so a rollback is not mistaken for nothing happening", async () => {
    const { clock, advance } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock, timeoutMs: 120_000 });
    expect(e.status().lastResult).toBeUndefined();

    const { id } = await e.apply(changed());
    advance(121_000);
    expect(e.status().state).toBe("idle");
    expect(e.status().lastResult).toEqual({ id, outcome: "reverted", at: 121_000 });

    const second = await e.apply(changed());
    e.confirm(second.id);
    expect(e.status().lastResult).toEqual({ id: second.id, outcome: "confirmed", at: 121_000 });
  });

  it("reports a failed apply as failed", async () => {
    const { clock } = fakeClock();
    const bad: Renderer = { name: "bad", async render() { throw new Error("nope"); } };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [bad], clock });
    await expect(e.apply(changed())).rejects.toThrow(/nope/);
    expect(e.status().lastResult?.outcome).toBe("failed");
  });

  it("reports a rollback performed at start-up", async () => {
    const { clock } = fakeClock();
    const first = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    const { id } = await first.apply(changed());

    const second = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await second.recover();
    expect(second.status().lastResult).toEqual({ id, outcome: "reverted", at: 0 });
  });
});

/**
 * A journal that parses but does not hold a usable configuration is the
 * dangerous case: handing it to saveConfig writes garbage over the only good
 * copy on the device, and throwing out of recover() stops the daemon starting
 * at all. Neither is acceptable, so an unusable journal is treated as none.
 */
describe("ApplyEngine.recover with a damaged journal", () => {
  let stderr: string;

  beforeEach(() => {
    stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  async function recoverFrom(contents: string): Promise<ApplyEngine> {
    writeFileSync(journalPath, contents);
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await e.recover();
    return e;
  }

  it("discards a journal that is not valid JSON", async () => {
    const e = await recoverFrom("{ truncated by a power cut");
    expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
    expect(existsSync(journalPath)).toBe(false);
    expect(e.status().state).toBe("idle");
    expect(stderr).toMatch(/discarding the apply journal/);
  });

  it("never writes a rollback target that is not a configuration", async () => {
    await recoverFrom(JSON.stringify({ id: "x", previous: { nonsense: true }, startedAt: 0 }));
    expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
    expect(existsSync(journalPath)).toBe(false);
    expect(stderr).toMatch(/discarding the apply journal/);
  });

  it("starts cleanly when the journal has no rollback target at all", async () => {
    const e = await recoverFrom(JSON.stringify({ id: "x", startedAt: 0 }));
    expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
    expect(existsSync(journalPath)).toBe(false);
    expect(e.status().state).toBe("idle");
  });
});
