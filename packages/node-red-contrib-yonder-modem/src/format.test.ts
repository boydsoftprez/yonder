// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { reading } from "yonder-core";
import {
  QUALITY_BOUNDS,
  SIGNAL_BOUNDS,
  cannotTell,
  formatDb,
  formatDbm,
  formatTechnology,
  pathStanding,
  pathStatus,
  reachStatus,
  reachWhy,
  verdict,
  verdictStatus,
} from "./format.js";

describe("the signal bounds", () => {
  it("are the standard cellular thresholds, higher-is-better", () => {
    expect(SIGNAL_BOUNDS.caution).toBe(-90);
    expect(SIGNAL_BOUNDS.limit).toBe(-105);
    expect(SIGNAL_BOUNDS.sense).toBe("higher-is-better");
  });

  it("put a working bench board in the marginal band, which is the truth", () => {
    // The board this was designed against reads -99 to -103 dBm and works.
    // Marginal is the honest answer for a bench with a small antenna, and a
    // calibration that flattered it would make the amber band meaningless.
    expect(reading(-99, SIGNAL_BOUNDS).tone).toBe("waiting");
    expect(reading(-85, SIGNAL_BOUNDS).tone).toBe("good");
    expect(reading(-110, SIGNAL_BOUNDS).tone).toBe("bad");
  });

  it("puts a quality of 16 dB in the good band", () => {
    expect(reading(16, QUALITY_BOUNDS).tone).toBe("good");
    expect(reading(6, QUALITY_BOUNDS).tone).toBe("waiting");
    expect(reading(-2, QUALITY_BOUNDS).tone).toBe("bad");
  });
});

describe("formatting a measurement that may not exist", () => {
  it("says so rather than printing a number that was never taken", () => {
    // 0 dBm is a real and extraordinary reading. Printing it for "unknown"
    // would show a perfect signal on a device that has none.
    expect(formatDbm(null)).toBe("—");
    expect(formatDb(null)).toBe("—");
  });

  it("carries the unit, because a bare number is not a reading", () => {
    expect(formatDbm(-99)).toBe("-99 dBm");
    expect(formatDb(16)).toBe("16 dB");
  });
});

describe("the verdict", () => {
  const path = (over = {}) => ({
    path: "modem" as const, device: "wwan0", standing: "standing-by" as const,
    since: null, evidence: "reaching" as const, detail: "", ...over,
  });

  it("is carrying traffic when the modem is the path in use", () => {
    const v = verdict({ inUse: "modem", carrying: true, paths: [path({ standing: "in-use" })] });
    expect(v.tone).toBe("good");
    expect(v.text).toBe("CARRYING TRAFFIC");
  });

  it("is no data getting through when the modem reached nothing", () => {
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [path({ standing: "no-route-out" })] });
    expect(v.tone).toBe("bad");
    expect(v.text).toBe("NO DATA GETTING THROUGH");
  });

  it("does not claim anything about a path nobody has tested", () => {
    // The distinction the fallback watchdog had to learn, at the display
    // layer: not yet condemned is not the same as working.
    //
    // Asked of `evidence` and never of `detail`. This used to be a substring
    // match against the sentence an operator reads, which made that sentence
    // impossible to reword without breaking the verdict above it.
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [path({ evidence: "untested" })] });
    expect(v.tone).toBe("neutral");
    expect(v.text).toBe("NOT YET TESTED");
  });

  it("is not ready when the last probe reached nothing, condemned or not", () => {
    // Still in the running — it has not run out FAILURES_TO_STAND_DOWN — but
    // its last probe reached nothing, and the Way out row about the same path
    // says exactly that. READY here would put the two in contradiction.
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [path({ evidence: "not-reaching" })] });
    expect(v.tone).toBe("bad");
  });

  it("is ready only on evidence that something got through", () => {
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [path({ evidence: "reaching" })] });
    expect(v.tone).toBe("good");
    expect(v.text).toBe("READY");
  });

  it("reads no wording at all, so detail can be reworded freely", () => {
    // The regression this field exists to prevent: the sentence changed once
    // during this milestone and took the verdict with it.
    const reworded = path({ evidence: "untested", detail: "Anything at all, in any words" });
    expect(verdict({ inUse: "ethernet", carrying: true, paths: [reworded] }).text)
      .toBe("NOT YET TESTED");
  });

  it("says a modem is absent rather than broken when there is none", () => {
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [] });
    expect(v.tone).toBe("neutral");
    expect(v.text).toBe("NO MODEM");
  });

  /**
   * The other way a board says it has no modem, and the one that was missed.
   *
   * The daemon omits the path only when configuration does not name a modem.
   * When it names one and no interface is there, the path is *reported* with
   * `standing: "absent"` — so a board with the modem enabled and nothing
   * plugged in fell through to the evidence checks and read `NOT YET TESTED`,
   * which promises that testing would tell you something. Visible in the
   * console capture at the time it was written.
   */
  it("says the same when the path is reported and there is no interface", () => {
    const gone = path({ standing: "absent" as const, device: null, evidence: "untested" as const });
    const v = verdict({ inUse: "ethernet", carrying: true, paths: [gone] });
    expect(v.tone).toBe("neutral");
    expect(v.text).toBe("NO MODEM");
  });
});

