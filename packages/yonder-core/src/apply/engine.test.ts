// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplyEngine } from "./engine.js";
import { Journal } from "./journal.js";
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

  it("fails the apply and rolls back when a renderer never settles", async () => {
    const { clock, advance } = fakeClock();
    const hung: Renderer = { name: "hung", render: () => new Promise(() => {}) };
    const e = new ApplyEngine({
      configPath, journalPath, renderers: [hung], clock, renderTimeoutMs: 60_000,
    });
    const applying = e.apply(changed());
    advance(61_000);
    await expect(applying).rejects.toThrow(/timed out/i);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("accepts a later apply after a render timed out", async () => {
    const { clock, advance } = fakeClock();
    let hang = true;
    const sometimes: Renderer = {
      name: "sometimes",
      render: () => (hang ? new Promise<void>(() => {}) : Promise.resolve()),
    };
    const e = new ApplyEngine({
      configPath, journalPath, renderers: [sometimes], clock, renderTimeoutMs: 60_000,
    });
    const first = e.apply(changed());
    advance(61_000);
    await expect(first).rejects.toThrow(/timed out/i);
    hang = false;
    await expect(e.apply(changed())).resolves.toHaveProperty("id");
  });

  /**
   * The guard that makes renderCurrent() safe to call from outside. apply()
   * holds the reservation across its renders precisely so two configurations
   * are never in flight at once; a public entry into renderAll that ignored
   * that could push a stale configuration through a renderer mid-apply.
   * Deleting the guard left every test green.
   */
  it("refuses renderCurrent() while an apply is in flight", async () => {
    const { clock } = fakeClock();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: Config[] = [];
    // Blocks the first render only, so removing the guard produces a clean
    // "resolved instead of rejecting" rather than a hang.
    const slow: Renderer = {
      name: "slow",
      async render(c) { seen.push(structuredClone(c)); if (seen.length === 1) await gate; },
    };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [slow], clock });

    const applying = e.apply(changed());
    expect(e.status().state).toBe("applying");
    await expect(e.renderCurrent()).rejects.toThrow(/in flight/);
    // And nothing reached the renderer behind the apply's back.
    expect(seen).toHaveLength(1);

    release();
    await applying;
  });

  /**
   * Task 6 skipped the rollback re-render for a renderer that timed out, on
   * the grounds that it is presumed still wedged (K-10). What it promised to
   * preserve was the behaviour for every *other* failure: a renderer that
   * threw still gets the previous configuration pushed back through it, so
   * the system goes back as well as the file. Only the inverse was gated —
   * `if (!(e instanceof RenderTimeoutError))` could be `if (false)` and the
   * suite stayed green.
   */
  it("re-renders the previous configuration when a renderer throws", async () => {
    const { clock } = fakeClock();
    const seen: Config[] = [];
    let fail = true;
    const flaky: Renderer = {
      name: "flaky",
      async render(c) {
        seen.push(structuredClone(c));
        if (fail) { fail = false; throw new Error("nope"); }
      },
    };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [flaky], clock });

    await expect(e.apply(changed())).rejects.toThrow(/nope/);
    // config.yaml is restored either way. This is the other half: the running
    // system is told about it too.
    expect(seen).toHaveLength(2);
    expect(seen[1].system.hostname).toBe("yonder");
  });

  it("records a timed-out apply as failed in lastResult", async () => {
    const { clock, advance } = fakeClock();
    const hung: Renderer = { name: "hung", render: () => new Promise(() => {}) };
    const e = new ApplyEngine({
      configPath, journalPath, renderers: [hung], clock, renderTimeoutMs: 60_000,
    });
    const applying = e.apply(changed());
    advance(61_000);
    await applying.catch(() => {});
    expect(e.status().lastResult?.outcome).toBe("failed");
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

/**
 * Journal.clear() (unlinkDurable -> fsyncDir) can throw: unlink's own failure
 * is swallowed, but the directory fsync's openSync/fsyncSync is not, and the
 * realistic trigger on this hardware is EIO from a worn SD card during the
 * journal directory fsync. Three call sites in the engine assumed clear()
 * could not fail. Journal.prototype.clear is spied on to throw, which is the
 * same fault the reviewer reproduced with the journal directory at mode 0300
 * (unlink succeeds, opening the directory to fsync it does not).
 */
describe("ApplyEngine when the journal cannot be cleared", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function explodingClear(): void {
    vi.spyOn(Journal.prototype, "clear").mockImplementation(() => {
      throw new Error("EIO: simulated fsync failure clearing the apply journal");
    });
  }

  it("still releases the reservation for a future apply when clear() throws during apply()'s own rollback", async () => {
    const { clock } = fakeClock();
    // Fails the first render (forcing apply()'s rollback path), then behaves,
    // so a second apply on the *same* engine instance is the proof that the
    // in-memory reservation was actually released.
    let shouldFail = true;
    const flaky: Renderer = { name: "flaky", async render() { if (shouldFail) throw new Error("nope"); } };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [flaky], clock });
    explodingClear();

    // The renderer's failure is what the caller needs to see, not a secondary
    // failure to clean up the journal.
    await expect(e.apply(changed())).rejects.toThrow(/nope/);
    expect(e.status().state).toBe("idle");

    vi.restoreAllMocks();
    shouldFail = false;
    // Before the fix this fails with "an apply is already pending": the
    // engine was stuck "applying" forever because finish() never ran.
    await expect(e.apply(changed())).resolves.toBeTruthy();
  });

  it("leaves the countdown armed when clear() throws during confirm(), so the change still reverts on schedule", async () => {
    const { clock, advance } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock, timeoutMs: 120_000 });
    const { id } = await e.apply(changed());

    explodingClear();
    expect(() => e.confirm(id)).toThrow(/EIO/);
    vi.restoreAllMocks();

    // Neither committed nor stuck limbo: still pending, countdown still live.
    expect(e.status().state).toBe("pending");
    advance(120_000);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");
  });

  it("does not produce an unhandled rejection or a stuck state when clear() throws during the timeout revert", async () => {
    const { clock, advance } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock, timeoutMs: 120_000 });
    await e.apply(changed());
    explodingClear();

    // revert() runs fire-and-forget off the countdown timer (`void
    // this.revert()`); nothing awaits its promise, so a throw inside it would
    // otherwise be an unhandled rejection.
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      advance(120_000);
      // Let the microtask queue drain so Node has a chance to report an
      // unhandled rejection before we assert none occurred.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(rejections).toEqual([]);
    // The rollback itself is the correctness-critical part and must still
    // have happened even though the journal could not be cleared afterward.
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(e.status().state).toBe("idle");

    vi.restoreAllMocks();
    await expect(e.apply(changed())).resolves.toBeTruthy();
  });
});
