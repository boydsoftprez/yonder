// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../../apply/types.js";
import type { Config } from "../../schema/config.js";
import { withDeadline } from "../deadline.js";
import type { MmcliClient } from "./mmcli/client.js";

/**
 * How long the two ModemManager reads get before the last known answer is used.
 *
 * A hang is not a throw. The production runner kills a command after
 * `RUN_TIMEOUT_MS` — two minutes — and a wedged ModemManager on a D-Bus call
 * is an everyday failure mode for a USB modem that enumerated badly, so
 * without a bound here every reachability reading waits that long: a
 * `/reach/state` the console gives up on, a reach tick abandoned by its own
 * deadline while its `mmcli` child lives on, another started five seconds
 * later, and a fallback watchdog whose `carrying` question expires into
 * raising the access point on a board where another path is working.
 *
 * Two seconds is far longer than the two local reads it covers — tens of
 * milliseconds on the measured board — and small against both the things it
 * sits inside: `REACH_TICK_MS` (5 s), so readings cannot pile up, and
 * `CARRYING_DEADLINE_MS` (10 s), so interrogating the modem is never what
 * makes the watchdog's question late.
 */
export const MODEM_READ_DEADLINE_MS = 2_000;

/** A modem seen at a ModemManager path, and the net port it came up on. */
interface SeenModem {
  path: string;
  net: string;
}

/**
 * The interface a modem's bytes actually go out of, asked of ModemManager.
 *
 * A modem has two names and neither answers both questions: the connection is
 * bound to the control port `cdc-wdm0`, which is what NetworkManager lists,
 * and `wwan0` is what holds the address and carries the traffic. Probing and
 * counting need the second one, and ModemManager is the only thing that knows
 * it. See `pathDevices`, which is where the name is used.
 *
 * **Read now, every time (R-CEL-13).** Nothing here is remembered in order to
 * skip a reading. The defect this class was extracted to fix was a name kept
 * for the life of the daemon: once a modem had been seen, an unplugged one
 * went on being reported as `wwan0` whatever ModemManager and NetworkManager
 * now said, `/reach/state` kept serving a cellular path on hardware that was
 * gone, and the console drew a ready lamp over the words "No modem found".
 *
 * Caching the port layout against the modem's ModemManager path would fix the
 * unplugged case and leave a narrower one open: those paths are numbered per
 * service run, so a ModemManager that restarts hands `…/Modem/0` to whatever
 * is there next, and a stick swapped across that restart would inherit the
 * departed one's port. The two reads cost two subprocesses alongside the
 * `nmcli` ones the same reachability reading already spends, which is not
 * worth an identity assumption that is wrong exactly when a modem has been
 * changed.
 *
 * **What is remembered is the answer to a reading that did not happen.** An
 * `mmcli` that fails or hangs must not drop this to the control port: probing
 * `cdc-wdm0` fails on a perfectly good link, and three of those stand a
 * working modem down. So a failed or late reading answers with the last name
 * actually observed, and only ModemManager *answering* that it has no modem
 * clears it — that is an answer, and this is the class of it. A board where
 * mmcli has never worked has nothing to fall back on and returns null, which
 * puts `pathDevices` back on the device NetworkManager lists.
 *
 * Nothing here can reduce reachability (rule 6). A path with no interface is
 * reported absent, and absent paths are neither probed nor stood down; and the
 * fallback watchdog's `carrying` question is about paths *holding addresses*,
 * which a departed modem does not.
 */
export class ModemNetPort {
  /**
   * The last modem actually seen, or null. Read only when a reading fails.
   *
   * The path is kept alongside the name because the name is only an answer for
   * the modem it was read from: a `mmcli -m` that fails against a path this
   * has never seen has nothing to fall back on.
   */
  private seen: SeenModem | null = null;

  /**
   * Which reading owns `seen`, so that one abandoned by the deadline cannot
   * come back and overwrite what a newer one recorded. The same generation
   * guard `ReachWatch.tick` keeps, for the same reason: the deadline abandons
   * the *wait*, not the *work*.
   */
  private generation = 0;

  constructor(
    private readonly client: MmcliClient,
    /** Injected, like every other timer in this daemon: nothing waits on the wall clock. */
    private readonly clock: Clock,
  ) {}

  /**
   * The net port, or null to fall back to the device NetworkManager lists.
   *
   * Asked only when configuration says there is an automatic modem, so a board
   * without one spends nothing. An appliance is already named as the adapter
   * it is (R-CEL-11) and there is no second name to reconcile.
   */
  async interfaceFor(config: Config): Promise<string | null> {
    const modem = config.network.modem;
    if (!modem.enabled || modem.mode !== "auto") return null;

    const mine = ++this.generation;
    const isCurrent = (): boolean => mine === this.generation;
    return withDeadline(
      this.clock,
      MODEM_READ_DEADLINE_MS,
      this.read(isCurrent),
      // Late. Which of the two reads is stuck is not knowable from here, so
      // this answers with the last name observed rather than with nothing.
      () => this.seen?.net ?? null,
    );
  }

  /** One reading, both reads, no bound of its own. See interfaceFor. */
  private async read(isCurrent: () => boolean): Promise<string | null> {
    let paths: string[];
    try {
      paths = await this.client.modems();
    } catch {
      return this.seen?.net ?? null;
    }

    const path = paths[0];
    if (path === undefined) {
      // ModemManager answered, and the answer is that there is no modem.
      if (isCurrent()) this.seen = null;
      return null;
    }

    try {
      const net = (await this.client.modem(path)).ports.net;
      // A modem can be claimed before its net port exists. Nothing is recorded
      // for that, so the next reading asks again rather than leaving this on
      // the control port for the life of the daemon.
      if (net === null) return null;
      if (isCurrent()) this.seen = { path, net };
      return net;
    } catch {
      // Could not ask about this modem. A remembered name answers for the
      // modem it was read from and for no other.
      return this.seen?.path === path ? this.seen.net : null;
    }
  }
}
