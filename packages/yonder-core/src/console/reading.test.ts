// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { reading } from "./reading.js";

/** The board this was written against: caution 60, throttles 80, ceiling 85. */
const CPU_TEMP = { max: 85, caution: 60, limit: 80 };

describe("reading", () => {
  it("places a value on its scale as a clamped fraction", () => {
    expect(reading(0, CPU_TEMP).fraction).toBe(0);
    expect(reading(85, CPU_TEMP).fraction).toBe(1);
    expect(reading(42.5, CPU_TEMP).fraction).toBeCloseTo(0.5, 5);
  });

  it("clamps a sensor that reads past either end rather than drawing off the scale", () => {
    expect(reading(120, CPU_TEMP).fraction).toBe(1);
    expect(reading(-10, CPU_TEMP).fraction).toBe(0);
  });

  it("places the thresholds on the same scale, so a page draws them without arithmetic", () => {
    const r = reading(62.4, CPU_TEMP);
    expect(r.cautionAt).toBeCloseTo(60 / 85, 5);
    expect(r.limitAt).toBeCloseTo(80 / 85, 5);
  });

  it("honours a non-zero floor", () => {
    const r = reading(15, { min: 10, max: 20 });
    expect(r.fraction).toBeCloseTo(0.5, 5);
    expect(r.min).toBe(10);
  });

  describe("tone", () => {
    it("is good below caution", () => {
      expect(reading(45, CPU_TEMP).tone).toBe("good");
    });

    it("announces itself at the threshold, not one sample after it", () => {
      expect(reading(59.9, CPU_TEMP).tone).toBe("good");
      expect(reading(60, CPU_TEMP).tone).toBe("waiting");
      expect(reading(79.9, CPU_TEMP).tone).toBe("waiting");
      expect(reading(80, CPU_TEMP).tone).toBe("bad");
    });

    it("is waiting between caution and limit", () => {
      expect(reading(62.4, CPU_TEMP).tone).toBe("waiting");
    });

    it("is good below a caution when no limit is configured", () => {
      expect(reading(5, { max: 100, caution: 80 }).tone).toBe("good");
      expect(reading(90, { max: 100, caution: 80 }).tone).toBe("waiting");
    });

    it("is neutral when nobody has set a threshold, rather than claiming health", () => {
      // A quantity with a ceiling but no bands has not been judged. Reporting
      // it as good would be an answer this module does not have.
      expect(reading(50, { max: 100 }).tone).toBe("neutral");
    });
  });

  describe("a value that is not there", () => {
    it("renders empty and unjudged rather than as a confident zero", () => {
      const r = reading(Number.NaN, CPU_TEMP);
      expect(r.fraction).toBe(0);
      expect(r.tone).toBe("neutral");
      expect(Number.isNaN(r.value)).toBe(true);
    });

    it("treats an infinite reading the same way", () => {
      expect(reading(Number.POSITIVE_INFINITY, CPU_TEMP).tone).toBe("neutral");
    });

    it("keeps the bounds, so the scale still draws while the value does not", () => {
      const r = reading(Number.NaN, CPU_TEMP);
      expect(r.max).toBe(85);
      expect(r.caution).toBe(60);
      expect(r.limit).toBe(80);
    });
  });

  it("does not divide by zero when the bounds are degenerate", () => {
    expect(reading(5, { min: 10, max: 10 }).fraction).toBe(0);
    expect(reading(5, { min: 20, max: 10 }).fraction).toBe(0);
  });
});
