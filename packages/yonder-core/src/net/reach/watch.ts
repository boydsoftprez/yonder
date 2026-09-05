// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../../apply/types.js";
import { looksDead, movement, systemCounters, type Counters, type CounterReader } from "./counters.js";
import { withDeadline } from "../deadline.js";
import type { ReachMonitor } from "./monitor.js";
import { PATH_WORDS, REACH_TICK_DEADLINE_MS, REACH_TICK_MS, type PathName } from "./standing.js";

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
 * probe happens only for one of four reasons, and all four are events:
 *
 *  - **The path has just started carrying traffic.** R-CEL-09's "tested with
 *    real traffic when it comes up". Without this the case the milestone is
 *    named for is missed entirely: a freshly booted board with a wrong APN,
 *    no Ethernet and no Wi-Fi transmits almost nothing, `looksDead` needs
 *    real bytes to have left, and so the counters would never say anything
 *    about the one link that is broken (K-42).
 *  - **The path stopped receiving** — bytes going out with nothing coming
 *    back, which is `looksDead`, and is §2's failure written in counters.
 *  - **The path failed its last test.** The hysteresis needs *consecutive*
 *    evidence, and a link that has failed and then goes quiet looks exactly
 *    like an idle one — so a single trigger per event could never reach
 *    `FAILURES_TO_STAND_DOWN` in the field, and the demotion this whole
 *    mechanism exists for would never happen. This is the only one of the
 *    three that repeats, and it only ever runs while something is broken.
 *  - **The renderer says a path was re-dialled** — `redialled()`, below.
 *    Also R-CEL-09's "when it comes up", for the case the first reason
 *    cannot see: a re-dial keeps the same interface name, so the device
 *    comparison above notices nothing, and a cellular link that is not the
 *    path in use moves no counters either. Measured on the board — the APN
 *    was corrected to a wrong one, the modem moved onto a new bearer and a
 *    new address, nothing tested it, and the console went on calling it
 *    ready. This is the only reason that tests a path which is not the one
 *    in use.
 *
 * Traffic moving both ways is folded in as a success, which costs nothing and
 * is how a path returns from being stood down without a probe running at all.
 * Silence in both directions decides nothing: an idle link is not a dead one,
 * and that is the mistake `looksDead` was written to refuse.
 *
 * It cannot throw into its own timer, and it cannot hang in one either. A
 * daemon that stopped probing silently would leave standing frozen at
 * whatever it last was, with nothing saying so — worse than one that never
 * probed, because `carrying()` would go on answering from stale evidence.
 * Rejection is caught; an answer that never arrives is bounded by
 * `REACH_TICK_DEADLINE_MS` and the tick abandoned, because a hang is not a
 * throw and a `catch` does not cover one.
 */
