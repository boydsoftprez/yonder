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

/**
 * What the record says about a path, in the three states it actually has.
 *
 * `standingOf` collapses this into two — a path is stood down or it is not —
 * which is the right answer for a console and the wrong one for the fallback
 * watchdog. "Not stood down" covers a path that is working, a path that has
 * failed twice of the three that condemn it, and a path nothing has ever
 * looked at; treating those as one is how a board with no way out reports
 * itself healthy (K-40).
 *
 *  - `reaching` — the most recent probe reached something.
 *  - `not-reaching` — it is stood down, or its recent probes have been
 *    failing. Evidence against, whether or not it has run out yet.
 *  - `untested` — nothing has probed it. No evidence either way, and not the
 *    same thing as evidence of health.
 */
export type PathEvidence = "reaching" | "not-reaching" | "untested";

export interface ReachState {
  paths: PathReport[];
  inUse: PathName | null;
  /** True when some path is carrying traffic. The watchdog's question (K-40). */
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
 * The one question anything outside `reach/` may ask of standing.
 *
 * Deliberately this narrow. `NetworkRenderer` asks it while generating route
 * metrics, which is what makes traffic actually move off a dead path
 * (R-NET-13) — and a wider view handed to the thing that writes NetworkManager
 * profiles would be an invitation to let health decide something other than
 * participation. It cannot record, it cannot reorder, and it cannot be
 * written to.
 */
export interface StandingView {
  isStoodDown(path: PathName): boolean;
}

/**
 * The view every existing caller gets: a board where nothing has been stood
 * down. Route metrics then come out exactly as `network.priority` alone says,
 * which is what `metricFor` did before standing existed.
 */
export const NOTHING_STOOD_DOWN: StandingView = { isStoodDown: () => false };

export interface StandingOptions {
  clock: Clock;
  log?: (line: string) => void;
  /**
   * The operator's order, from `config.network.priority`.
   *
   * Read, never written. It is here so that a line about a path being stood
   * down can name **what traffic moved to**, which R-NET-13 asks for by name
   * and which cannot be said without knowing what outranks what. An empty
   * order — the default, for a `Standing` nobody told — means the line says
   * only what it can establish, never a move it cannot vouch for.
   */
  order?: () => PathName[];
  /**
   * Called once on each change of standing, in either direction, and never
   * on a probe that changed nothing.
   *
   * This is the hook that makes R-NET-13's second half real: the daemon wires
   * it to `NetworkRenderer.remetric`, which recomputes the route metrics with
   * the new standing and writes them. **It is not a second writer of
   * configuration** — the renderer stays the only thing that writes a metric,
   * and this only tells it that one of its inputs has moved.
   */
  onChange?: (path: PathName, stoodDown: boolean) => void;
}

/**
 * Which paths participate, and the hysteresis that decides.
 *
 * **This never reorders anything.** `network.priority` is the only statement
 * of preference and `config.yaml` remains its only writer (R-NET-13). All this
 * decides is whether a path is in the running at all, which is what lets the
 * mechanism exist without a second writer of configuration.
 */
export class Standing implements StandingView {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  private readonly order: () => PathName[];
  private readonly onChange: (path: PathName, stoodDown: boolean) => void;
  private readonly records = new Map<PathName, Record_>();

  constructor(opts: StandingOptions) {
    this.clock = opts.clock;
    this.log = opts.log ?? (() => {});
    this.order = opts.order ?? (() => []);
    this.onChange = opts.onChange ?? (() => {});
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
        this.log(`network: ${PATH_WORDS[path]} is reaching the internet again ${this.at()}${this.andThen(path)}`);
        this.announce(path, false);
      }
    } else {
      r.successes = 0;
      r.failures += 1;
      if (!r.down && r.failures >= FAILURES_TO_STAND_DOWN) {
        r.down = true;
        r.since = this.clock.now();
        const moved = this.carryingNow();
        this.log(
          `network: ${PATH_WORDS[path]} reached nothing on ${r.failures} tries; stood down ${this.at()}`
          + (moved === null
            // Never claim a move that cannot happen. A board whose every path
            // has been stood down keeps the route it has — a metric is not a
            // disconnect — and the operator needs to read that, not a
            // sentence about traffic going somewhere there is nowhere to go.
            ? ", and there is no other path reaching anything for traffic to move to"
            : ` and traffic moves to ${PATH_WORDS[moved]}`),
        );
        this.announce(path, true);
      }
    }
    return this.standingOf(path);
  }

  standingOf(path: PathName): PathStanding {
    return this.isStoodDown(path) ? "no-route-out" : "standing-by";
  }

  /**
   * What is actually known about a path, rather than whether it is condemned.
   *
   * `failures` and `successes` are exclusive — folding a result in zeroes the
   * other — so the counters alone say which way the most recent probe went,
   * and a path with no record at all has never been probed. Being stood down
   * is folded into `not-reaching` rather than kept apart, because for anyone
   * asking "does this reach anything" the two are the same answer with
   * different amounts of evidence behind them.
   *
   * The fallback watchdog is the caller this exists for: it has one chance to
   * decide whether the access point comes up, and it must be able to tell a
   * path that is failing from one nobody has looked at (K-40).
   */
  evidenceFor(path: PathName): PathEvidence {
    const r = this.records.get(path);
    if (r === undefined) return "untested";
    if (r.down || r.failures > 0) return "not-reaching";
    return r.successes > 0 ? "reaching" : "untested";
  }

  isStoodDown(path: PathName): boolean {
    return this.records.get(path)?.down === true;
  }

  since(path: PathName): number | null {
    return this.records.get(path)?.since ?? null;
  }

  /** The "and when" R-NET-13 asks for, off the injected clock and never the wall one. */
  private at(): string {
    return `at ${new Date(this.clock.now()).toISOString()}`;
  }

  /**
   * The path traffic goes out by, given standing exactly as it is now.
   *
   * The first path in the operator's order that is not stood down **and whose
   * last test reached something**. Both halves matter: a path with no record
   * has never been tested and may not exist on this board, and a path whose
   * last probe failed is not something to promise an operator traffic has
   * moved to. Null means nothing can be vouched for, and the caller says so
   * rather than inventing a destination.
   *
   * This is a reading of evidence, not a decision. What actually moves the
   * traffic is the route metric the renderer writes, generated from the same
   * order and the same standing — see `metricFor`.
   */
  private carryingNow(): PathName | null {
    for (const path of this.order()) {
      const r = this.records.get(path);
      if (r !== undefined && !r.down && r.successes > 0) return path;
    }
    return null;
  }

  /** What a recovery means for where traffic is, said only as far as it can be. */
  private andThen(path: PathName): string {
    const head = this.carryingNow();
    if (head === path) return "; traffic moves back to it";
    if (head === null) return " and is back in the running";
    return `; ${PATH_WORDS[head]} goes on carrying traffic and ${PATH_WORDS[path]} is back in the running behind it`;
  }

  /**
   * Tell whoever asked that a standing changed, without letting them end a probe.
   *
   * The listener writes route metrics through nmcli. A failure there is a
   * path that did not move, which is worth a line — but a throw out of
   * `record` would abandon the rest of the tick, including the tests of the
   * alternatives that establish which path can take over.
   */
  private announce(path: PathName, stoodDown: boolean): void {
    try {
      this.onChange(path, stoodDown);
    } catch (e) {
      this.log(`network: could not act on ${PATH_WORDS[path]} changing standing (${(e as Error).message})`);
    }
  }
}
