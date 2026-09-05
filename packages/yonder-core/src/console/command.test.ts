// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  confirmed,
  countdown,
  idle,
  pending,
  presentation,
  rejected,
  secondsRemaining,
  type CommandState,
} from "./command.js";

const STATES: CommandState[] = ["idle", "pending", "confirmed", "rejected"];

describe("the command-state language", () => {
  it("has a presentation for every state, and one for each", () => {
    for (const state of STATES) {
      const shown = presentation(state);
      expect(shown.label, state).not.toBe("");
      expect(["neutral", "waiting", "good", "bad"]).toContain(shown.tone);
    }
    // Four states, four distinguishable tones. A control that shows "pending"
    // and "confirmed" the same way has not told the operator anything
    // (R-UI-05).
    expect(new Set(STATES.map((s) => presentation(s).tone)).size).toBe(4);
  });

  /**
   * ADR-0005: pending, confirmed and rejected have to look and behave
   * identically whether they come from a stock widget or a hand-written
   * component. That is only possible if there is one mapping, so this asserts
   * that the mapping is a function of the state and nothing else.
   */
  it("maps a state to the same presentation every time it is asked", () => {
    for (const state of STATES) {
      expect(presentation(state)).toEqual(presentation(state));
    }
  });

  /**
   * A page owns colours, because a day theme and a night theme have different
   * ones for the same meaning (R-UI-07). A colour named here could only ever
   * be right in one of them.
   */
  it("names a register rather than a colour", () => {
    for (const state of STATES) {
      expect(JSON.stringify(presentation(state))).not.toMatch(/#[0-9a-f]{3,6}|rgb|green|red|amber/i);
    }
  });
});

describe("the constructors", () => {
  it("carries the deadline with a pending change, because there is one", () => {
    const status = pending("Applying the network change", {
      at: 1_000, id: "abc", expiresAt: 301_000, movesRadio: true,
    });
    expect(status).toEqual({
      state: "pending",
      message: "Applying the network change",
      at: 1_000,
      id: "abc",
      expiresAt: 301_000,
      movesRadio: true,
    });
  });

  it("omits what it was not given rather than carrying undefined into a page", () => {
    expect(idle(5)).toEqual({ state: "idle", message: "Ready", at: 5 });
    expect(confirmed("Kept", { at: 7 })).toEqual({ state: "confirmed", message: "Kept", at: 7 });
    expect(pending("Waiting", { at: 9 })).toEqual({ state: "pending", message: "Waiting", at: 9 });
  });

  /**
   * The distinction R-UI-05 is about. A control that did something unknown is
   * worse than one that says it failed, so "the daemon did not answer" is a
   * rejection and not a silence.
   */
  it("treats not being able to find out as a rejection", () => {
    const status = rejected(
      "the device's configuration service is not answering; the change was not applied",
      { at: 3 },
    );
    expect(status.state).toBe("rejected");
    expect(presentation(status.state).tone).toBe("bad");
  });
});

describe("secondsRemaining", () => {
  it("counts down a pending change", () => {
    const status = pending("x", { at: 0, expiresAt: 300_000 });
    expect(secondsRemaining(status, 0)).toBe(300);
    expect(secondsRemaining(status, 299_000)).toBe(1);
  });

  /** A page counting down to "-14 s" is showing a number that means nothing. */
  it("is null once the deadline has passed, not a negative number", () => {
    const status = pending("x", { at: 0, expiresAt: 300_000 });
    expect(secondsRemaining(status, 300_000)).toBeNull();
    expect(secondsRemaining(status, 400_000)).toBeNull();
  });

  it("is null for a state that has no deadline", () => {
    expect(secondsRemaining(idle(0), 0)).toBeNull();
    expect(secondsRemaining(confirmed("x", { at: 0 }), 0)).toBeNull();
    expect(secondsRemaining(rejected("x", { at: 0 }), 0)).toBeNull();
    expect(secondsRemaining(pending("x", { at: 0 }), 0)).toBeNull();
  });
});

/**
 * The one number on this console that is about the rollback timer. It is
 * formatted here rather than wherever it is shown, because a console that
 * formatted it in a flow would be a console whose most load-bearing number
 * lived in wiring (CLAUDE.md rule 2).
 */
describe("countdown", () => {
  it("is m:ss, so a two-minute window does not have to be divided to be read", () => {
    const status = pending("x", { at: 0, expiresAt: 300_000 });
    expect(countdown(status, 0)).toBe("5:00");
    expect(countdown(status, 212_000)).toBe("1:28");
    expect(countdown(status, 295_000)).toBe("0:05");
  });

  /** Zero-padded seconds: "1:8" is not a time. */
  it("pads the seconds", () => {
    expect(countdown(pending("x", { at: 0, expiresAt: 68_000 }), 0)).toBe("1:08");
    expect(countdown(pending("x", { at: 0, expiresAt: 9_000 }), 0)).toBe("0:09");
  });

  it("is null wherever secondsRemaining is, so nothing draws a frozen 0:00", () => {
    expect(countdown(pending("x", { at: 0, expiresAt: 300_000 }), 300_000)).toBeNull();
    expect(countdown(idle(0), 0)).toBeNull();
    expect(countdown(confirmed("x", { at: 0 }), 0)).toBeNull();
    expect(countdown(pending("x", { at: 0 }), 0)).toBeNull();
  });
});
