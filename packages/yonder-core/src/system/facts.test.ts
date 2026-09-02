// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  boardFacts,
  parseCpuTemperature,
  parseLoadAverage,
  parseMeminfo,
  parseModel,
  parseUptime,
} from "./facts.js";

/**
 * **Provenance of these fixtures, stated plainly.**
 *
 * `net/nmcli/fixtures/` are captures: a Raspberry Pi 4 printed them and they
 * were pasted in unaltered. These are **not** that. No `/proc` was read to
 * write them — the machine this was developed on is not Linux and has none —
 * so they are constructed to the documented format of each file and to the
 * board facts that boot did record in `docs/hardware/verifying-m1a.md`:
 * a Raspberry Pi 4, aarch64, 905 MB usable, Debian 13 (trixie). `MemTotal:
 * 926816 kB` is 905.1 MiB, which is where that number comes from.
 *
 * That distinction is the whole point of writing it down. A constructed
 * fixture proves the parser handles the shape someone believed the file has;
 * only a capture proves it handles the shape the file actually has. Replacing
 * these with a real `cat /proc/meminfo` from a board is a step in
 * `docs/hardware/verifying-m1a.md`, and if a board disagrees, the board is
 * right.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

describe("parseModel", () => {
  /**
   * The terminator is the entire reason this function exists. `/proc/device-
   * tree/model` is a device-tree property and device-tree strings carry their
   * NUL, so a page that renders the file as read shows a trailing control
   * character that is invisible until it is in a screenshot.
   */
  it("strips the NUL a device-tree string is terminated with", () => {
    const raw = fixture("model-pi4.txt");
    expect(raw).toContain("\0");
    expect(parseModel(raw)).toBe("Raspberry Pi 4 Model B Rev 1.5");
    expect(parseModel(raw)).not.toContain("\0");
  });

  it("reports a device tree with no model as unknown, not as an empty name", () => {
    expect(parseModel(null)).toBeNull();
    expect(parseModel("\0")).toBeNull();
    expect(parseModel("   \n")).toBeNull();
  });
});

describe("parseLoadAverage", () => {
  it("reads the three averages and the process-count field", () => {
    expect(parseLoadAverage(fixture("loadavg-pi4.txt"))).toEqual({
      one: 0.52,
      five: 0.58,
      fifteen: 0.59,
      runnable: 1,
      total: 342,
    });
  });

  it("still reports the averages when there is no process-count field", () => {
    expect(parseLoadAverage(fixture("loadavg-no-process-field.txt"))).toEqual({
      one: 0,
      five: 0.01,
      fifteen: 0.05,
      runnable: null,
      total: null,
    });
  });

  it("reports nothing rather than part of a reading", () => {
    // Two averages is not a load average; showing them under three labels
    // would put the five-minute figure where the fifteen-minute one belongs.
    expect(parseLoadAverage("0.10 0.20")).toBeNull();
    expect(parseLoadAverage("not a number at all")).toBeNull();
    expect(parseLoadAverage(null)).toBeNull();
    expect(parseLoadAverage("")).toBeNull();
  });
});