/** Why a re-dialled path is being tested, in the words an operator reads. */
const REDIALLED = "it has just been dialled again";

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
  /**
   * Paths the renderer has said were re-dialled, waiting for the next tick.
   *
   * Held rather than probed on the spot, because the loop is chained
   * precisely so that two `curl`s never land on the same interface and no
   * tick reads the counters across another one's traffic. A re-dial arriving
   * mid-tick would be exactly that. One tick is at most `REACH_TICK_MS`
   * away, which is the same delay a link coming up any other way already
   * waits, and the honest answer arrives that much later rather than racing
   * a reading it would corrupt.
   */
  private redials = new Set<PathName>();
  /** Which tick owns the readings above. See schedule(). */
  private generation = 0;

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
   * The next tick is armed only once this one has finished — or been given
   * up on — so a tick that spends three probe timeouts cannot have a second
   * one start behind it, which would put two `curl`s on the same interface
   * and read the counters across each other's traffic.
   *
   * Chaining is also what makes a hang fatal without the deadline: nothing
   * else re-arms this loop. So a tick that outlives `REACH_TICK_DEADLINE_MS`
   * is abandoned and said so in one line, and the generation counter in
   * `tick()` makes sure the one that was given up on cannot come back later
   * and write anything over a newer one. **Anything**, not only the counter
   * reading it took: the probe it started is still out there too, and its
   * result reaches standing from inside `ReachMonitor.test`, so the same
   * question is asked there rather than only here.
   */
  private schedule(): void {
    this.timer = this.clock.setTimer(this.tickMs, () => {
      this.timer = undefined;
      void (async () => {
        try {
          await withDeadline(this.clock, REACH_TICK_DEADLINE_MS, this.tick(), () => {
            this.log("network: a check of which way out is working did not finish in time; going on without it");
          });
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
   * A path has just been re-dialled and must be tested (R-CEL-09).
   *
   * The renderer's notification, and the only way into this watch from
   * outside. It records and returns; the probe runs on the next tick, in the
   * loop that already serialises probes against one another.
   *
   * **It cannot fail and it cannot block.** The caller is a render that has
   * already succeeded — the operator's corrected APN is dialled and up — and
   * a render turned into a failure here would be rolled back by the
   * confirmation timer (R-CFG-03). So this does one set insertion and
   * nothing else.
   *
   * A path named twice before the next tick is tested once: it is a set, and
   * two re-dials in five seconds are still one link that needs one answer.
   */
  redialled(path: PathName): void {
    if (this.stopped) return;
    this.redials.add(path);
  }

  /**
   * Look at the path in use, test only if something says to, and answer for
   * anything that has just been re-dialled.
   *
   * Public so that the decision is testable one step at a time rather than
   * only through a timer, and so a future route could ask for the check R-CEL-09
   * calls "on request" without waiting for the next tick.
   */
  async tick(): Promise<void> {
    const mine = ++this.generation;
    // A tick that was given up on has no business writing anything a newer
    // one is keeping — not the counter readings, and not the probe results
    // either. Its answers are about a moment that has passed, and the deadline
    // abandons the *wait*, not the *work*, so every `await` below is followed
    // by this question again.
    const stillMine = (): boolean => mine === this.generation;

    // Taken and cleared before the first `await`, so a re-dial that lands
    // while this tick is running belongs to the next one and is not silently
    // dropped by the clear.
    const redialled = this.redials;
    this.redials = new Set();

    const now = await this.monitor.inUseNow();
    if (!stillMine()) return;
    if (now === null) {
      // Nothing is carrying traffic, or nothing this monitor has a path for.
      // There is no subject for any of the questions below, and the readings
      // held from a previous path would be about a different interface.
      this.previous = null;
      this.lastPath = null;
      this.lastDevice = null;
      // A re-dialled path still gets its answer. A board whose modem is the
      // only path, dialled onto an APN that reaches nothing, may be holding
      // no address at all — and that is exactly the board this exists for.
      await this.testRedialled(redialled, null, stillMine);
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

    // A re-dial outranks the counters. They are absolute numbers about one
    // interface, and a re-dial does not rename it — so a reading taken before
    // the modem was dialled again is compared against one taken after, and
    // traffic the old bearer carried would be read as evidence about the new
    // one. There is only one honest answer for a link that has just come up,
    // and it is a probe.
    const why = redialled.has(path)
      ? REDIALLED
      : this.reason(path, cameUp, before, current);
    if (why === null) {
      await this.testRedialled(redialled, path, stillMine);
      return;
    }

    const reached = await this.probe(path, why, stillMine);
    if (!stillMine()) return;
    if (reached) {
      await this.testRedialled(redialled, path, stillMine);
      return;
    }

    // The path carrying traffic reached nothing. Test the others, so that
    // standing says which of them can take over rather than only naming the
    // one that failed — `test` returns immediately for a path this board does
    // not have, so a device with one interface pays nothing for this.
    for (const other of this.monitor.priority()) {
      if (other === path) continue;
      // Already covered: this loop is testing it now, and one answer per
      // path per tick is the whole of what a re-dial is owed.
      redialled.delete(other);
      await this.monitor.test(other, stillMine);
      if (!stillMine()) return;
    }
    // Anything re-dialled that the operator's order does not name — a path
    // taken out of `network.priority` while its modem is still dialling.
    await this.testRedialled(redialled, path, stillMine);
  }

  /**
   * Test every path a re-dial named, except the one already tested this tick.
   *
   * **This is the only probe in this class that runs for a path which is not
   * the one in use**, and it is why the defect it fixes existed: cellular is
   * usually the standby path, so neither the device-name comparison above nor
   * the byte counters ever had anything to say about it (R-CEL-09).
   */
  private async testRedialled(
    paths: Set<PathName>,
    done: PathName | null,
    stillMine: () => boolean,
  ): Promise<void> {
    for (const path of paths) {
      if (path === done) continue;
      await this.probe(path, REDIALLED, stillMine);
      if (!stillMine()) return;
    }
  }

  /** One probe, said out loud, with the failing set kept in step. */
  private async probe(path: PathName, why: string, stillMine: () => boolean): Promise<boolean> {
    this.log(`network: testing ${PATH_WORDS[path]} because ${why}`);
    // `stillMine` goes into the call as well as being asked after it: the
    // recording happens inside `test`, so a guard only out here would let a
    // stale answer reach standing before this line ever ran again.
    const reached = await this.monitor.test(path, stillMine);
    if (!stillMine()) return reached;
    if (reached) this.failing.delete(path);
    else this.failing.add(path);
    return reached;
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
