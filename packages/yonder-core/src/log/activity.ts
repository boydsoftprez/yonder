// SPDX-License-Identifier: GPL-3.0-or-later
import { systemClock, type Clock } from "../apply/types.js";
import { redactLine } from "../secrets/redact.js";

/**
 * The live activity log the console shows (R-DIA-05).
 *
 * Three properties, and each of them is the answer to a way this goes wrong.
 *
 * **Bounded.** A fixed number of entries, oldest discarded first, and each
 * entry's text capped. A device that runs for weeks with an unbounded log has
 * a memory leak with a nice name, and it runs out on a 512 MB board at the
 * moment somebody is using the console.
 *
 * **Fed by the calls that already exist.** `warn()` and `note()` write to the
 * journal and to this buffer in one step, so the page shows what the daemon
 * actually did. A second stream that callers have to remember to write to is a
 * page that is silent about the one event nobody remembered.
 *
 * **Redacted before it is stored, not before it is served.** This buffer goes
 * to a browser. `secrets/redact.ts` is the one list, and everything that
 * enters here goes through it at the point of capture (R-SEC-10) — so a
 * credential is not in the buffer at all, rather than being in the buffer and
 * filtered on the way out by a route that somebody might later add a second
 * copy of.
 */

export type ActivityLevel = "info" | "warn";

export interface ActivityEntry {
  /**
   * Increasing, never reused, and the *only* ordering this buffer promises.
   *
   * A page asks for what it has not seen with `since=`, and it has to keep
   * working across a system clock that steps — an NTP correction on a board
   * with no RTC moves `at` backwards, and a reader that paged on timestamps
   * would then either repeat entries or skip them.
   */
  seq: number;
  /** Milliseconds since the epoch, from the injected clock. */
  at: number;
  level: ActivityLevel;
  message: string;
}

/**
 * How many entries are kept.
 *
 * Enough to hold a boot, an apply and its confirmation with room to spare —
 * which is the span an operator is actually reading when something has gone
 * wrong — and small enough that the whole buffer is a few hundred kilobytes at
 * the message cap below.
 */
export const ACTIVITY_CAPACITY = 400;

/**
 * The longest single entry.
 *
 * The count bound alone is not a bound: one caller logging a whole file would
 * put a megabyte in a buffer that promised to be small, and this buffer is
 * also a response body.
 */
export const ACTIVITY_MESSAGE_LIMIT = 1_000;

export interface ActivityLogOptions {
  capacity?: number;
  clock?: Clock;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  /**
   * The oldest sequence number still held. A reader whose `since` is below
   * this missed entries that have already been discarded, and can say so
   * rather than showing a gap as continuity.
   */
  oldestSeq: number;
  /** What to ask for next time. */
  newestSeq: number;
  /** How many entries this buffer has discarded since the process started. */
  discarded: number;
}

export class ActivityLog {
  private readonly capacity: number;
  private readonly clock: Clock;
  private buffer: ActivityEntry[] = [];
  private nextSeq = 1;
  private discarded = 0;

  constructor(opts: ActivityLogOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? ACTIVITY_CAPACITY);
    this.clock = opts.clock ?? systemClock;
  }

  /**
   * Record a line, and return it as it was recorded.
   *
   * The return value is what the caller should print. `warn()` writes it to
   * the journal, so the journal and the page carry the same text — an
   * operator comparing the two must not find one of them redacted and the
   * other not.
   */
  record(level: ActivityLevel, message: string): string {
    const redacted = redactLine(message);
    const text = redacted.length > ACTIVITY_MESSAGE_LIMIT
      ? `${redacted.slice(0, ACTIVITY_MESSAGE_LIMIT)}…`
      : redacted;

    this.buffer.push({ seq: this.nextSeq++, at: this.clock.now(), level, message: text });
    if (this.buffer.length > this.capacity) {
      this.discarded += this.buffer.length - this.capacity;
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity);
    }
    return text;
  }

  /** Everything after `since`, oldest first. `since` of 0 is everything held. */
  page(since = 0): ActivityPage {
    return {
      entries: this.buffer.filter((e) => e.seq > since),
      oldestSeq: this.buffer[0]?.seq ?? 0,
      newestSeq: this.nextSeq - 1,
      discarded: this.discarded,
    };
  }

  /** Everything held, oldest first. */
  entries(): ActivityEntry[] {
    return [...this.buffer];
  }

  /** Test-only. A device never forgets what it did on purpose. */
  clear(): void {
    this.buffer = [];
    this.discarded = 0;
  }
}

/**
 * The one buffer this process keeps.
 *
 * A singleton because `warn()` is a free function called from everywhere and
 * threading an instance through every module that logs would be a change to
 * every module that logs — for no gain, since a process has one journal too.
 * Tests that need to assert on ordering or capacity construct their own with
 * an injected clock.
 */
export const activityLog = new ActivityLog();
