// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../../apply/types.js";
import { looksDead, movement, systemCounters, type Counters, type CounterReader } from "./counters.js";
import type { ReachMonitor } from "./monitor.js";
import { PATH_WORDS, REACH_TICK_MS, type PathName } from "./standing.js";

export interface ReachWatchOptions {
  monitor: ReachMonitor;
  /** Every timer this watch owns. Nothing here reads the wall clock. */
  clock: Clock;
  /** Defaults to the kernel's own counters. Injected so a test reaches no /sys. */
  counters?: CounterReader;
  log?: (line: string) => void;
  /** Overrides REACH_TICK_MS. Test-only. */
  tickMs?: number;
}

/**
 * What decides when to test, so that testing costs nothing while things work.
 *
 * R-NET-13 and R-CEL-09 say the same thing from two directions: *the path in
 * use is judged by its byte counters, and only when it stops receiving does
 * Yonder actively test — that path first, then the alternatives.* The
 * counters are maintained by the kernel whether or not anything reads them,
 * so a working device establishes that it is working without sending a byte
 * of its own, which is what makes this affordable on a metered link.
 *
 * **Nothing is tested on a schedule.** This ticks on a schedule; what it does
 * on a tick is read two numbers out of `/sys` and, almost always, stop. A
 * probe happens only for one of three reasons, and all three are events:
 *
 *  - **The path has just started carrying traffic.** R-CEL-09's "tested with
 *    real traffic when it comes up". Without this the case the milestone is
 *    named for is missed entirely: a freshly booted board with a wrong APN,
 *    no Ethernet and no Wi-Fi transmits almost nothing, `looksDead` needs
 *    real bytes to have left, and so the counters would never say anything
 *    about the one link that is broken (K-33).
 *  - **The path stopped receiving** — bytes going out with nothing coming
 *    back, which is `looksDead`, and is §2's failure written in counters.
 *  - **The path failed its last test.** The hysteresis needs *consecutive*
 *    evidence, and a link that has failed and then goes quiet looks exactly
 *    like an idle one — so a single trigger per event could never reach
 *    `FAILURES_TO_STAND_DOWN` in the field, and the demotion this whole
 *    mechanism exists for would never happen. This is the only one of the
 *    three that repeats, and it only ever runs while something is broken.
 *
 * Traffic moving both ways is folded in as a success, which costs nothing and
 * is how a path returns from being stood down without a probe running at all.
 * Silence in both directions decides nothing: an idle link is not a dead one,
 * and that is the mistake `looksDead` was written to refuse.
 *
 * It cannot throw into its own timer. A daemon that stopped probing silently
 * would leave standing frozen at whatever it last was, with nothing saying so
 * — worse than one that never probed, because `carrying()` would go on
 * answering from stale evidence.
 */
export class ReachWatch {
  private readonly monitor: ReachMonitor;
  private readonly clock: Clock;
  private readonly counters: CounterReader;
  private readonly log: (line: string) => void;
  private readonly tickMs: number;
  private timer: unknown;
  private stopped = false;

  /**
   * The last counter reading, and the path and interface it was taken from.
   *
   * **The interface is part of the key, not only the path.** These are
   * absolute numbers about one device; two of them are a comparison only when
   * they came from the same one. Subtracting a busy dead LAN's counters from
   * an idle modem's manufactures traffic in both directions that never
   * happened — which reads as a success, skips the link-up probe R-CEL-09
   * mandates, and clears `no-route-out` on evidence that does not exist.
   *
   * Keying on the path alone is not enough even for a single path: a modem
   * has two names, and the map falls back to the control port NetworkManager
   * lists (`cdc-wdm0`) until ModemManager resolves the data port (`wwan0`).
   */
  private previous: Counters | null = null;
  private lastPath: PathName | null = null;
  private lastDevice: string | null = null;
  /** Paths whose last test failed and which have not since succeeded. */
  private readonly failing = new Set<PathName>();

  constructor(opts: ReachWatchOptions) {
    this.monitor = opts.monitor;
    this.clock = opts.clock;
    this.counters = opts.counters ?? systemCounters;
    this.log = opts.log ?? (() => {});
    this.tickMs = opts.tickMs ?? REACH_TICK_MS;
  }

