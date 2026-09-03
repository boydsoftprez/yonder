// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from "node:fs";

export interface Counters { rx: number; tx: number }

/** Injected, like every other reading in this daemon, so a test reaches no /sys. */
export type CounterReader = (device: string) => Counters | null;

/** Where the kernel keeps them. */
export const SYS_CLASS_NET = "/sys/class/net";

/**
 * How many bytes an interface has carried, from the kernel's own counters,
 * under a given root.
 *
 * Free, in the sense that matters here: these are maintained whether or not
 * anything reads them, so watching a metered cellular link costs the operator
 * nothing (R-CEL-09). Null for a device that is not there — a board with no
 * modem is an ordinary board.
 *
 * The root is a parameter so that the *parsing* can be tested against a
 * directory a test wrote, rather than against whatever interfaces the machine
 * running the suite happens to have. Nothing in production passes anything
 * but `SYS_CLASS_NET`; every other caller injects a `CounterReader` instead.
 */
export function countersFrom(root: string): CounterReader {
  return (device) => {
    try {
      const at = (f: string) =>
        Number(readFileSync(`${root}/${device}/statistics/${f}`, "utf8").trim());
      const rx = at("rx_bytes");
      const tx = at("tx_bytes");
      return Number.isFinite(rx) && Number.isFinite(tx) ? { rx, tx } : null;
    } catch {
      return null;
    }
  };
}

/** The kernel's own counters. The default nothing in a test may reach. */
export const systemCounters: CounterReader = countersFrom(SYS_CLASS_NET);

/**
 * The difference between two readings, floored at zero.
 *
 * A counter can go backwards — a 32-bit one wraps, and an interface torn down
 * and rebuilt starts again at zero — and a negative delta read as movement
 * would be a link declared healthy by arithmetic.
 */
export function movement(before: Counters, after: Counters): Counters {
  return { rx: Math.max(0, after.rx - before.rx), tx: Math.max(0, after.tx - before.tx) };
}

/**
 * Bytes that must leave before silence is evidence of anything.
 *
 * A few hundred bytes is a stray broadcast. This is deliberately larger than
 * one packet and far smaller than anything a working link sends in a second.
 */
const ATTEMPT_BYTES = 1024;

/**
 * Traffic going out with nothing coming back.
 *
 * **An idle link is not a dead one**, and telling them apart is the whole
 * point: the fallback watchdog rejected byte counters for exactly that reason
 * (K-40), and the answer is not to look at one counter but at both. Nothing
 * moving in either direction says nothing at all, and this returns false.
 */
export function looksDead(before: Counters, after: Counters): boolean {
  const moved = movement(before, after);
  return moved.tx >= ATTEMPT_BYTES && moved.rx === 0;
}
