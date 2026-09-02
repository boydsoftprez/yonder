// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countersFrom, looksDead, movement } from "./counters.js";

describe("movement", () => {
  it("reports the difference between two readings", () => {
    expect(movement({ rx: 100, tx: 200 }, { rx: 150, tx: 260 })).toEqual({ rx: 50, tx: 60 });
  });

  it("treats a counter that went backwards as no movement", () => {
    // A 32-bit counter wraps, and an interface that was torn down and rebuilt
    // starts again at zero. Neither is traffic, and a negative delta read as
    // movement would be.
    expect(movement({ rx: 100, tx: 200 }, { rx: 0, tx: 0 })).toEqual({ rx: 0, tx: 0 });
  });
});

describe("looksDead", () => {
  it("is true when traffic is leaving and nothing is coming back", () => {
    // The measured signature of a wrong APN: 56842 bytes out, 1374 in.
    expect(looksDead({ rx: 1374, tx: 56842 }, { rx: 1374, tx: 71826 })).toBe(true);
  });

  it("is false when both counters are moving", () => {
    expect(looksDead({ rx: 100, tx: 100 }, { rx: 900, tx: 900 })).toBe(false);
  });

  it("is false when nothing is moving at all", () => {
    // An idle link is not a dead one. This is exactly the distinction the
    // fallback watchdog could not make (K-33) and the reason it is drawn here
    // rather than left to a caller.
    expect(looksDead({ rx: 100, tx: 100 }, { rx: 100, tx: 100 })).toBe(false);
  });

  it("is false when only a trickle went out", () => {
    // A handful of bytes is a stray broadcast, not an attempt at traffic.
    expect(looksDead({ rx: 0, tx: 0 }, { rx: 0, tx: 120 })).toBe(false);
  });
});

/**
 * Against a directory this test wrote, never against `/sys`.
 *
 * A test that read the real thing would take a different branch on a CI host
 * that happens to have an interface named like a fixture, and would be
 * asserting about the machine rather than about this code. It is the rule the
 * whole of `reach/` is built around — every reading is injected — and the one
 * place it could still be broken was the reader itself.
 */
describe("the kernel's counters", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "yonder-sys-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function device(name: string, rx: string, tx: string): void {
    const at = join(root, name, "statistics");
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "rx_bytes"), `${rx}\n`);
    writeFileSync(join(at, "tx_bytes"), `${tx}\n`);
  }

  it("reads both counters for an interface that is there", () => {
    device("wwan0", "1374", "56842");
    expect(countersFrom(root)("wwan0")).toEqual({ rx: 1374, tx: 56842 });
  });

  it("answers null for a device that does not exist, rather than throwing", () => {
    // A board with no modem is an ordinary board.
    expect(countersFrom(root)("wwan0")).toBeNull();
  });

  it("answers null rather than NaN when a counter is not a number", () => {
    device("eth0", "not-a-number", "12");
    expect(countersFrom(root)("eth0")).toBeNull();
  });
});
