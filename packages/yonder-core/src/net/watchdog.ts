// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";
import type { Config } from "../schema/config.js";
import { NmcliClient } from "./nmcli/client.js";

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
}

/**
 * The guarantee that a device can never be configured into unreachability.
 *
 * R-NET-07 is written as "carries traffic". Byte counters are the wrong
 * test — a connected but idle Ethernet link carries none and is perfectly
 * reachable — so the implemented test is "no interface other than the access
 * point itself holds an IPv4 address". That is what "you can still reach me"
 * actually means.
 *
 * On any doubt, including nmcli failing outright, the access point comes up.
 * A spurious access point costs an operator nothing; a missing one costs a
 * card reader and a trip to wherever the aircraft is.
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

  /** True when some interface other than the access point holds an address. */
  async check(): Promise<boolean> {
    const apAddress = this.opts.config.network.ap.address.split("/")[0];
    try {
      const active = await this.opts.client.activeIpv4();
      return active.some(
        (a) =>
          a.device !== "lo" &&
          !a.address.startsWith("127.") &&
          a.address.split("/")[0] !== apAddress,
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