describe("parseMeminfo", () => {
  it("reads a 905 MB board, in bytes", () => {
    const memory = parseMeminfo(fixture("meminfo-pi4.txt"));
    expect(memory).toEqual({
      totalBytes: 926816 * 1024,
      availableBytes: 742932 * 1024,
      freeBytes: 444584 * 1024,
      usedBytes: (926816 - 742932) * 1024,
    });
    // 905 MiB, which is what the board reported and what the fixture is built
    // around. A conversion done the wrong way round is a 1024x error nobody
    // notices until a page claims the board has 900 GB.
    expect(Math.round((memory?.totalBytes ?? 0) / 1024 / 1024)).toBe(905);
  });

  /**
   * `MemFree` is not free memory. A healthy Linux keeps almost none, because
   * the rest is page cache it hands back on demand — so `used = total - free`
   * reports a board at 95% memory when it is fine. `MemAvailable` is the
   * kernel's own answer to the question, and it is the one used here.
   */
  it("computes used from MemAvailable, not from MemFree", () => {
    const memory = parseMeminfo(fixture("meminfo-pi4.txt"));
    expect(memory?.usedBytes).toBe((926816 - 742932) * 1024);
    expect(memory?.usedBytes).not.toBe((926816 - 444584) * 1024);
  });

  it("leaves used unknown on a kernel too old to report MemAvailable", () => {
    const memory = parseMeminfo("MemTotal:  926816 kB\nMemFree:  444584 kB\n");
    expect(memory).toEqual({
      totalBytes: 926816 * 1024,
      availableBytes: null,
      freeBytes: 444584 * 1024,
      usedBytes: null,
    });
  });

  it("reports nothing when there is no total to report a fraction of", () => {
    expect(parseMeminfo(null)).toBeNull();
    expect(parseMeminfo("MemFree:  444584 kB\n")).toBeNull();
    expect(parseMeminfo("nonsense")).toBeNull();
  });

  it("ignores a line whose unit it does not recognise", () => {
    // HugePages_Total has no unit. Multiplying it by 1024 would report a
    // number of pages as a number of bytes.
    const memory = parseMeminfo("MemTotal:  926816 kB\nHugePages_Total:       0\n");
    expect(memory?.totalBytes).toBe(926816 * 1024);
  });
});

describe("parseUptime", () => {
  it("reads an uptime of less than a minute", () => {
    expect(parseUptime(fixture("uptime-fresh.txt"))).toBe(41.83);
  });

  it("reads a long uptime", () => {
    expect(parseUptime("1234567.89 9876543.21\n")).toBe(1234567.89);
  });

  it("reports nothing rather than a nonsense figure", () => {
    expect(parseUptime(null)).toBeNull();
    expect(parseUptime("")).toBeNull();
    expect(parseUptime("-1 0")).toBeNull();
    expect(parseUptime("up 3 days")).toBeNull();
  });
});

describe("parseCpuTemperature", () => {
  /**
   * Millidegrees. The classic version of getting this wrong is a status page
   * reading `58013 °C`, so the conversion is asserted directly.
   */
  it("converts millidegrees to degrees, once, here", () => {
    expect(parseCpuTemperature(fixture("thermal-pi4.txt"))).toBe(58);
    expect(parseCpuTemperature("47562\n")).toBe(47.6);
  });

  it("reports a board with no thermal zone as unknown, never as 0 °C", () => {
    // A fabricated zero renders as a real reading: a cold board, not a
    // missing sensor.
    expect(parseCpuTemperature(null)).toBeNull();
    expect(parseCpuTemperature("")).toBeNull();
    expect(parseCpuTemperature("n/a")).toBeNull();
  });

  it("reads a genuine zero as a reading, because it is one", () => {
    expect(parseCpuTemperature("0\n")).toBe(0);
  });
});

describe("boardFacts", () => {
  it("assembles a whole board", () => {
    expect(boardFacts({
      model: fixture("model-pi4.txt"),
      loadavg: fixture("loadavg-pi4.txt"),
      meminfo: fixture("meminfo-pi4.txt"),
      uptime: fixture("uptime-fresh.txt"),
      thermal: fixture("thermal-pi4.txt"),
    })).toEqual({
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
    });
  });

  /**
   * A board with no thermal zone is not an error. Neither is one whose device
   * tree carries no model — an x86 machine with this installed on it has
   * neither, and it must still produce a page.
   */
  it("produces a whole record from a board that offers none of it", () => {
    expect(boardFacts({
      model: null, loadavg: null, meminfo: null, uptime: null, thermal: null,
    })).toEqual({
      model: null, load: null, memory: null, uptimeSeconds: null, cpuTemperatureC: null,
    });
  });

  it("loses only the fact that is missing", () => {
    const facts = boardFacts({
      model: null,
      loadavg: fixture("loadavg-pi4.txt"),
      meminfo: fixture("meminfo-pi4.txt"),
      uptime: fixture("uptime-fresh.txt"),
      thermal: null,
    });
    expect(facts.model).toBeNull();
    expect(facts.cpuTemperatureC).toBeNull();
    expect(facts.load?.one).toBe(0.52);
    expect(facts.uptimeSeconds).toBe(41.83);
  });
});