/**
 * The word beside a `Way out` row's lamp (R-UI-11).
 *
 * `standing` alone cannot produce it — `standing-by` covers three quite
 * different situations — which is the whole reason `evidence` exists.
 */
describe("a path's standing, in a word", () => {
  it("names the three states the panel exists to tell apart", () => {
    expect(pathStanding("standing-by", "reaching")).toBe("READY");
    expect(pathStanding("standing-by", "not-reaching")).toBe("NOT REACHING");
    expect(pathStanding("standing-by", "untested")).toBe("NOT YET TESTED");
  });

  /**
   * An interface that is not on the board is not a fault, and it has no
   * evidence either way — so it is answered before evidence is consulted,
   * exactly as `pathTone` answers it.
   */
  it("says an interface is absent whatever the record still holds about it", () => {
    for (const e of ["reaching", "not-reaching", "untested"] as const) {
      expect(pathStanding("absent", e)).toBe("NO INTERFACE");
    }
  });

  it("says a stood-down path is stood down, not merely not reaching", () => {
    expect(pathStanding("no-route-out", "not-reaching")).toBe("STOOD DOWN");
    expect(pathStanding("testing", "untested")).toBe("TESTING");
  });

  /**
   * Carrying traffic is what the routing table says. It is said whether or
   * not anything has tested the link; the lamp beside it is what stays
   * neutral until something has (R-CEL-09).
   */
  it("says a path in use is carrying traffic even before anything tested it", () => {
    expect(pathStanding("in-use", "untested")).toBe("CARRYING TRAFFIC");
    expect(pathStanding("in-use", "reaching")).toBe("CARRYING TRAFFIC");
  });
});

/**
 * The same row, as `ui-yonder-annunciator` reads it. The tone is *taken* from
 * the row rather than worked out again here: deciding it twice is how the
 * lamp on this panel and the lamp on the Cellular tab end up disagreeing
 * about one link.
 */
describe("a Way out row, as the annunciator reads it", () => {
  it("lights a reaching path good, with the standing as its words", () => {
    const s = pathStatus(
      { standing: "standing-by", evidence: "reaching", tone: "good" }, 1000,
    );
    expect(s.state).toBe("confirmed");
    expect(s.message).toBe("READY");
    expect(s.at).toBe(1000);
  });

  it("lights a path that reached nothing bad", () => {
    expect(pathStatus({ standing: "no-route-out", evidence: "not-reaching", tone: "bad" }, 1).state)
      .toBe("rejected");
  });

  it("leaves an untested path neutral rather than claiming it works", () => {
    const s = pathStatus({ standing: "standing-by", evidence: "untested", tone: "neutral" }, 1);
    expect(s.state).toBe("idle");
    // Never the shared idle label "Ready": nothing has established anything.
    expect(s.message).toBe("NOT YET TESTED");
  });

  /**
   * The tone is the row's, not a second reading of `standing`. If this ever
   * re-derived it, a row whose tone the daemon had settled would be redrawn
   * from a rule that had drifted from `pathTone`.
   */
  it("uses the tone it was given rather than deciding one for itself", () => {
    const s = pathStatus({ standing: "in-use", evidence: "untested", tone: "neutral" }, 1);
    expect(s.state).toBe("idle");
    expect(s.message).toBe("CARRYING TRAFFIC");
  });
});

