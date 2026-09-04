// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";
import type { MmcliClient } from "./mmcli/client.js";

/**
 * The interface a modem's bytes actually go out of, asked of ModemManager.
 *
 * A modem has two names and neither answers both questions: the connection is
 * bound to the control port `cdc-wdm0`, which is what NetworkManager lists,
 * and `wwan0` is what holds the address and carries the traffic. Probing and
 * counting need the second one, and ModemManager is the only thing that knows
 * it. See `pathDevices`, which is where the name is used.
 *
 * **Two facts, and only one of them may be remembered (R-CEL-12).** A modem's
 * *port layout* is a property of the modem, so `mmcli -m` — the expensive read,
 * a screenful of keys — is asked once per modem and kept. That a modem
 * *exists* is a property of the moment, so `mmcli -L` is asked every time and
 * an empty answer forgets the name.
 *
 * Remembering both is the defect this class was extracted to fix: once a modem
 * had been seen, an unplugged one went on being reported as `wwan0` whatever
 * ModemManager and NetworkManager now said, `/reach/state` kept serving a
 * cellular path on hardware that was gone, and the console drew a ready lamp
 * over the words "No modem found".
 *
 * **A question that could not be asked is not an answer.** An `mmcli` that
 * fails keeps the remembered name rather than dropping to the control port:
 * probing `cdc-wdm0` fails on a perfectly good link, and three of those stand
 * a working modem down. Only ModemManager *answering* that it has no modem
 * clears the name — that is an answer, and this is the class of it. A board
 * where mmcli has never worked has nothing remembered and falls back to the
 * device NetworkManager lists, which is better than nothing where the two
 * coincide.
 *
 * Nothing here can reduce reachability (rule 6). A path with no interface is
 * reported absent, and absent paths are neither probed nor stood down; and the
 * fallback watchdog's `carrying` question is about paths *holding addresses*,
 * which a departed modem does not.
 */
export class ModemNetPort {
  /**
   * The last modem seen and the net port it came up on, or null.
   *
   * Keyed by the modem's ModemManager path so that a *different* modem in the
   * same socket is read again rather than inheriting the port layout of the
   * one before it. Only ever holds a name that was found: a modem still coming
   * up has no net port yet, and caching that absence would keep this asking
   * NetworkManager for the control port for the life of the daemon.
   */
  private remembered: { path: string; net: string } | null = null;

  constructor(private readonly client: MmcliClient) {}

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

    let paths: string[];
    try {
      paths = await this.client.modems();
    } catch {
      // Could not ask. See the class comment: a doubt is not evidence that the
      // modem has gone, and the cost of treating it as one is a working link
      // probed on its control port and stood down.
      return this.remembered?.net ?? null;
    }

    const path = paths[0];
    if (path === undefined) {
      // ModemManager answered, and the answer is that there is no modem.
      this.remembered = null;
      return null;
    }
    if (this.remembered?.path === path) return this.remembered.net;

    try {
      const net = (await this.client.modem(path)).ports.net;
      // Not remembered, so the next reading asks again: a modem that has just
      // appeared can be claimed before its net port exists.
      if (net === null) return null;
      this.remembered = { path, net };
      return net;
    } catch {
      return null;
    }
  }
}
