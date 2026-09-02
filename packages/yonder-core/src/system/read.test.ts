// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FACT_PATHS,
  readBoardFacts,
  readFactSources,
  systemReader,
  type FileReader,
} from "./read.js";

/** A reader that knows about exactly the paths named, and nothing else. */
function reader(files: Record<string, string>): FileReader {
  return (path) => files[path] ?? null;
}

describe("readFactSources", () => {
  it("reads each fact from the path a Linux board keeps it at", () => {
    const asked: string[] = [];
    readFactSources({
      read: (path) => { asked.push(path); return null; },
    });
    expect(asked).toEqual([
      "/proc/device-tree/model",
      "/proc/loadavg",
      "/proc/meminfo",
      "/proc/uptime",
      "/sys/class/thermal/thermal_zone0/temp",
    ]);
  });

  it("takes path overrides, so a test never has to have a /proc", () => {
    const sources = readFactSources({
      read: reader({ "/elsewhere/uptime": "12.0 30.0\n" }),
      paths: { uptime: "/elsewhere/uptime" },
    });
    expect(sources.uptime).toBe("12.0 30.0\n");
    expect(sources.meminfo).toBeNull();
  });
});

describe("readBoardFacts", () => {
  it("reports what the board has and nulls what it does not", () => {
    const facts = readBoardFacts({
      read: reader({
        [DEFAULT_FACT_PATHS.model]: "Raspberry Pi 4 Model B Rev 1.5\0",
        [DEFAULT_FACT_PATHS.loadavg]: "0.52 0.58 0.59 1/342 1187\n",
        [DEFAULT_FACT_PATHS.uptime]: "41.83 158.24\n",
      }),
    });
    expect(facts.model).toBe("Raspberry Pi 4 Model B Rev 1.5");
    expect(facts.uptimeSeconds).toBe(41.83);
    // No thermal zone and no meminfo on this imaginary board.
    expect(facts.cpuTemperatureC).toBeNull();
    expect(facts.memory).toBeNull();
  });

  /**
   * The reason `systemReader` swallows: `/proc/device-tree` does not exist on
   * a machine with no device tree, and a status route that throws over that
   * is a console page that will not load on half the boards this could run
   * on.
   */
  it("does not throw when nothing is where it should be", () => {
    expect(() => readBoardFacts({ paths: {
      model: "/definitely/not/here/model",
      loadavg: "/definitely/not/here/loadavg",
      meminfo: "/definitely/not/here/meminfo",
      uptime: "/definitely/not/here/uptime",
      thermal: "/definitely/not/here/temp",
    } })).not.toThrow();
  });
});

describe("systemReader", () => {
  it("returns the text of a file that is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-facts-"));
    try {
      const path = join(dir, "uptime");
      writeFileSync(path, "41.83 158.24\n");
      expect(systemReader(path)).toBe("41.83 158.24\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a file that is not, and for a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-facts-"));
    try {
      expect(systemReader(join(dir, "absent"))).toBeNull();
      // EISDIR is the other way this call fails, and it must be as quiet.
      expect(systemReader(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