describe("a radio technology", () => {
  it("is shown as the initialism it is, not as the identifier mmcli reports", () => {
    expect(formatTechnology("lte")).toBe("LTE");
    expect(formatTechnology("5gnr")).toBe("5GNR");
  });

  it("stays absent when the modem did not say, rather than becoming an empty string", () => {
    expect(formatTechnology(null)).toBeNull();
    expect(formatTechnology("")).toBeNull();
  });
});

/**
 * The verdict has to reach `ui-yonder-annunciator`, which renders a
 * `CommandStatus` and nothing else. This is where the tone becomes a state,
 * so that no `change` node in `flows.json` has to (CLAUDE.md rule 2).
 */
describe("the verdict, as the annunciator reads it", () => {
  it("lights a link that is carrying traffic as good", () => {
    const s = verdictStatus({ text: "CARRYING TRAFFIC", tone: "good" }, 1000);
    expect(s.state).toBe("confirmed");
    expect(s.message).toBe("CARRYING TRAFFIC");
    expect(s.at).toBe(1000);
  });

  it("lights a link nothing is getting through as bad", () => {
    expect(verdictStatus({ text: "NO DATA GETTING THROUGH", tone: "bad" }, 1).state)
      .toBe("rejected");
  });

  /**
   * An untested path is neutral and never good: a green lamp on the strength
   * of nobody having shown otherwise is the mistake this verdict exists to
   * avoid (R-CEL-09).
   */
  it("leaves an untested link neutral rather than claiming it works", () => {
    const s = verdictStatus({ text: "NOT YET TESTED", tone: "neutral" }, 1);
    expect(s.state).toBe("idle");
    expect(s.message).toBe("NOT YET TESTED");
  });

  it("carries the verdict's own words, so the lamp does not say Confirmed", () => {
    for (const tone of ["good", "bad", "neutral"] as const) {
      expect(verdictStatus({ text: "NO MODEM", tone }, 1).message).toBe("NO MODEM");
    }
  });
});

/**
 * The Status page's one-word answer (R-UI-11).
 *
 * `reachableBy` is settled in `messageFor`; the only judgement here is the
 * lamp beside it, and it comes off `carrying` rather than off matching the
 * word — a second rule for what `NOTHING` means is the one that stops
 * agreeing with the first.
 */
describe("how the aircraft is reachable, as the annunciator reads it", () => {
  it("lights the path that is carrying traffic", () => {
    expect(reachStatus("CELLULAR", true, 90)).toEqual({
      state: "confirmed", message: "CELLULAR", at: 90,
    });
  });

  /**
   * Nothing getting off the board is a fault and is drawn as one. The console
   * being readable over the access point is not evidence that the aircraft is
   * reachable, which is the whole question this panel answers.
   */
  it("draws nothing at all as a fault, not as a quiet neutral", () => {
    expect(reachStatus("NOTHING", false, 90)).toEqual({
      state: "rejected", message: "NOTHING", at: 90,
    });
  });

  it("never invents a word of its own", () => {
    for (const word of ["ETHERNET", "CELLULAR", "WI-FI"]) {
      expect(reachStatus(word, true, 1).message).toBe(word);
    }
  });
});