  /** Begin ticking. Idempotent, and a no-op once stopped. */
  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.schedule();
  }

  /**
   * Abandon the loop, and refuse to start another.
   *
   * The same reason FallbackWatchdog and NetworkRenderer have their own: a
   * loop that outlives the daemon it belongs to goes on questioning
   * NetworkManager — and running `curl` on somebody's metered link — on
   * behalf of a process that has already closed its socket.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      this.clock.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One tick, chained rather than repeating.
   *
   * The next tick is armed only once this one has finished, so a tick that
   * spends three probe timeouts cannot have a second one start behind it —
   * which would put two `curl`s on the same interface and read the counters
   * across each other's traffic.
   */
  private schedule(): void {
    this.timer = this.clock.setTimer(this.tickMs, () => {
      this.timer = undefined;
      void (async () => {
        try {
          await this.tick();
        } catch (e) {
          // Nothing may take the loop down. See the class comment.
          this.log(`network: could not check which way out is working (${(e as Error).message})`);
        } finally {
          if (!this.stopped) this.schedule();
        }
      })();
    });
  }

  /** Read the counters without letting a failure end the tick. */
  private read(device: string): Counters | null {
    try {
      return this.counters(device);
    } catch (e) {
      this.log(`network: could not read the byte counters for ${device} (${(e as Error).message})`);
      return null;
    }
  }

  /**
   * Look at the path in use, and test only if something says to.
   *
   * Public so that the decision is testable one step at a time rather than
   * only through a timer, and so a future route could ask for the check R-CEL-09
   * calls "on request" without waiting for the next tick.
   */
  async tick(): Promise<void> {
    const now = await this.monitor.inUseNow();
    if (now === null) {
      // Nothing is carrying traffic, or nothing this monitor has a path for.
      // There is no subject for any of the questions below, and the readings
      // held from a previous path would be about a different interface.
      this.previous = null;
      this.lastPath = null;
      this.lastDevice = null;
      return;
    }

    const { path, device } = now;
    // A reading of a different interface is not a reading of this one, so it
    // is discarded rather than compared — and an interface that has just
    // taken the route has, for this watch's purposes, just come up.
    const cameUp = device !== this.lastDevice || path !== this.lastPath;
    const before = cameUp ? null : this.previous;
    const current = this.read(device);
    this.previous = current;
    this.lastPath = path;
    this.lastDevice = device;

    const why = this.reason(path, cameUp, before, current);
    if (why === null) return;

    this.log(`network: testing ${PATH_WORDS[path]} because ${why}`);
    if (await this.monitor.test(path)) {
      this.failing.delete(path);
      return;
    }
    this.failing.add(path);

    // The path carrying traffic reached nothing. Test the others, so that
    // standing says which of them can take over rather than only naming the
    // one that failed — `test` returns immediately for a path this board does
    // not have, so a device with one interface pays nothing for this.
    for (const other of this.monitor.priority()) {
      if (other !== path) await this.monitor.test(other);
    }
  }

  /** Why this path is about to be tested, or null for "it is not". */
  private reason(
    path: PathName,
    cameUp: boolean,
    before: Counters | null,
    current: Counters | null,
  ): string | null {
    // The counters come first, and outrank every reason to probe below them.
    // A path that is demonstrably carrying traffic in both directions is
    // reaching something, and that is better evidence than a probe as well as
    // cheaper — so a link that has failed and then genuinely recovers stops
    // being tested the moment it does, rather than on the next `curl`.
    // Nothing to compare against is not evidence of anything, in either
    // direction.
    if (before !== null && current !== null) {
      if (looksDead(before, current)) return "it stopped receiving";
      // Both directions. Bytes arriving with none sent is broadcast noise and
      // says nothing about whether this path reaches anything.
      const moved = movement(before, current);
      if (moved.rx > 0 && moved.tx > 0) {
        this.monitor.carried(path);
        this.failing.delete(path);
        return null;
      }
    }

    if (cameUp) return "it has just started carrying traffic";
    if (this.failing.has(path)) return "it reached nothing when it was last tested";
    return null;
  }
}
