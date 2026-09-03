// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTraffic } from "./traffic.js";

describe("readTraffic", () => {
  let sysfs: string;

  beforeEach(() => {
    sysfs = mkdtempSync(join(tmpdir(), "yonder-sysfs-"));
  });

  afterEach(() => {
    rmSync(sysfs, { recursive: true, force: true });
  });

  const stats = (iface: string, rx: string, tx: string) => {
    const dir = join(sysfs, iface, "statistics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rx_bytes"), rx);
    writeFileSync(join(dir, "tx_bytes"), tx);
  };

  it("reads the kernel's own counters, real values seen on a board", () => {
    stats("ztly52ge2a", "1537757\n", "405199\n");
    expect(readTraffic("ztly52ge2a", sysfs)).toEqual({ rxBytes: 1537757, txBytes: 405199 });
  });

  // A missing counter is not zero traffic - it is "we do not know", and the
  // two must not be confused on a page an operator trusts with their life.
  it("returns null when the interface is gone", () => {
    expect(readTraffic("ztnonexistent", sysfs)).toBeNull();
  });

  it("returns null when a counter file is present but unreadable as a number", () => {
    const dir = join(sysfs, "ztgarbled", "statistics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rx_bytes"), "not-a-number\n");
    writeFileSync(join(dir, "tx_bytes"), "405199\n");
    expect(readTraffic("ztgarbled", sysfs)).toBeNull();
  });
});
