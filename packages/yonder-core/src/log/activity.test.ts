// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import type { Clock } from "../apply/types.js";
import {
  ACTIVITY_MESSAGE_LIMIT,
  ActivityLog,
  activityLog,
} from "./activity.js";
import { guardSecretValue, forgetGuardedValues, REDACTED } from "../secrets/redact.js";
import { warn, note } from "../log.js";

/** A clock a test moves by hand. Nothing here waits. */
function stepClock(start = 1_000): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    setTimer: () => 0,
    clearTimer: () => {},
    advance: (ms) => { now += ms; },
  };
}

afterEach(() => {
  forgetGuardedValues();
  activityLog.clear();
});

describe("ActivityLog", () => {
  it("records a level with each entry, so a page can tell a note from a fault", () => {
    const log = new ActivityLog({ clock: stepClock() });
    log.record("info", "the access point is up");
    log.record("warn", "could not read the configuration");
    expect(log.entries().map((e) => e.level)).toEqual(["info", "warn"]);
    expect(log.entries().map((e) => e.message))
      .toEqual(["the access point is up", "could not read the configuration"]);
  });

  /**
   * The bound is the point. A device that runs for weeks with an unbounded
   * buffer has a memory leak with a nice name, and it runs out on a 512 MB
   * board at the moment somebody is using the console.
   */
  it("discards oldest-first at capacity", () => {
    const log = new ActivityLog({ capacity: 3, clock: stepClock() });
    for (const n of [1, 2, 3, 4, 5]) log.record("info", `line ${n}`);
    expect(log.entries().map((e) => e.message)).toEqual(["line 3", "line 4", "line 5"]);
    expect(log.entries()).toHaveLength(3);
  });

  it("says how much it has discarded, so a gap is not shown as continuity", () => {
    const log = new ActivityLog({ capacity: 2, clock: stepClock() });
    for (const n of [1, 2, 3, 4]) log.record("info", `line ${n}`);
    const page = log.page(0);
    expect(page.discarded).toBe(2);
    expect(page.oldestSeq).toBe(3);
    expect(page.newestSeq).toBe(4);
  });

  it("caps a single entry, because a count bound is not a bound on bytes", () => {
    const log = new ActivityLog({ clock: stepClock() });
    log.record("info", "x".repeat(ACTIVITY_MESSAGE_LIMIT * 3));
    const message = log.entries()[0]?.message ?? "";
    expect(message.length).toBe(ACTIVITY_MESSAGE_LIMIT + 1);
    expect(message.endsWith("…")).toBe(true);
  });

  it("keeps timestamps monotonic on the injected clock", () => {
    const clock = stepClock(5_000);
    const log = new ActivityLog({ clock });
    log.record("info", "first");
    clock.advance(250);
    log.record("info", "second");
    clock.advance(1_750);
    log.record("warn", "third");
    expect(log.entries().map((e) => e.at)).toEqual([5_000, 5_250, 7_000]);
    for (let i = 1; i < log.entries().length; i++) {
      expect(log.entries()[i]?.at).toBeGreaterThanOrEqual(log.entries()[i - 1]?.at ?? 0);
    }
  });

  /**
   * Sequence numbers, not timestamps, are what a page pages on. A board with
   * no RTC gets an NTP correction that steps the clock backwards, and a reader
   * paging on `at` would then repeat entries or skip them.
   */
  it("numbers entries in order even when the clock steps backwards", () => {
    let now = 10_000;
    const log = new ActivityLog({
      clock: { now: () => now, setTimer: () => 0, clearTimer: () => {} },
    });
    log.record("info", "before the correction");
    now = 500;
    log.record("info", "after the correction");
    const seqs = log.entries().map((e) => e.seq);
    expect(seqs[1]).toBeGreaterThan(seqs[0] ?? 0);
  });

  it("returns only what a reader has not seen", () => {
    const log = new ActivityLog({ clock: stepClock() });
    log.record("info", "one");
    log.record("info", "two");
    const first = log.page(0);
    expect(first.entries).toHaveLength(2);
    log.record("info", "three");
    const next = log.page(first.newestSeq);
    expect(next.entries.map((e) => e.message)).toEqual(["three"]);
  });

  it("never reuses a sequence number after entries are discarded", () => {
    const log = new ActivityLog({ capacity: 2, clock: stepClock() });
    for (const n of [1, 2, 3, 4, 5]) log.record("info", `line ${n}`);
    expect(log.entries().map((e) => e.seq)).toEqual([4, 5]);
  });
});

/**
 * This buffer is served to a browser, so a credential in it is a credential on
 * a screen. `secrets/redact.ts` is the one list and this uses it — at the
 * point of capture, so the value is not in the buffer at all rather than being
 * in it and filtered on the way out by a route somebody could add a second
 * copy of (R-SEC-10).
 */
describe("what the activity log refuses to hold", () => {
  it("redacts a registered secret value, in whatever line carries it", () => {
    guardSecretValue("correct-horse-battery");
    const log = new ActivityLog({ clock: stepClock() });
    // A sentence that names nothing and matches no pattern. This is the line a
    // future caller writes, and the reason values are registered at all.
    log.record("info", "joining home-network with correct-horse-battery");
    expect(log.entries()[0]?.message).not.toContain("correct-horse-battery");
    expect(log.entries()[0]?.message).toContain(REDACTED);
  });

  it("redacts a psk written as a named value, even one never registered", () => {
    const log = new ActivityLog({ clock: stepClock() });
    log.record("warn", "nmcli failed: 802-11-wireless-security.psk: hunter2-and-more");
    log.record("warn", "psk=another-one-entirely");
    const messages = log.entries().map((e) => e.message).join("\n");
    expect(messages).not.toContain("hunter2-and-more");
    expect(messages).not.toContain("another-one-entirely");
  });

  it("hands back the line it stored, so the journal and the page agree", () => {
    guardSecretValue("a-real-passphrase");
    const log = new ActivityLog({ clock: stepClock() });
    const returned = log.record("warn", "could not join with a-real-passphrase");
    expect(returned).toBe(log.entries()[0]?.message);
    expect(returned).not.toContain("a-real-passphrase");
  });
});

/**
 * The buffer is only useful if the calls that already exist feed it. A second
 * stream callers must remember to write to is a page that is silent about the
 * one event nobody remembered.
 */
describe("warn and note", () => {
  it("both reach the process-wide buffer, with the right level", () => {
    note("the console is being written");
    warn("the console could not be restarted");
    expect(activityLog.entries().map((e) => ({ level: e.level, message: e.message }))).toEqual([
      { level: "info", message: "the console is being written" },
      { level: "warn", message: "the console could not be restarted" },
    ]);
  });

  it("redacts a registered value before either the journal or the buffer sees it", () => {
    guardSecretValue("supersecretpsk");
    warn("could not apply: 802-11-wireless-security.psk supersecretpsk rejected");
    const message = activityLog.entries()[0]?.message ?? "";
    expect(message).not.toContain("supersecretpsk");
    expect(message).toContain(REDACTED);
  });
});
