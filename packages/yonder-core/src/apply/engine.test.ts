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

  /**
   * R-CFG-09 on the way in, not just on the way out. A configuration that
   * loads has to be one that applies: an operator on a device seeded by an
   * earlier build can read their own file — from the boot partition, from a
   * backup, from `GET /config` on an older console — and post it back, and
   * this API is the only repair path a console has. Refusing it here would
   * hand them a device they can read and cannot fix.
   *
   * The key is dropped, not stored: what reaches the renderers and the file
   * is the validated document, so the next write is already free of it.
   */
  it("accepts a posted configuration carrying a retired key, and does not store it", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { clock } = fakeClock();
      const r = renderer();
      const e = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });

      const fromAnEarlierBuild = {
        ...changed(),
        network: {
          ...DEFAULT_CONFIG.network,
          ap: {
            ...DEFAULT_CONFIG.network.ap,
            dhcp: { start: "192.168.77.2", end: "192.168.77.50", lease: "12h" },
          },
        },
      };

      const { id } = await e.apply(fromAnEarlierBuild as unknown as Config);
      e.confirm(id);

      expect(loadConfig(configPath).system.hostname).toBe("changed");
      expect(readFileSync(configPath, "utf8")).not.toContain("lease:");
      expect("dhcp" in r.calls[0]!.network.ap).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it("still rejects a posted configuration with a key nobody retired", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    const typo = { ...changed(), network: { ...DEFAULT_CONFIG.network, ap: { ...DEFAULT_CONFIG.network.ap, ssdi: "yonder" } } };
    await expect(e.apply(typo as unknown as Config)).rejects.toThrow(/ssdi/);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
  });

  it("writes the new config and enters pending", async () => {
    const { clock } = fakeClock();
    const r = renderer();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });
    const result = await e.apply(changed());
    expect(result.id).toBeTruthy();
    expect(e.status().state).toBe("pending");
    expect(loadConfig(configPath).system.hostname).toBe("changed");
    expect(r.calls).toHaveLength(1);
    // The ordinary case: config.yaml on disk was readable, so the rollback
    // target is the operator's own previous configuration, not the default.
    expect(result.previousIsDefault).toBeUndefined();
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
/**
 * A degraded renderer set (daemon/server.ts catching a malformed
 * secrets.yaml out of buildRenderers) used to leave apply() rendering
 * against an empty renderer set: config.yaml got written, the renderer loop
 * did nothing, and the operator was told 200/confirmed for a change that
 * never reached anything. apply() now refuses outright while degraded; see
 * daemon/server.test.ts for the same gate proven through the HTTP layer.
 */
describe("ApplyEngine when the renderer set is degraded", () => {
  it("has no degraded reason by default", () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    expect(e.status().degraded).toBeUndefined();
  });

  it("reports the reason from status()", () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({
      configPath, journalPath, renderers: [renderer()], clock,
      degraded: "the network renderer could not be built (test)",
    });
    expect(e.status().degraded).toBe("the network renderer could not be built (test)");
  });

  it("refuses apply() while degraded, touching neither the file nor the renderers", async () => {
    const { clock } = fakeClock();
    const r = renderer();
    const e = new ApplyEngine({
      configPath, journalPath, renderers: [r], clock,
      degraded: "the network renderer could not be built (test)",
    });
    await expect(e.apply(changed())).rejects.toThrow(/degraded/);
    expect(loadConfig(configPath).system.hostname).toBe("yonder");
    expect(r.calls).toHaveLength(0);
    expect(e.status().state).toBe("idle");
  });
});

/**
 * K-14. `apply()` used to snapshot config.yaml as its rollback target before
 * even looking at the operator's posted body: an unloadable file on disk
 * threw straight out of that snapshot, refusing *every* apply — including a
 * perfectly good one — with an error describing the file already there, not
 * what was just posted. The shipped default now stands in as the rollback
 * target instead, recorded rather than silent.
 */
