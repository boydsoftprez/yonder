// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ReachWatch } from "./watch.js";
import { ReachMonitor } from "./monitor.js";
import {
  FAILURES_TO_STAND_DOWN,
  REACH_TICK_DEADLINE_MS,
  REACH_TICK_MS,
  Standing,
  type PathName,
} from "./standing.js";
import type { Clock } from "../../apply/types.js";
import type { Counters } from "./counters.js";

/**
 * A clock the test drives by hand. Nothing in `reach/` may read the wall
 * clock, and a watch that ticks on a real timer would make every test below
 * a race.
 */
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimer: (ms, fn) => { const handle = next++; timers.set(handle, { at: now + ms, fn }); return handle; },
    clearTimer: (h) => { timers.delete(h as number); },
  };
  return {
    clock,
    armed: () => timers.size,
    /** Move time on, fire what is due, and let the tick's awaits settle. */
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(handle); timer.fn(); }
      }
      for (let i = 0; i < 200; i++) await Promise.resolve();
    },
  };
}

interface Bench {
  watch: ReachWatch;
  standing: Standing;
  probed: string[];
  lines: string[];
  clock: ReturnType<typeof fakeClock>;
  /** Set what the next counter reading for a device will be. */
  counters: Map<string, Counters>;
  /** Move the default route to another path, between ticks. */
  setInUse(path: PathName | null): void;
  /** Rename the interface a path is on, between ticks. */
  setDevices(devices: Partial<Record<PathName, string>>): void;
  /** Make the reading of which path is in use never come back, or stop. */
  setInUseHangs(hangs: boolean): void;
  /** Let every reading that was left hanging answer at last. */
  releaseInUse(): void;
  /** Make every probe from now on never come back, or stop. */
  setProbeHangs(hangs: boolean): void;
  /** Let every probe that was left hanging answer at last, with this result. */
  releaseProbes(reached: boolean): void;
  /** Every standing change announced, in order. What the daemon re-metrics on. */
  changes: [PathName, boolean][];
}

function bench(opts: {
  devices?: Partial<Record<PathName, string>>;
  inUse?: PathName | null;
  order?: PathName[];
  reaches?: (device: string) => boolean;
  probeThrows?: boolean;
  countersThrow?: boolean;
  inUseThrows?: boolean;
  inUseHangs?: boolean;
} = {}): Bench {
  const clock = fakeClock();
  const lines: string[] = [];
  const probed: string[] = [];
  const counters = new Map<string, Counters>();
  const changes: [PathName, boolean][] = [];
  const standing = new Standing({
    clock: clock.clock,
    log: (l) => lines.push(l),
    onChange: (path, stoodDown) => changes.push([path, stoodDown]),
  });

  const read = (device: string): Counters | null => {
    if (opts.countersThrow === true) throw new Error("/sys is not readable");
    return counters.get(device) ?? null;
  };

  let devices = opts.devices ?? { ethernet: "eth0", modem: "wwan0" };
  let inUse: PathName | null = opts.inUse === undefined ? "modem" : opts.inUse;
  let hangs = opts.inUseHangs === true;
  const waiting: (() => void)[] = [];
  let probeHangs = false;
  const heldProbes: ((reached: boolean) => void)[] = [];

  const monitor = new ReachMonitor({
    standing,
    probe: async (device) => {
      probed.push(device);
      if (opts.probeThrows === true) throw new Error("curl could not be started");
      // A `curl` that has not come back yet. Held until the test lets it
      // answer, which is the only way to make an abandoned tick's probe reply
      // long after the tick it belonged to was given up on.
      if (probeHangs) return await new Promise<boolean>((resolve) => heldProbes.push(resolve));
      return opts.reaches === undefined ? true : opts.reaches(device);
    },
    counters: read,
    devices: async () => devices,
    order: () => opts.order ?? ["ethernet", "modem"],
    holding: async () => {
      if (opts.inUseThrows === true) throw new Error("NetworkManager is not answering");
      // A wedged ModemManager: the promise settles only when the test says so.
      if (hangs) await new Promise<void>((resolve) => waiting.push(resolve));
      return inUse === null ? [] : [inUse];
    },
    log: (l) => lines.push(l),
  });

  const watch = new ReachWatch({
    monitor,
    clock: clock.clock,
    counters: read,
    log: (l) => lines.push(l),
  });

  return {
    watch, standing, probed, lines, clock, counters, changes,
    setInUse(path) { inUse = path; },
    setDevices(next) { devices = next; },
    setInUseHangs(next) { hangs = next; },
    releaseInUse() { while (waiting.length > 0) waiting.pop()?.(); },
    setProbeHangs(next) { probeHangs = next; },
    releaseProbes(reached) { while (heldProbes.length > 0) heldProbes.pop()?.(reached); },
  };
}

