// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import { withDeadline } from "./deadline.js";
import { NmcliClient } from "./nmcli/client.js";

/**
 * How long `carrying` is given to answer before the answer is "cannot tell".
 *
 * Wiring a reach monitor in put `mmcli -L` and `mmcli -m` on this check's
 * critical path, and a wedged ModemManager never answers either. Before this
 * bound, a board that held an address — so the address check did not
 * short-circuit — while ModemManager was stuck on a D-Bus call left `check()`
 * unresolved for ever: `fire()` never reached `apUp()`, and the device stayed
 * unreachable until somebody pulled the card. That is rule 6, and a hang is
 * not a throw, so the `try` below never saw it.
 *
 * Ten seconds is far longer than three local `nmcli` reads and a modem
 * interrogation, and small against the shortest fallback window the schema
 * allows (30 s), so a late answer delays the access point rather than
 * replacing it. Expiry means *raise*, for the same reason nmcli failing does.
 */
export const CARRYING_DEADLINE_MS = 10_000;

export interface FallbackWatchdogOptions {
  client: NmcliClient;
  clock: Clock;
  config: Config;
  apUp: () => Promise<void>;
  log?: (line: string) => void;
  /**
   * When the deadline is measured from. Defaults to the moment start() runs.
   *
   * R-NET-07 gives a number of seconds "from start-up", and the daemon does
   * real work before it can arm this — recovery, and the start-up render,
   * each of which can spend up to renderTimeoutMs inside a single renderer.
   * Measuring from a caller-supplied instant means slow start-up work eats
   * into the window rather than pushing the deadline out behind it.
   */
  since?: number;
  /**
   * Whether any path is actually carrying traffic.
   *
   * R-NET-07 has always said "carries traffic". This check implemented it as
   * "holds an address" because a connected but idle Ethernet link carries
   * none and is perfectly reachable — sound reasoning, and broken by
   * cellular: a modem with a wrong APN registers, attaches, takes an address
   * and installs a route while completing no request. That satisfied the old
   * test, and a device configured that way from the boot partition with no
   * other path never raised its access point (K-40).
   *
   * **Absent means "nobody told me", and the answer is unchanged from before
   * this existed: an address is accepted.** A daemon assembled without a
   * reach monitor must not become one that raises an access point on a
   * working device.
   */
  carrying?: () => Promise<boolean>;
}

/**
 * The guarantee that a device can never be configured into unreachability.
 *
 * R-NET-07 is written as "carries traffic". Byte counters are the wrong
 * test — a connected but idle Ethernet link carries none and is perfectly
 * reachable — so the base test is "no interface other than the access point
 * itself holds an IPv4 address". Cellular breaks that reasoning: a modem
 * with a wrong APN can hold an address while carrying nothing (K-40), so an
 * address is necessary but, when a `carrying` reach monitor is wired in, no
 * longer sufficient on its own.
 *
 * On any doubt, including nmcli failing outright and nobody answering at all,
 * the access point comes up. A spurious access point costs an operator a
 * moment; a missing one costs a card reader and a trip to wherever the
 * aircraft is.
 */
export class FallbackWatchdog {
  private readonly opts: FallbackWatchdogOptions;
  private readonly log: (line: string) => void;
  private timer: unknown;

  constructor(opts: FallbackWatchdogOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    const fallback = this.opts.config.network.ap.fallback;
    if (!fallback.enabled) {
      this.log("fallback: disabled by configuration");
      return;
    }
    // Whatever start-up has already spent comes out of the window, so the
    // deadline lands where R-NET-07 says it does rather than that many
    // seconds after however long the daemon took to get here. Clamped at
    // zero: a start-up slower than the whole window checks immediately.
    const window = fallback.timeout * 1000;
    const elapsed = Math.max(0, this.opts.clock.now() - (this.opts.since ?? this.opts.clock.now()));
    const ms = Math.max(0, window - elapsed);
    this.log(`fallback: will check for a reachable interface in ${Math.round(ms / 1000)} s`);
    this.timer = this.opts.clock.setTimer(ms, () => { void this.fire(); });
  }

  stop(): void {
    if (this.timer !== undefined) {
      this.opts.clock.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * True when some interface other than the access point holds an address
   * and, if a reach monitor is wired in, is carrying traffic.
   */
  async check(): Promise<boolean> {
    const apAddress = this.opts.config.network.ap.address.split("/")[0];
    try {
      const active = await this.opts.client.activeIpv4();
      const holdsAddress = active.some(
        (a) =>
          a.device !== "lo" &&
          !a.address.startsWith("127.") &&
          a.address.split("/")[0] !== apAddress,
      );
      if (!holdsAddress) return false;
      // An address is necessary and, since cellular, no longer sufficient.
      if (this.opts.carrying === undefined) return true;
      // Bounded, because answering it now reaches ModemManager and a wedged
      // ModemManager answers nothing at all. On any doubt the access point
      // comes up, and "nobody answered" is a doubt.
      return await withDeadline(
        this.opts.clock,
        CARRYING_DEADLINE_MS,
        this.opts.carrying(),
        () => {
          this.log(
            `fallback: nothing said whether traffic is flowing within `
            + `${Math.round(CARRYING_DEADLINE_MS / 1000)} s; assuming none`,
          );
          return false;
        },
      );
    } catch (e) {
      this.log(`fallback: cannot determine reachability (${(e as Error).message}); assuming none`);
      return false;
    }
  }

  private async fire(): Promise<void> {
    this.timer = undefined;
    if (await this.check()) {
      this.log("fallback: an interface is reachable, leaving the access point alone");
      return;
    }
    this.log("fallback: nothing reachable, bringing the access point up");
    try {
      await this.opts.apUp();
    } catch (e) {
      this.log(`fallback: could not bring the access point up: ${(e as Error).message}`);
    }
  }
}