describe("ApplyEngine.apply when config.yaml on disk is unloadable", () => {
  beforeEach(() => {
    writeFileSync(configPath, "version: 99\nnetwork: nonsense\n");
  });

  it("accepts a good apply instead of refusing it", async () => {
    const { clock } = fakeClock();
    const r = renderer();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [r], clock });
    const result = await e.apply(changed());
    expect(result.id).toBeTruthy();
    expect(e.status().state).toBe("pending");
    expect(loadConfig(configPath).system.hostname).toBe("changed");
    expect(r.calls).toHaveLength(1);
  });

  it("marks the rollback target as the shipped default, not silently", async () => {
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    const result = await e.apply(changed());
    expect(result.previousIsDefault).toBe(true);

    const entry = JSON.parse(readFileSync(journalPath, "utf8")) as {
      previous: Config;
      previousIsDefault: boolean;
    };
    expect(entry.previousIsDefault).toBe(true);
    expect(entry.previous).toEqual(DEFAULT_CONFIG);
  });

  it("rolls back to the shipped default, not the unloadable file, when the apply then fails", async () => {
    const { clock } = fakeClock();
    const bad: Renderer = { name: "bad", async render() { throw new Error("nope"); } };
    const e = new ApplyEngine({ configPath, journalPath, renderers: [bad], clock });
    await expect(e.apply(changed())).rejects.toThrow(/nope/);
    expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
  });

  it("preserves the unloadable file as config.yaml.invalid before overwriting it", async () => {
    const before = readFileSync(configPath, "utf8");
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    await e.apply(changed());
    expect(readFileSync(`${configPath}.invalid`, "utf8")).toBe(before);
  });

  it("falls back to the default when config.yaml is missing outright, without preserving nothing", async () => {
    // A different failure than "invalid": there is no file at all to copy.
    rmSync(configPath);
    const { clock } = fakeClock();
    const e = new ApplyEngine({ configPath, journalPath, renderers: [renderer()], clock });
    const result = await e.apply(changed());
    expect(result.previousIsDefault).toBe(true);
    expect(existsSync(`${configPath}.invalid`)).toBe(false);
    expect(loadConfig(configPath).system.hostname).toBe("changed");
  });
});

/**
 * The confirmation window, and which one an apply gets (R-CFG-03, Task 5 of
 * M1b-2).
 *
 * Same requirement, two very different amounts of work between the apply and
 * the confirmation. A change that leaves the operator's connection where it
 * was is confirmed in seconds; one that moves the Wi-Fi radio takes the access
 * point off the air and they have to find the device again on a different
 * network first.
 */
describe("the confirmation window", () => {
  function joining(): Config {
    const c = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = "HomeNetwork";
    return c;
  }

  function engineWithWindows(clock: Clock): ApplyEngine {
    return new ApplyEngine({
      configPath, journalPath, renderers: [renderer()], clock,
      timeoutMs: 120_000, radioTimeoutMs: 300_000,
    });
  }

  it("gives an ordinary change the ordinary window", async () => {
    const { clock } = fakeClock();
    const engine = engineWithWindows(clock);
    const c = structuredClone(DEFAULT_CONFIG);
    c.system.hostname = "renamed";
    const result = await engine.apply(c);
    expect(result.expiresAt).toBe(120_000);
    expect(result.movesRadio).toBeUndefined();
  });

  it("gives an apply that moves the radio the longer one", async () => {
    const { clock } = fakeClock();
    const engine = engineWithWindows(clock);
    const result = await engine.apply(joining());
    expect(result.expiresAt).toBe(300_000);
    expect(result.movesRadio).toBe(true);
  });

  it("gives the longer window to a move back to the access point too", async () => {
    saveConfig(configPath, joining());
    const { clock } = fakeClock();
    const engine = engineWithWindows(clock);
    const result = await engine.apply(DEFAULT_CONFIG);
    expect(result.expiresAt).toBe(300_000);
    expect(result.movesRadio).toBe(true);
  });

  /**
   * The short window is for a change the operator can watch happen.
   *
   * This asserted the opposite — that changing the client SSID got 120 s —
   * on the reasoning that only a *mode* change moves the radio. A board
   * disproved it: already a client, passphrase changed, connection dropped,
   * and the confirmation was expected from a console that had gone with it.
   * Anything touching `network.client` can take the operator away, so the
   * short window is now for changes that cannot: the access point's own name,
   * the hostname, the theme.
   */
  it("does not widen the window for a change that leaves the radio where it is", async () => {
    saveConfig(configPath, joining());
    const { clock } = fakeClock();
    const engine = engineWithWindows(clock);
    const elsewhere = joining();
    elsewhere.network.ap.ssid = "renamed-ap";
    elsewhere.system.hostname = "renamed";
    const result = await engine.apply(elsewhere);
    expect(result.expiresAt).toBe(120_000);
    expect(result.movesRadio).toBeUndefined();
  });

  it("actually reverts on the widened deadline, not before it", async () => {
    const { clock, advance } = fakeClock();
    const engine = engineWithWindows(clock);
    await engine.apply(joining());

    advance(120_001); // past the ordinary window
    expect(engine.status().state).toBe("pending");
    expect(loadConfig(configPath).network.client.ssid).toBe("HomeNetwork");

    advance(180_000); // past the widened one
    expect(engine.status().state).toBe("idle");
    expect(engine.status().lastResult?.outcome).toBe("reverted");
    expect(loadConfig(configPath).network.client.ssid).toBeNull();
  });
});

