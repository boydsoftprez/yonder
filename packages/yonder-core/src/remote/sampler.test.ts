// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_HISTORY, DEFAULT_INTERVAL_MS, TrafficSampler } from "./sampler.js";
import type { Traffic } from "./traffic.js";
import type { Clock } from "../apply/types.js";

/** The clock the test drives by hand, so nothing here waits on real time. */
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
      for (const [h, timer] of [...timers]) if (timer.at <= t) { timers.delete(h); timer.fn(); }
    },
  };
}

/** A `readTraffic` double scripted with one counter set per call, in order. */
function scriptedReads(...readings: (Traffic | null)[]): () => Traffic | null {
  let i = 0;
  return () => {
    const r = readings[Math.min(i, readings.length - 1)] ?? null;
    i += 1;
    return r;
  };
}

describe("TrafficSampler", () => {
  it("has nothing to show for an interface it has never sampled", () => {
    const { clock } = fakeClock();
    const sampler = new TrafficSampler({ clock });
    expect(sampler.forInterface(null)).toEqual({ rxBitsPerSecond: null, txBitsPerSecond: null, history: [] });
    expect(sampler.forInterface("zt0")).toEqual({ rxBitsPerSecond: null, txBitsPerSecond: null, history: [] });
  });

  it("yields no rate from the first sample - one reading is a total, not a rate", () => {
    const { clock, advance } = fakeClock();
    const read = scriptedReads({ rxBytes: 1000, txBytes: 500 });
    const sampler = new TrafficSampler({ clock, read });
    sampler.start();
    sampler.forInterface("zt0");
    advance(DEFAULT_INTERVAL_MS); // first tick: establishes the baseline only
    expect(sampler.forInterface("zt0")).toEqual({ rxBitsPerSecond: null, txBitsPerSecond: null, history: [] });
  });

  it("turns two readings into bits per second, not bytes", () => {
    const { clock, advance } = fakeClock();
    // 250 bytes received and 125 sent over the 2 s between ticks.
    const read = scriptedReads(
      { rxBytes: 1000, txBytes: 500 },
      { rxBytes: 1250, txBytes: 625 },
    );
    const sampler = new TrafficSampler({ clock, read });
    sampler.start();
    sampler.forInterface("zt0");
    advance(DEFAULT_INTERVAL_MS);
    advance(DEFAULT_INTERVAL_MS);
    const t = sampler.forInterface("zt0");
    expect(t.rxBitsPerSecond).toBe(1000); // 250 * 8 / 2
    expect(t.txBitsPerSecond).toBe(500); // 125 * 8 / 2
    expect(t.history).toEqual([{ rx: 1000, tx: 500 }]);
  });

  it("samples every 2000ms by default, and not before", () => {
    const { clock, advance } = fakeClock();
    let calls = 0;
    const read = (): Traffic | null => {
      calls += 1;
      return { rxBytes: calls * 100, txBytes: calls * 50 };
    };
    const sampler = new TrafficSampler({ clock, read });
    sampler.start();
    sampler.forInterface("zt0");
    advance(DEFAULT_INTERVAL_MS - 1);
    expect(calls).toBe(0);
    advance(1);
    expect(calls).toBe(1);
  });

  it("keeps at most 60 samples by default, oldest dropped first", () => {
    const { clock, advance } = fakeClock();
    let bytes = 0;
    const read = (): Traffic | null => {
      bytes += 1000;
      return { rxBytes: bytes, txBytes: bytes };
    };
    const sampler = new TrafficSampler({ clock, read });
    sampler.start();
    sampler.forInterface("zt0");
    for (let i = 0; i < 65; i += 1) advance(DEFAULT_INTERVAL_MS);
    expect(sampler.forInterface("zt0").history).toHaveLength(DEFAULT_HISTORY);
  });

  it("honours a configured interval and history length", () => {
    const { clock, advance } = fakeClock();
    let bytes = 0;
    const read = (): Traffic | null => {
      bytes += 800;
      return { rxBytes: bytes, txBytes: bytes };
    };
    const sampler = new TrafficSampler({ clock, read, intervalMs: 500, history: 3 });
    sampler.start();
    sampler.forInterface("zt0");
    for (let i = 0; i < 6; i += 1) advance(500);
    expect(sampler.forInterface("zt0").history).toHaveLength(3);
  });

  it("discards history and starts again when a counter goes backwards", () => {
    const { clock, advance } = fakeClock();
    const read = scriptedReads(
      { rxBytes: 100_000, txBytes: 50_000 }, // baseline
      { rxBytes: 102_000, txBytes: 51_000 }, // +2000/+1000 over 2s -> 8000/4000 bps
      { rxBytes: 500, txBytes: 200 }, // the interface was replaced
      { rxBytes: 900, txBytes: 400 }, // +400/+200 over 2s from the new baseline
    );
    const sampler = new TrafficSampler({ clock, read });
    sampler.start();
    sampler.forInterface("zt0");
    advance(DEFAULT_INTERVAL_MS); // baseline
    advance(DEFAULT_INTERVAL_MS); // one real sample
    expect(sampler.forInterface("zt0").history).toHaveLength(1);

    advance(DEFAULT_INTERVAL_MS); // counters fell - discarded, no sample, no crash
    expect(sampler.forInterface("zt0")).toEqual({ rxBitsPerSecond: null, txBitsPerSecond: null, history: [] });

    advance(DEFAULT_INTERVAL_MS); // first delta from the new baseline
    const t = sampler.forInterface("zt0");
    expect(t.history).toHaveLength(1);
    expect(t.rxBitsPerSecond).toBe(1600); // 400 * 8 / 2
    expect(t.txBitsPerSecond).toBe(800); // 200 * 8 / 2
  });

  it("resets when the interface changes, never carrying one interface's numbers onto another", () => {
    const { clock, advance } = fakeClock();
    const read = scriptedReads(
      { rxBytes: 1000, txBytes: 500 },
      { rxBytes: 2000, txBytes: 1000 },
    );
    const sampler = new TrafficSampler({ clock, read });
    sampler.start();
    sampler.forInterface("ztuqliuo7y");
    advance(DEFAULT_INTERVAL_MS);
    advance(DEFAULT_INTERVAL_MS);
    expect(sampler.forInterface("ztuqliuo7y").history).toHaveLength(1);

    // ZeroTier makes a new interface on every join.
    expect(sampler.forInterface("zttqh536rh")).toEqual({
      rxBitsPerSecond: null,
      txBitsPerSecond: null,
      history: [],
    });
  });

  it("resets when readTraffic returns null - the interface is gone", () => {
    const { clock, advance } = fakeClock();
    let gone = false;
    const read = (): Traffic | null => (gone ? null : { rxBytes: 1000, txBytes: 500 });
    const sampler = new TrafficSampler({ clock, read });
    sampler.start();
    sampler.forInterface("zt0");
    advance(DEFAULT_INTERVAL_MS);
    advance(DEFAULT_INTERVAL_MS);
    expect(sampler.forInterface("zt0").history).toHaveLength(1);

    gone = true;
    advance(DEFAULT_INTERVAL_MS);
    expect(sampler.forInterface("zt0")).toEqual({ rxBitsPerSecond: null, txBitsPerSecond: null, history: [] });
  });

  it("stops sampling once stopped", () => {
    const { clock, advance } = fakeClock();
    let calls = 0;
    const read = (): Traffic | null => {
      calls += 1;
      return { rxBytes: calls * 100, txBytes: calls * 100 };
    };
    const sampler = new TrafficSampler({ clock, read });
    sampler.start();
    sampler.forInterface("zt0");
    advance(DEFAULT_INTERVAL_MS);
    sampler.stop();
    advance(DEFAULT_INTERVAL_MS);
    advance(DEFAULT_INTERVAL_MS);
    expect(calls).toBe(1);
  });

  it("never samples before start(), even once an interface is named", () => {
    const { clock, advance } = fakeClock();
    let calls = 0;
    const read = (): Traffic | null => {
      calls += 1;
      return { rxBytes: 100, txBytes: 100 };
    };
    const sampler = new TrafficSampler({ clock, read });
    sampler.forInterface("zt0");
    advance(10_000);
    expect(calls).toBe(0);
  });
});
