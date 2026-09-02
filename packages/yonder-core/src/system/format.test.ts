// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  UNKNOWN,
  displayFacts,
  formatLoad,
  formatMemory,
  formatTemperature,
  formatUptime,
} from "./format.js";
import type { BoardFacts } from "./facts.js";

const PI4: BoardFacts = {
  model: "Raspberry Pi 4 Model B Rev 1.5",
  load: { one: 0.52, five: 0.58, fifteen: 0.59, runnable: 1, total: 342 },
  memory: {
    totalBytes: 926816 * 1024,
    availableBytes: 742932 * 1024,
    freeBytes: 444584 * 1024,
    usedBytes: (926816 - 742932) * 1024,
  },
  uptimeSeconds: 41.83,
  cpuTemperatureC: 58,
};

const NOTHING: BoardFacts = {
  model: null, load: null, memory: null, uptimeSeconds: null, cpuTemperatureC: null,
};

describe("formatUptime", () => {
  it("reads a board that has just started", () => {
    expect(formatUptime(41.83)).toBe("41 seconds");
    expect(formatUptime(1)).toBe("1 second");
    expect(formatUptime(0)).toBe("0 seconds");
  });

  /**
   * The third unit has never been the reason somebody was looking at an
   * uptime, and a status line that wraps is one that is harder to scan.
   */
  it("shows the largest two units and stops", () => {
    expect(formatUptime(190_000)).toBe("2 days 4 hours");
    expect(formatUptime(3_600 + 61)).toBe("1 hour 1 minute");
    expect(formatUptime(7_200)).toBe("2 hours 0 minutes");
    expect(formatUptime(125)).toBe("2 minutes 5 seconds");
  });

  it("says unknown rather than showing a blank or a nonsense number", () => {
    expect(formatUptime(null)).toBe(UNKNOWN);
    expect(formatUptime(-1)).toBe(UNKNOWN);
    expect(formatUptime(Number.NaN)).toBe(UNKNOWN);
  });
});

describe("formatMemory", () => {
  it("reports a 905 MB board the way an operator reads it", () => {
    expect(formatMemory(PI4.memory)).toBe("180 MB of 905 MB used (20%)");
  });

  it("reports only the total when the kernel gave no MemAvailable", () => {
    expect(formatMemory({
      totalBytes: 926816 * 1024, availableBytes: null, freeBytes: null, usedBytes: null,
    })).toBe("905 MB total");
  });

  it("says unknown for a board that reported nothing", () => {
    expect(formatMemory(null)).toBe(UNKNOWN);
  });
});

describe("formatLoad and formatTemperature", () => {
  it("shows the three averages in the order they are conventionally read", () => {
    expect(formatLoad(PI4.load)).toBe("0.52, 0.58, 0.59");
  });

  it("keeps one decimal on a temperature, which is what the sensor justifies", () => {
    expect(formatTemperature(58)).toBe("58.0 °C");
    expect(formatTemperature(47.6)).toBe("47.6 °C");
  });

  /**
   * A fabricated 0 °C reads as a cold board. A board with no thermal zone has
   * to say so.
   */
  it("says unknown rather than zero for a sensor that is not there", () => {
    expect(formatTemperature(null)).toBe(UNKNOWN);
    expect(formatLoad(null)).toBe(UNKNOWN);
  });
});

describe("displayFacts", () => {
  it("turns a board into strings a widget can bind without arithmetic", () => {
    expect(displayFacts(PI4, { yonder: "0.1.0", os: "Debian GNU/Linux 13 (trixie)" })).toEqual({
      model: "Raspberry Pi 4 Model B Rev 1.5",
      load: "0.52, 0.58, 0.59",
      memory: "180 MB of 905 MB used (20%)",
      uptime: "41 seconds",
      temperature: "58.0 °C",
      yonder: "0.1.0",
      os: "Debian GNU/Linux 13 (trixie)",
    });
  });

  /**
   * An empty cell on a status page reads as "this page is broken" rather than
   * "this board has no thermal sensor". One word, and the same word.
   */
  it("says unknown for every field a board did not report, never a blank", () => {
    const display = displayFacts(NOTHING, { yonder: null, os: null });
    for (const [field, value] of Object.entries(display)) {
      expect(value, field).toBe(UNKNOWN);
    }
  });
});
