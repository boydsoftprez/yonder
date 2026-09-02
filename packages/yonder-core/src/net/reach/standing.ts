// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../../apply/types.js";

export type PathName = "ethernet" | "modem" | "wifi_client";

export type PathStanding =
  | "in-use"        // traffic is leaving this way
  | "standing-by"   // works, but something above it in the order is in use
  | "testing"       // stopped receiving; being tested right now
  | "no-route-out"  // stood down: reached nothing when tested
  | "absent";       // no such interface on this board

export interface PathReport {
  path: PathName;
  device: string | null;
  standing: PathStanding;
  /** When this path was stood down, epoch ms. Null when it has not been. */
  since: number | null;
  /** One sentence for an operator, in Yonder's words. */
  detail: string;
}

export interface ReachState {
  paths: PathReport[];
  inUse: PathName | null;
  /** True when some path is carrying traffic. The watchdog's question (K-33). */
  carrying: boolean;
}

/**
 * How many consecutive failures stand a path down, and how many successes
 * bring it back.
 *
 * **These are provisional and Task 11 replaces them with measured values.**
 * They are named constants rather than literals so that the measurement has
 * one place to land, and the asymmetry — slow to move, quick to return — is
 * the part that is not provisional: being wrong about a path being dead costs
 * an aircraft its link, and being wrong about it being alive costs one more
 * probe.
 */
export const FAILURES_TO_STAND_DOWN = 3;
export const SUCCESSES_TO_RETURN = 1;

/**
 * How often the path in use is looked at.
 *
 * **Provisional in the same way, and measured by the same task**, which is
 * why it is here rather than beside the loop that uses it: the three numbers
 * that decide how fast a dead path is noticed belong in one place, so the
 * measurement against a real dropout has one file to land in.
 *
 * A tick costs three local `nmcli` reads and two files out of `/sys`, and no
 * bytes at all on the operator's link — nothing is probed unless the counters
 * say the path stopped receiving (R-CEL-09). What sets the number is the
 * other end: `FAILURES_TO_STAND_DOWN` consecutive failures, each bounded by
 * the probe's own 8 s timeout, have to complete inside the fallback window or
 * the watchdog asks its question before there is an answer. Three ticks of
 * five seconds plus three probes is a little under forty, against a default
 * window of ninety.
 */
export const REACH_TICK_MS = 5_000;

/**
 * How long one tick is given before it is abandoned and the next is armed.
 *
 * The loop is chained rather than repeating — the next tick is armed in the
 * `finally` of this one — which is what stops two `curl`s landing on the same
 * interface. The cost of that shape is that a tick which never finishes ends
 * the loop, and **a hang is not a throw**, so the `catch` around it never
 * fires and nothing is logged. A wedged ModemManager on a D-Bus call does
 * exactly that: `inUseNow()` waits for an `mmcli -L` that never returns, and
 * standing freezes at whatever it last was while `carrying()` goes on
 * answering from it.
 *
 * A legitimate tick spends at most one probe per path — `FAILURES_TO_STAND_DOWN`
 * is about consecutive ticks, not attempts within one — so three paths at the
 * probe's own 8 s timeout is the worst honest case, well under half a minute.
 * A minute is generous enough that this can only ever catch something that is
 * genuinely stuck.
 */
export const REACH_TICK_DEADLINE_MS = 60_000;

/**
 * What to call a path in a line an operator reads.
 *
 * Exported because the monitor assembling `PathReport.detail` says the same
 * words about the same paths, and two copies of operator-facing wording drift
 * — one of them ends up calling `modem` "modem" in a log line and "cellular"
 * on a page about the same event.
 */
export const PATH_WORDS: Record<PathName, string> = {
  ethernet: "ethernet",
  modem: "cellular",
  wifi_client: "Wi-Fi",
};

interface Record_ { failures: number; successes: number; down: boolean; since: number | null }

/**
 * Which paths participate, and the hysteresis that decides.
 *
 * **This never reorders anything.** `network.priority` is the only statement
 * of preference and `config.yaml` remains its only writer (R-NET-13). All this
 * decides is whether a path is in the running at all, which is what lets the
 * mechanism exist without a second writer of configuration.
 */
export class Standing {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly records = new Map<PathName, Record_>();

  constructor(opts: { clock: Clock; log?: (line: string) => void }) {
    this.clock = opts.clock;
    this.log = opts.log ?? (() => {});
  }

  private recordFor(path: PathName): Record_ {
    const existing = this.records.get(path);
    if (existing !== undefined) return existing;
    const fresh: Record_ = { failures: 0, successes: 0, down: false, since: null };
    this.records.set(path, fresh);
    return fresh;
  }

  /** Fold one probe result in. Returns the standing that results. */
  record(path: PathName, reached: boolean): PathStanding {
    const r = this.recordFor(path);
    if (reached) {
      r.failures = 0;
      r.successes += 1;
      if (r.down && r.successes >= SUCCESSES_TO_RETURN) {
        r.down = false;
        r.since = null;
        this.log(`network: ${PATH_WORDS[path]} is reaching the internet again and is back in use`);
      }
    } else {
      r.successes = 0;
      r.failures += 1;
      if (!r.down && r.failures >= FAILURES_TO_STAND_DOWN) {
        r.down = true;
        r.since = this.clock.now();
        this.log(
          `network: ${PATH_WORDS[path]} reached nothing on ${r.failures} tries and has been stood down; ` +
          `traffic will use the next path that works`,
        );
      }
    }
    return this.standingOf(path);
  }

  standingOf(path: PathName): PathStanding {
    return this.records.get(path)?.down === true ? "no-route-out" : "standing-by";
  }

  since(path: PathName): number | null {
    return this.records.get(path)?.since ?? null;
  }
}
