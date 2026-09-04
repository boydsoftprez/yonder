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

describe("a quantity where higher is better", () => {
  // Signal strength, in dBm. -120 is the floor of the scale, -70 the top;
  // below -105 is bad and below -90 is marginal. These are the values the
  // cellular console uses.
  const SIGNAL = { min: -120, max: -70, caution: -90, limit: -105, sense: "higher-is-better" } as const;

  it("is good above the caution", () => {
    expect(reading(-85, SIGNAL).tone).toBe("good");
  });

  it("is waiting at and below the caution", () => {
    // At, not past: a threshold an operator was told about announces itself
    // when it is reached, which is the same rule the other direction uses.
    expect(reading(-90, SIGNAL).tone).toBe("waiting");
    expect(reading(-99, SIGNAL).tone).toBe("waiting");
  });

  it("is bad at and below the limit", () => {
    expect(reading(-105, SIGNAL).tone).toBe("bad");
    expect(reading(-118, SIGNAL).tone).toBe("bad");
  });

  it("fills more as the value rises, not less", () => {
    // The fill is the value's position on its own scale and does not change
    // with the sense. A stronger signal must draw a fuller bar; the sense
    // decides which end is alarming, not which way the bar grows.
    expect(reading(-75, SIGNAL).fraction).toBeGreaterThan(reading(-110, SIGNAL).fraction);
  });

  it("puts the thresholds where they are on the scale, whichever sense applies", () => {
    const r = reading(-99, SIGNAL);
    expect(r.limitAt).toBeCloseTo(0.30, 2);
    expect(r.cautionAt).toBeCloseTo(0.60, 2);
  });

  it("carries the sense through so a component can draw it", () => {
    expect(reading(-99, SIGNAL).sense).toBe("higher-is-better");
  });
});

describe("the default sense", () => {
  it("is higher-is-worse, so every existing caller is unchanged", () => {
    // CPU temperature: 80 is the throttle point, 60 the caution.
    const TEMP = { min: 0, max: 100, caution: 60, limit: 80 };
    expect(reading(51, TEMP).tone).toBe("good");
    expect(reading(65, TEMP).tone).toBe("waiting");
    expect(reading(85, TEMP).tone).toBe("bad");
    expect(reading(51, TEMP).sense).toBe("higher-is-worse");
  });
});
