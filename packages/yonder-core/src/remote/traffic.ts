// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Traffic {
  rxBytes: number;
  txBytes: number;
}

/**
 * ZeroTier's own `/metrics` endpoint measured empty on a real board
 * (`metrics.prom` was 0 bytes), so the byte counters this daemon reports
 * come from the kernel instead: `/sys/class/net/<iface>/statistics/{rx,tx}_bytes`.
 *
 * This is the only file-reading module under `remote/` - kept pure and small
 * on purpose, and given a `sysfs` root parameter so a test never needs a real
 * network interface to point at.
 */
export function readTraffic(iface: string, sysfs = "/sys/class/net"): Traffic | null {
  const read = (counter: string): number | null => {
    try {
      const text = readFileSync(join(sysfs, iface, "statistics", counter), "utf8").trim();
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    } catch {
      // Gone, unreadable, or not a number - a missing counter is not zero
      // traffic, so none of these become 0.
      return null;
    }
  };

  const rxBytes = read("rx_bytes");
  const txBytes = read("tx_bytes");
  if (rxBytes === null || txBytes === null) return null;
  return { rxBytes, txBytes };
}