/**
 * A lamp on a tick the daemon could not answer.
 *
 * The defect: with no status on `msg.yonder` the annunciator falls back to
 * `presentation("idle")`, whose shared label is `Ready`. Nothing claims
 * success and the tone is neutral, but the word is wrong at exactly the
 * moment words matter.
 */
describe("a lamp that cannot tell", () => {
  it("says so, and does not say Ready", () => {
    const s = cannotTell(7);
    expect(s.message).toBe("CANNOT TELL");
    expect(s.message).not.toBe("Ready");
    expect(s.at).toBe(7);
  });

  /**
   * Red, and for one reason: the Cellular tab already draws this same failure
   * red through `readFailure`. Two surfaces describing one event have to agree
   * about how bad it is — and neutral is the lamp an ordinary `NOT YET TESTED`
   * path wears on a perfectly healthy board.
   */
  it("agrees with the Cellular tab about how bad a daemon that stopped answering is", () => {
    expect(cannotTell(7).state).toBe("rejected");
    expect(cannotTell(7).state).not.toBe("idle");
  });
});

/**
 * The line under the one-word answer.
 *
 * The lamp says *what* is carrying traffic; this says *why it is not the
 * other one*, which is the half a fallback is actually about. It replaced the
 * modem's own `summary`, which said "Connected to Dark Star" under a lamp
 * reading `NOTHING` — a console contradicting itself on one line.
 */
describe("what changed, and when", () => {
  const row = (over: Partial<Parameters<typeof reachWhy>[0][number]>) => ({
    name: "Ethernet", standing: "standing-by" as const, since: null, inUse: false, ...over,
  });

  /**
   * A local time, built with the local-time constructor so this says the same
   * thing on a laptop in London and a runner in UTC.
   */
  const at = (h: number, m: number) => new Date(2026, 8, 3, h, m).getTime();

  it("names the path that stood down, and the minute it happened", () => {
    expect(reachWhy([
      row({ name: "Ethernet", standing: "no-route-out", since: at(14, 22) }),
      row({ name: "Cellular", inUse: true }),
    ])).toBe("Ethernet stood down at 14:22");
  });

  it("pads a single-digit hour and minute, so the column does not jump", () => {
    expect(reachWhy([row({ standing: "no-route-out", since: at(9, 5) })]))
      .toBe("Ethernet stood down at 09:05");
  });

  /**
   * The event that moved the answer is the most recent one. An older outage
   * on a second path is not the news.
   */
  it("reports the most recent one when two paths are down", () => {
    expect(reachWhy([
      row({ name: "Ethernet", standing: "no-route-out", since: at(14, 22) }),
      row({ name: "Wi-Fi", standing: "no-route-out", since: at(15, 40) }),
    ])).toBe("Wi-Fi stood down at 15:40");
  });

  it("says what is carrying traffic when nothing has been taken out of the running", () => {
    expect(reachWhy([row({ name: "Cellular", standing: "in-use", inUse: true })]))
      .toBe("Cellular is carrying traffic, and nothing has stood down");
  });

  /**
   * The state this project's own capture harness is in: every path up, nothing
   * tested, nothing holding a route. The lamp reads NOTHING and this says why
   * without claiming a fault that has not happened.
   */
  it("says so when nothing has stood down and nothing is carrying either", () => {
    expect(reachWhy([row({}), row({ name: "Cellular" })]))
      .toBe("Nothing has stood down, and nothing is carrying traffic");
  });

  /**
   * A path that is not on this board has no standing to report, so it cannot
   * be the subject of this line — including when it is the only entry.
   */
  it("ignores a path this board does not have", () => {
    expect(reachWhy([
      row({ name: "Ethernet", standing: "absent" }),
      row({ name: "Cellular", standing: "in-use", inUse: true }),
    ])).toBe("Cellular is carrying traffic, and nothing has stood down");
    expect(reachWhy([row({ standing: "absent" })])).toBe("There is no way out on this board");
    expect(reachWhy([])).toBe("There is no way out on this board");
  });
});
