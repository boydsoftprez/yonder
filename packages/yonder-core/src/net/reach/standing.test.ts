// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { FAILURES_TO_STAND_DOWN, SUCCESSES_TO_RETURN, Standing } from "./standing.js";

function fixedClock(start = 1_000) {
  let now = start;
  return { clock: { now: () => now, setTimer: () => 0, clearTimer: () => {} },
    advance: (ms: number) => { now += ms; } };
}

describe("Standing", () => {
  it("does not move on a single failure", () => {
    // A carrier hiccup must not move an aircraft. This is the whole reason
    // hysteresis exists here rather than a bare boolean.
    const { clock } = fixedClock();
    const s = new Standing({ clock });
    s.record("modem", false);
    expect(s.standingOf("modem")).not.toBe("no-route-out");
  });

  it("stands a path down after repeated failure", () => {
    const { clock } = fixedClock();
    const s = new Standing({ clock });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    expect(s.standingOf("ethernet")).toBe("no-route-out");
  });

  it("brings it back faster than it took it down", () => {
    // Slow to move, quick to return: the cost of being wrong in one direction
    // is a path nobody is using, and in the other it is an aircraft.
    const { clock } = fixedClock();
    const s = new Standing({ clock });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    for (let i = 0; i < SUCCESSES_TO_RETURN; i++) s.record("ethernet", true);
    expect(s.standingOf("ethernet")).not.toBe("no-route-out");
    expect(SUCCESSES_TO_RETURN).toBeLessThan(FAILURES_TO_STAND_DOWN);
  });

  it("forgets the failures once a path succeeds", () => {
    const { clock } = fixedClock();
    const s = new Standing({ clock });
    s.record("modem", false);
    s.record("modem", false);
    s.record("modem", true);
    s.record("modem", false);
    expect(s.standingOf("modem")).not.toBe("no-route-out");
  });

  it("records when a path was stood down", () => {
    const { clock, advance } = fixedClock();
    const s = new Standing({ clock });
    advance(5_000);
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    expect(s.since("ethernet")).toBe(6_000);
  });

  it("writes a sentence naming what happened, both ways", () => {
    // R-NET-13: an aircraft that changes how it is reachable while nobody is
    // watching must leave a trail that explains itself.
    const { clock } = fixedClock();
    const lines: string[] = [];
    const s = new Standing({ clock, log: (l) => lines.push(l) });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    s.record("ethernet", true);
    expect(lines.some((l) => /ethernet.*stood down/i.test(l))).toBe(true);
    expect(lines.some((l) => /ethernet.*back/i.test(l))).toBe(true);
  });

  it("says nothing while nothing changes", () => {
    // A log line per probe would bury the two that matter.
    const { clock } = fixedClock();
    const lines: string[] = [];
    const s = new Standing({ clock, log: (l) => lines.push(l) });
    for (let i = 0; i < 20; i++) s.record("modem", true);
    expect(lines).toEqual([]);
  });
});
