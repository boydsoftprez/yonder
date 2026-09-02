// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { FAILURES_TO_STAND_DOWN, SUCCESSES_TO_RETURN, Standing, type PathName } from "./standing.js";

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

  it("names what traffic moved to, not what it will move to", () => {
    // R-NET-13 asks the entry to name what failed, what traffic moved to, and
    // when. The line used to promise "traffic will use the next path that
    // works" while nothing moved traffic at all — an aircraft's journal
    // asserting a thing that did not happen.
    const { clock } = fixedClock();
    const lines: string[] = [];
    const s = new Standing({
      clock, log: (l) => lines.push(l), order: () => ["ethernet", "modem"],
    });
    s.record("modem", true);
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    const line = lines.find((l) => /stood down/.test(l)) ?? "";
    expect(line).toMatch(/ethernet/);
    expect(line).toMatch(/traffic moves to cellular/);
    expect(line).toMatch(/1970-01-01T00:00:01\.000Z/);
    expect(line).not.toMatch(/will/);
  });

  it("does not claim a move when there is nowhere to move to", () => {
    // The board with one path, or with every path stood down. A metric is not
    // a disconnect: the route it has stays, and the operator must read that
    // rather than a sentence about traffic going somewhere there is nowhere
    // to go.
    const { clock } = fixedClock();
    const lines: string[] = [];
    const s = new Standing({ clock, log: (l) => lines.push(l), order: () => ["ethernet", "modem"] });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("modem", false);
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    const line = lines.filter((l) => /ethernet.*stood down/.test(l))[0] ?? "";
    expect(line).toMatch(/no other path reaching anything/);
    expect(line).not.toMatch(/traffic moves to/);
  });

  it("says where traffic ends up when a path comes back", () => {
    const { clock } = fixedClock();
    const lines: string[] = [];
    const s = new Standing({ clock, log: (l) => lines.push(l), order: () => ["ethernet", "modem"] });
    s.record("modem", true);
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    s.record("ethernet", true);
    const line = lines.filter((l) => /reaching the internet again/.test(l))[0] ?? "";
    // Ethernet outranks the modem, so traffic really does come back to it.
    expect(line).toMatch(/traffic moves back to it/);
  });

  it("asks for the route metrics to be rewritten once in each direction", () => {
    // The edge, not the tick. A re-metric on every probe would put three
    // nmcli commands on a board every five seconds for as long as a path
    // stayed broken; one that never fired would leave a stood-down path
    // holding the default route indefinitely, which is the whole of R-NET-13
    // that used not to exist.
    const { clock } = fixedClock();
    const changes: [PathName, boolean][] = [];
    const s = new Standing({ clock, onChange: (path, down) => changes.push([path, down]) });

    for (let i = 0; i < FAILURES_TO_STAND_DOWN * 3; i++) s.record("ethernet", false);
    expect(changes).toEqual([["ethernet", true]]);

    for (let i = 0; i < 5; i++) s.record("ethernet", true);
    expect(changes).toEqual([["ethernet", true], ["ethernet", false]]);
  });

  it("says nothing to anyone about a probe that changed nothing", () => {
    const { clock } = fixedClock();
    let changes = 0;
    const s = new Standing({ clock, onChange: () => { changes += 1; } });
    for (let i = 0; i < 20; i++) s.record("modem", true);
    // One failure short of the threshold, then a success. Nothing moved.
    for (let i = 0; i < FAILURES_TO_STAND_DOWN - 1; i++) s.record("modem", false);
    s.record("modem", true);
    expect(changes).toBe(0);
  });

  it("does not let a failed re-metric end the probe it came from", () => {
    // The listener writes route metrics through nmcli. A throw out of record()
    // would abandon the rest of the tick, including the tests of the
    // alternatives that establish which path can take over.
    const { clock } = fixedClock();
    const lines: string[] = [];
    const s = new Standing({
      clock,
      log: (l) => lines.push(l),
      onChange: () => { throw new Error("nmcli exited 1"); },
    });
    for (let i = 0; i < FAILURES_TO_STAND_DOWN; i++) s.record("ethernet", false);
    expect(s.standingOf("ethernet")).toBe("no-route-out");
    expect(lines.some((l) => /nmcli exited 1/.test(l))).toBe(true);
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
