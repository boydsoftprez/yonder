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
    const ms = fallback.timeout * 1000;
    this.log(`fallback: will check for a reachable interface in ${fallback.timeout} s`);
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
