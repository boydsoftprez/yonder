// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FACT_PATHS,
  freeSpaceOn,
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

/**
 * The medium a recording is written to (R-STO-06).
 *
 * The one reader here that answers a number rather than a text, and the one
 * whose failure would be silent: a captures directory that does not exist yet
 * must read as the medium it would be created on, not as a full card.
 */
describe("freeSpaceOn", () => {
  it("answers with what is actually available on the medium", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yonder-space-"));
    try {
      const free = await freeSpaceOn(dir);
      expect(free).toBeGreaterThan(0);
      expect(Number.isFinite(free)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers for a directory that has not been created yet", async () => {
    // A freshly flashed board has no captures directory until the first
    // capture is taken, and refusing that first recording would be the whole
    // feature failing on the one board that has never used it.
    const dir = mkdtempSync(join(tmpdir(), "yonder-space-"));
    try {
      const deep = join(dir, "captures", "cam0");
      const missing = await freeSpaceOn(deep);
      // The same medium, so the same figure — within whatever the machine
      // running this wrote to its own disk between the two calls. Compared
      // loosely on purpose: an exact equality here fails on a laptop that is
      // doing anything at all, and the property under test is that a path
      // that is not there answers for its medium rather than throwing.
      const parent = await freeSpaceOn(dir);
      expect(missing).toBeGreaterThan(0);
      expect(Math.abs(missing - parent) / parent).toBeLessThan(0.01);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