/**
 * R-CFG-11. A radio move confirms itself.
 *
 * The operator cannot confirm one: joining a network takes the access point
 * off the air, so the console they would confirm from goes with it. The
 * confirmation this replaces meant finding the device on another network,
 * signing in and clicking inside the window — and missing it threw away a
 * *working* configuration.
 */
describe("a radio move confirms itself", () => {
  function joining(): Config {
    const next = structuredClone(DEFAULT_CONFIG);
    next.network.client.ssid = "HomeNetwork";
    return next;
  }

  function engineWith(
    verifyRadioMove: () => Promise<{ ok: boolean; reason: string }>,
  ): { engine: ApplyEngine; settle: () => Promise<void> } {
    const { clock } = fakeClock();
    const engine = new ApplyEngine({
      configPath, journalPath, renderers: [renderer()], clock, verifyRadioMove,
    });
    // The verifier is deliberately not awaited by apply(); let its promise
    // chain run before asserting on what it did.
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    return { engine, settle };
  }

  it("confirms without a human when the device got onto the network", async () => {
    const { engine, settle } = engineWith(() =>
      Promise.resolve({ ok: true, reason: "the gateway answered" }));
    const result = await engine.apply(joining());
    expect(result.movesRadio).toBe(true);
    await settle();
    expect(engine.status().state).toBe("confirmed");
    expect(engine.status().lastResult?.outcome).toBe("confirmed");
  });

  it("reverts at once when it did not, rather than waiting out the window", async () => {
    const { engine, settle } = engineWith(() =>
      Promise.resolve({ ok: false, reason: "no address" }));
    await engine.apply(joining());
    await settle();
    expect(engine.status().lastResult?.outcome).toBe("reverted");
  });

  /** A verifier that threw has established nothing; the window still runs. */
  it("leaves the window armed when the check itself failed", async () => {
    const { engine, settle } = engineWith(() =>
      Promise.reject(new Error("nmcli is not here")));
    await engine.apply(joining());
    await settle();
    expect(engine.status().state).toBe("pending");
  });

  /** An apply the operator can watch happen is still theirs to confirm. */
  it("does not self-confirm a change that does not move the radio", async () => {
    let asked = 0;
    const { engine, settle } = engineWith(() => {
      asked += 1;
      return Promise.resolve({ ok: true, reason: "" });
    });
    await engine.apply(changed());
    await settle();
    expect(asked).toBe(0);
    expect(engine.status().state).toBe("pending");
  });
});

/**
 * Which applies can take the operator's connection away.
 *
 * This used to ask whether the Wi-Fi *mode* changed, which missed the state a
 * board is most often in: already a client, and the operator changing the
 * passphrase of the network they are connected through. Observed on hardware
 * — that apply got the short window, needed a confirmation from a console
 * that was no longer reachable, and reverted 120 s later.
 */
describe("what counts as moving the radio", () => {
  function withClient(ssid: string | null, secret: string | null): Config {
    const c = structuredClone(DEFAULT_CONFIG);
    c.network.client.ssid = ssid;
    c.network.client.psk = secret === null ? null : { secret };
    return c;
  }

  async function classify(from: Config, to: Config): Promise<boolean> {
    saveConfig(configPath, from);
    const { clock } = fakeClock();
    const engine = new ApplyEngine({
      configPath, journalPath, renderers: [renderer()], clock,
      verifyRadioMove: () => new Promise(() => { /* never settles */ }),
    });
    return (await engine.apply(to)).movesRadio === true;
  }

  it("counts joining a network", async () => {
    expect(await classify(DEFAULT_CONFIG, withClient("HomeNetwork", "wifi_psk"))).toBe(true);
  });

  it("counts leaving one", async () => {
    expect(await classify(withClient("HomeNetwork", "wifi_psk"), DEFAULT_CONFIG)).toBe(true);
  });

  /** The one that was missed. A wrong key deauthenticates you like a failed join. */
  it("counts changing the passphrase of the network you are on", async () => {
    expect(await classify(
      withClient("HomeNetwork", "wifi_psk"),
      withClient("HomeNetwork", "wifi_psk_2"),
    )).toBe(true);
  });

  it("counts moving to a different network", async () => {
    expect(await classify(
      withClient("HomeNetwork", "wifi_psk"),
      withClient("OtherNetwork", "wifi_psk"),
    )).toBe(true);
  });

  it("does not count a change that leaves the radio alone", async () => {
    const from = withClient("HomeNetwork", "wifi_psk");
    const to = structuredClone(from);
    to.system.hostname = "renamed";
    expect(await classify(from, to)).toBe(false);
  });
});
