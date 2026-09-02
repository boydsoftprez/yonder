// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { AttemptThrottle, FAILURE_LIMIT, LOCKOUT_MS } from "./throttle.js";
import type { Clock } from "../apply/types.js";

/** A clock a test moves by hand. Nothing here may wait on the wall clock. */
function fakeClock(): Clock & { advance(ms: number): void } {
  let t = 1_000_000;
  return {
    now: () => t,
    setTimer: () => { throw new Error("the throttle must not arm a timer"); },
    clearTimer: () => { throw new Error("the throttle must not arm a timer"); },
    advance(ms: number) { t += ms; },
  };
}

describe("AttemptThrottle", () => {
  it("allows attempts until the limit is reached", () => {
    const clock = fakeClock();
    const t = new AttemptThrottle({ clock });
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      expect(t.check().allowed, `attempt ${i + 1} was refused`).toBe(true);
      t.record(false);
    }
    expect(t.check().allowed).toBe(false);
  });

  it("says how long is left, in whole seconds", () => {
    const clock = fakeClock();
    const t = new AttemptThrottle({ clock });
    for (let i = 0; i < FAILURE_LIMIT; i++) t.record(false);

    const refused = t.check();
    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false ? refused.retryAfter : 0).toBe(LOCKOUT_MS / 1000);

    clock.advance(30_000);
    const half = t.check();
    expect(half.allowed === false ? half.retryAfter : 0).toBe(30);
  });

  it("allows again once the lockout has run out", () => {
    const clock = fakeClock();
    const t = new AttemptThrottle({ clock });
    for (let i = 0; i < FAILURE_LIMIT; i++) t.record(false);
    expect(t.check().allowed).toBe(false);

    clock.advance(LOCKOUT_MS - 1);
    expect(t.check().allowed).toBe(false);
    clock.advance(1);
    expect(t.check().allowed).toBe(true);
  });

  /**
   * A fresh five, not one at a time. Someone who mistyped five times and
   * waited a minute expects to be able to try again properly; someone
   * guessing still pays a minute for every five guesses either way.
   */
  it("gives a full allowance back after a lockout, not a single attempt", () => {
    const clock = fakeClock();
    const t = new AttemptThrottle({ clock });
    for (let i = 0; i < FAILURE_LIMIT; i++) t.record(false);
    clock.advance(LOCKOUT_MS);

    for (let i = 0; i < FAILURE_LIMIT; i++) {
      expect(t.check().allowed, `attempt ${i + 1} after the lockout was refused`).toBe(true);
      t.record(false);
    }
    expect(t.check().allowed).toBe(false);
  });

  it("counts consecutive failures, so a success in the middle resets it", () => {
    const clock = fakeClock();
    const t = new AttemptThrottle({ clock });
    t.record(false);
    t.record(false);
    t.record(false);
    t.record(false);
    expect(t.consecutiveFailures).toBe(4);
    t.record(true);
    expect(t.consecutiveFailures).toBe(0);

    // Four more would have tripped the old count. They do not.
    for (let i = 0; i < 4; i++) t.record(false);
    expect(t.check().allowed).toBe(true);
  });

  it("clears a lockout when the right password finally arrives", () => {
    const clock = fakeClock();
    const t = new AttemptThrottle({ clock });
    for (let i = 0; i < FAILURE_LIMIT; i++) t.record(false);
    // A caller that checks first would never get here; recording a success
    // must still be the thing that ends a lockout, so nothing can be left
    // locked out after proving it knows the password.
    t.record(true);
    expect(t.check().allowed).toBe(true);
  });

  it("takes its limit and lockout from the caller", () => {
    const clock = fakeClock();
    const t = new AttemptThrottle({ clock, limit: 2, lockoutMs: 5_000 });
    t.record(false);
    expect(t.check().allowed).toBe(true);
    t.record(false);
    expect(t.check().allowed).toBe(false);
    clock.advance(5_000);
    expect(t.check().allowed).toBe(true);
  });

  /**
   * No timer, ever. A throttle that armed one would be a thing to stop, and
   * a timer outliving the daemon that owns it is the defect FallbackWatchdog
   * and NetworkRenderer both had to grow a stop() for.
   */
  it("arms no timer", () => {
    const clock = fakeClock();
    const t = new AttemptThrottle({ clock });
    expect(() => {
      for (let i = 0; i < FAILURE_LIMIT + 3; i++) { t.check(); t.record(false); }
      t.check();
      t.record(true);
    }).not.toThrow();
  });
});
