// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { reading } from "yonder-core";
import {
  QUALITY_BOUNDS,
  SIGNAL_BOUNDS,
  formatDb,
  formatDbm,
  formatTechnology,
  verdict,
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