/** Bytes moved both ways since the last reading. */
function carrying(b: Bench, device: string, by = 4_000): void {
  const at = b.counters.get(device) ?? { rx: 0, tx: 0 };
  b.counters.set(device, { rx: at.rx + by, tx: at.tx + by });
}

/** Bytes going out, nothing coming back. What a wrong APN looks like. */
function shouting(b: Bench, device: string, by = 4_000): void {
  const at = b.counters.get(device) ?? { rx: 0, tx: 0 };
  b.counters.set(device, { rx: at.rx, tx: at.tx + by });
}

describe("ReachWatch", () => {
  /**
   * The constraint the whole design rests on: a device that is working spends
   * nothing on finding that out (R-CEL-09, R-NET-13). The counters are
   * maintained by the kernel whether or not anything reads them, so a healthy
   * link is judged for free — and a probe on a metered cellular link is not
   * free.
   */
  it("makes no probe at all while traffic is moving both ways", async () => {
    const b = bench();
    b.counters.set("wwan0", { rx: 1_000, tx: 1_000 });
    b.watch.start();
    // The first tick tests the path because it has only just started
    // carrying; every tick after it sees traffic and must cost nothing.
    await b.clock.advance(REACH_TICK_MS);
    const afterFirst = b.probed.length;
    for (let i = 0; i < 6; i++) {
      carrying(b, "wwan0");
      await b.clock.advance(REACH_TICK_MS);
    }
    expect(b.probed.length).toBe(afterFirst);
  });

  it("counts moving traffic as evidence the path is healthy", async () => {
    // Free evidence, and the way a path comes back from being stood down
    // without a probe ever running.
    const b = bench({ reaches: () => false });
    b.counters.set("wwan0", { rx: 0, tx: 0 });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) shouting(b, "wwan0");
    b.watch.start();
    for (let i = 0; i < FAILURES_TO_STAND_DOWN + 1; i++) {
      shouting(b, "wwan0");
      await b.clock.advance(REACH_TICK_MS);
    }
    expect(b.standing.standingOf("modem")).toBe("no-route-out");

    carrying(b, "wwan0");
    await b.clock.advance(REACH_TICK_MS);
    expect(b.standing.standingOf("modem")).not.toBe("no-route-out");
  });

  /**
   * An idle link is not a dead one. `looksDead` already refuses to conclude
   * anything from silence in both directions, and the watch must not add a
   * second route to the same mistake — a parked aircraft on a good link would
   * otherwise probe itself into being stood down.
   */
  it("never probes a link on the strength of it being idle", async () => {
    const b = bench();
    b.counters.set("wwan0", { rx: 5_000, tx: 5_000 });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    const afterFirst = b.probed.length;
    // Nothing moves, in either direction, for a long time.
    for (let i = 0; i < 10; i++) await b.clock.advance(REACH_TICK_MS);
    expect(b.probed.length).toBe(afterFirst);
  });

  it("probes the path in use once it stops receiving", async () => {
    // Bytes leaving, nothing coming back: §2's failure, in counters.
    const b = bench({ reaches: () => false });
    b.counters.set("wwan0", { rx: 900, tx: 900 });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    const afterFirst = b.probed.length;
    shouting(b, "wwan0");
    await b.clock.advance(REACH_TICK_MS);
    expect(b.probed.length).toBeGreaterThan(afterFirst);
    expect(b.probed).toContain("wwan0");
  });

  it("probes the alternatives when the path in use reaches nothing", async () => {
    // So standing says which path can take over, rather than only naming the
    // one that failed.
    const b = bench({ reaches: (d) => d !== "wwan0" });
    b.counters.set("wwan0", { rx: 900, tx: 900 });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    expect(b.probed).toContain("eth0");
    expect(b.standing.standingOf("ethernet")).not.toBe("no-route-out");
  });

  /**
   * The hysteresis needs consecutive evidence, and a trigger that fires once
   * per event would never reach it: a link that fails and then transmits
   * nothing looks exactly like an idle one. So a path with an unresolved
   * failure keeps being tested until it succeeds or is stood down — which is
   * the only reason `FAILURES_TO_STAND_DOWN` can ever be reached in the field.
   */
  it("keeps testing a failing path until it is stood down", async () => {
    const b = bench({ reaches: () => false, devices: { modem: "wwan0" }, order: ["modem"] });
    b.counters.set("wwan0", { rx: 0, tx: 0 });
    b.watch.start();
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await b.clock.advance(REACH_TICK_MS);
    expect(b.standing.standingOf("modem")).toBe("no-route-out");
  });

  /**
   * R-CEL-09: tested with real traffic when it comes up. This is the K-33
   * board — a modem with the wrong APN, no ethernet, no Wi-Fi — where nothing
   * ever transmits enough for the counters to say anything, so the counters
   * alone would never trigger and the access point would never come up.
   */
  it("tests a path that has just started carrying traffic", async () => {
    const b = bench({ devices: { modem: "wwan0" }, order: ["modem"], reaches: () => false });
    b.counters.set("wwan0", { rx: 0, tx: 0 });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    expect(b.probed).toEqual(["wwan0"]);
  });

  it("stands a wrong-APN modem down well inside the fallback window", async () => {
    // What Task 11 Step 6 asks a board to do. The default window is 90 s.
    const b = bench({ devices: { modem: "wwan0" }, order: ["modem"], reaches: () => false });
    b.counters.set("wwan0", { rx: 0, tx: 0 });
    b.watch.start();
    let elapsed = 0;
    while (elapsed < 90_000 && b.standing.standingOf("modem") !== "no-route-out") {
      await b.clock.advance(REACH_TICK_MS);
      elapsed += REACH_TICK_MS;
    }
    expect(b.standing.standingOf("modem")).toBe("no-route-out");
    expect(elapsed).toBeLessThan(90_000);
  });

  /**
   * Counters are absolute numbers about one interface, and two of them are
   * only a comparison when they came from the same one.
   *
   * The board: a busy but dead LAN (`eth0`, ~900 000 bytes each way) and an
   * idle modem (`wwan0`, ~1 000), and nothing on it reaching anything. When
   * the route moves from one to the other, the previous reading and the
   * current one describe different devices — and subtracting them
   * manufactures nearly a megabyte of traffic in both directions that never
   * happened. That fabricated success skips the link-up probe R-CEL-09
   * mandates, clears `no-route-out` outright (`SUCCESSES_TO_RETURN` is 1) and
   * flips `carrying()` to true, which is exactly the answer that stops the
   * fallback watchdog raising the access point on a board with no way out.
   */
  it("never reads one interface's counters as the other's traffic", async () => {
    const b = bench({
      devices: { ethernet: "eth0", modem: "wwan0" },
      order: ["ethernet", "modem"],
      inUse: "modem",
      reaches: () => false,
    });
    b.counters.set("wwan0", { rx: 1_000, tx: 1_000 });
    b.counters.set("eth0", { rx: 900_000, tx: 900_000 });
    b.watch.start();
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await b.clock.advance(REACH_TICK_MS);
    expect(b.standing.standingOf("ethernet")).toBe("no-route-out");

    // The modem drops its address; ethernet becomes the path in use.
    b.setInUse("ethernet");
    const before = b.probed.length;
    await b.clock.advance(REACH_TICK_MS);

    expect(b.probed.length).toBeGreaterThan(before);
    expect(b.standing.standingOf("ethernet")).toBe("no-route-out");
  });

  /**
   * The same hazard under an unchanged path. A modem has two names: until
   * `modemInterface` resolves, the map falls back to the control port
   * NetworkManager lists (`cdc-wdm0`), and afterwards it is the ModemManager
   * data port (`wwan0`) that holds the address and carries every byte. The
   * path never changed, so keying the reset on the path alone would still
   * compare one interface's counters with another's — and skip the link-up
   * test on the interface that is actually carrying traffic.
   */
  it("tests again when the path in use changes interface underneath it", async () => {
    const b = bench({ devices: { modem: "cdc-wdm0" }, order: ["modem"], inUse: "modem" });
    b.counters.set("cdc-wdm0", { rx: 1_000, tx: 1_000 });
    b.counters.set("wwan0", { rx: 50_000, tx: 50_000 });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    expect(b.probed).toEqual(["cdc-wdm0"]);

    b.setDevices({ modem: "wwan0" });
    await b.clock.advance(REACH_TICK_MS);
    expect(b.probed).toContain("wwan0");
  });

  it("does nothing when no path is carrying traffic", async () => {
    const b = bench({ inUse: null });
    b.watch.start();
    for (let i = 0; i < 5; i++) await b.clock.advance(REACH_TICK_MS);
    expect(b.probed).toEqual([]);
  });

  it("makes no counter-driven decision before it has two readings", async () => {
    // Nothing to compare against is not evidence of anything.
    const b = bench({ devices: { modem: "wwan0" }, order: ["modem"] });
    // No counters at all for this device: every read answers null.
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    const afterFirst = b.probed.length;
    await b.clock.advance(REACH_TICK_MS);
    expect(b.probed.length).toBe(afterFirst);
  });

  /**
   * The daemon that stops probing silently is worse than one that never
   * probed: nothing says it happened, and the standing quietly freezes at
   * whatever it last was.
   */
  it("survives a probe that rejects, and keeps ticking", async () => {
    const b = bench({ probeThrows: true, devices: { modem: "wwan0" }, order: ["modem"] });
    b.counters.set("wwan0", { rx: 0, tx: 0 });
    b.watch.start();
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await b.clock.advance(REACH_TICK_MS);
    expect(b.clock.armed()).toBe(1);
    expect(b.standing.standingOf("modem")).toBe("no-route-out");
  });

  it("survives a counter read that throws, and says so", async () => {
    const b = bench({ countersThrow: true });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    await b.clock.advance(REACH_TICK_MS);
    expect(b.clock.armed()).toBe(1);
    expect(b.lines.join("\n")).toMatch(/could not read the byte counters/);
  });

  it("survives being unable to ask which path is in use, and keeps ticking", async () => {
    const b = bench({ inUseThrows: true });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    await b.clock.advance(REACH_TICK_MS);
    expect(b.clock.armed()).toBe(1);
    expect(b.lines.join("\n")).toMatch(/could not check which way out is working/);
  });

  /**
   * A hang is not a throw, and the `catch` around a tick does not cover one.
   *
   * The loop is chained: the next tick is armed in the `finally` of this one,
   * and nothing else arms it. So an `inUseNow()` that never comes back — a
   * ModemManager wedged on a D-Bus call, which is an everyday failure for a
   * USB modem that enumerated badly — used to stop the loop for good, with
   * nothing logged, while `carrying()` went on answering from evidence that
   * would never be refreshed. The class comment promised that could not
   * happen.
   */
  it("gives up on a tick that never comes back, and goes on ticking", async () => {
    const b = bench({ devices: { modem: "wwan0" }, order: ["modem"], inUseHangs: true, reaches: () => false });
    b.counters.set("wwan0", { rx: 0, tx: 0 });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);
    // The tick is in flight and bounded, rather than waited on for ever.
    expect(b.clock.armed()).toBe(1);
    expect(b.probed).toEqual([]);

    await b.clock.advance(REACH_TICK_DEADLINE_MS);
    expect(b.lines.join("\n")).toMatch(/did not finish in time/);

    // And the loop recovers the moment the board does.
    b.setInUseHangs(false);
    await b.clock.advance(REACH_TICK_MS);
    expect(b.probed).toContain("wwan0");
  });

  /**
   * The abandoned tick is still out there. If it ever answers, its reading is
   * about a moment that has passed, and writing it over a newer one is C1's
   * mistake by another route — one interface's counters standing in for
   * another's.
   */
  it("ignores an abandoned tick that answers after it was given up on", async () => {
    const b = bench({ devices: { modem: "wwan0" }, order: ["modem"], inUseHangs: true, reaches: () => false });
    b.counters.set("wwan0", { rx: 0, tx: 0 });
    b.watch.start();
    await b.clock.advance(REACH_TICK_MS);            // the first tick hangs
    await b.clock.advance(REACH_TICK_DEADLINE_MS);   // and is given up on
    b.setInUseHangs(false);
    await b.clock.advance(REACH_TICK_MS);            // a newer tick takes over
    const settled = b.probed.length;
    expect(settled).toBeGreaterThan(0);

    // The abandoned one answers at last. Its reading belongs to a moment that
    // has passed, and it must not act on it or write it over the newer one.
    b.releaseInUse();
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(b.probed.length).toBe(settled);
    expect(b.clock.armed()).toBe(1);
  });

  /**
   * And the probe it started is still out there too.
   *
   * `withDeadline` abandons the *wait*, not the *work*. The generation guard
   * sat once at the top of `tick()`, immediately after `inUseNow()` — so an
   * abandoned tick went on to run `monitor.test()`, which folds its result
   * into `Standing`. `SUCCESSES_TO_RETURN` is 1, so a single stale success
   * clears `no-route-out` outright, and in the daemon that `onChange` is
   * `renderer.remetric`: the default route moves back onto a path four newer
   * probes have called dead, on evidence over a minute old.
   */
  it("drops the result of a probe belonging to a tick that was given up on", async () => {
    const b = bench({
      devices: { ethernet: "eth0" },
      order: ["ethernet"],
      inUse: "ethernet",
      reaches: () => false,
    });
    b.watch.start();
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) await b.clock.advance(REACH_TICK_MS);
    expect(b.standing.standingOf("ethernet")).toBe("no-route-out");
    expect(b.changes).toEqual([["ethernet", true]]);

    // The next tick's `curl` hangs, and the tick is given up on.
    b.setProbeHangs(true);
    await b.clock.advance(REACH_TICK_MS);
    await b.clock.advance(REACH_TICK_DEADLINE_MS);
    expect(b.lines.join("\n")).toMatch(/did not finish in time/);

    // Four newer ticks probe the same interface, and all four fail.
    b.setProbeHangs(false);
    const abandoned = b.probed.length;
    for (let i = 0; i < 4; i++) await b.clock.advance(REACH_TICK_MS);
    expect(b.probed.length).toBe(abandoned + 4);

    // The abandoned probe answers success at last. Its answer is about a
    // moment that has passed and must not reach standing at all.
    b.releaseProbes(true);
    for (let i = 0; i < 200; i++) await Promise.resolve();

    expect(b.standing.standingOf("ethernet")).toBe("no-route-out");
    expect(b.changes).toEqual([["ethernet", true]]);
  });

  it("never reads the wall clock", async () => {
    // Every timer this watch owns comes from the injected Clock. A tick loop
    // on a real timer would outlive the daemon in a test suite.
    const b = bench();
    b.watch.start();
    expect(b.clock.armed()).toBe(1);
  });

  /**
   * The same reason FallbackWatchdog has stop(): a loop that outlives the
   * daemon it belongs to goes on questioning NetworkManager, and running
   * `curl` on a metered link, on behalf of a process that has closed its
   * socket.
   */
  it("stops, and stays stopped", async () => {
    const b = bench();
    b.watch.start();
    b.watch.stop();
    expect(b.clock.armed()).toBe(0);
    await b.clock.advance(REACH_TICK_MS * 4);
    expect(b.probed).toEqual([]);
    b.watch.start();
    expect(b.clock.armed()).toBe(0);
  });

  it("does not stack ticks when started twice", async () => {
    const b = bench();
    b.watch.start();
    b.watch.start();
    expect(b.clock.armed()).toBe(1);
  });

  it("stops cleanly in the middle of a tick", async () => {
    // stop() during a probe must not leave the loop rearming behind it.
    const b = bench({ devices: { modem: "wwan0" }, order: ["modem"] });
    b.counters.set("wwan0", { rx: 0, tx: 0 });
    b.watch.start();
    b.clock.advance(REACH_TICK_MS);
    b.watch.stop();
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(b.clock.armed()).toBe(0);
  });
});
