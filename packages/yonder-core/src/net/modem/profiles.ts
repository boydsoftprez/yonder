// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";
import type { DesiredProfile } from "../profiles.js";

export const MODEM_CONNECTION = "yonder-modem";

/**
 * Route metrics, generated from `network.priority` (R-NET-06).
 *
 * The numbers are NetworkManager's own defaults for these connection types,
 * read off a board: ethernet 100, gsm 700. Keeping them means a Yonder-written
 * profile sorts against a connection Yonder did not write exactly as it would
 * have anyway, which matters on a board where an operator has added one.
 */
const METRIC_BY_RANK = [100, 700, 800, 900];

export function metricFor(config: Config, iface: "ethernet" | "modem" | "wifi_client"): number {
  const rank = config.network.priority.indexOf(iface);
  return METRIC_BY_RANK[rank === -1 ? METRIC_BY_RANK.length - 1 : rank] ?? 900;
}

/**
 * The modem's connection, in whichever of its two forms applies.
 *
 * `auto` is a `gsm` connection bound to the modem's **control** port —
 * `cdc-wdm0` on the measured board, not `wwan0`, which is where the address
 * and every byte end up. NetworkManager reaches the modem through
 * ModemManager; nothing here drives ModemManager itself.
 *
 * `appliance` is an ordinary ethernet connection on an adapter the operator
 * named, because a modem that dials for itself is a network adapter as far as
 * this board is concerned (R-CEL-11).
 *
 * `connection.autoconnect yes` is what satisfies R-CEL-06: a modem that drops
 * and returns is NetworkManager's business to reconnect, not a loop of
 * Yonder's. Rule 4's spirit as much as its letter — Yonder does not build
 * control loops it can delegate.
 */
export function modemProfile(
  config: Config,
  password: string | null,
  iface: string,
): DesiredProfile | null {
  const modem = config.network.modem;
  if (!modem.enabled) return null;

  const metric = String(metricFor(config, "modem"));

  if (modem.mode === "appliance") {
    return {
      name: MODEM_CONNECTION,
      type: "ethernet",
      ifname: iface,
      settings: [
        ["ipv4.method", "auto"],
        ["ipv4.route-metric", metric],
        ["ipv6.route-metric", metric],
        ["connection.autoconnect", "yes"],
      ],
    };
  }

  const settings: string[][] = [
    ["ipv4.method", "auto"],
    ["ipv4.route-metric", metric],
    ["ipv6.route-metric", metric],
    ["connection.autoconnect", "yes"],
  ];
  // No default APN, ever. Guessing one is what R-CEL-09 forbids, and the
  // measured cost of guessing wrong is a link that reports success and moves
  // nothing.
  if (modem.apn !== null) settings.unshift(["gsm.apn", modem.apn]);
  if (modem.username !== null) settings.push(["gsm.username", modem.username]);
  if (password !== null) settings.push(["gsm.password", password]);
  // Only when configured. A QMI or MBIM bearer has no dial step and the link
  // that worked had this empty.
  if (modem.dial !== null) settings.push(["gsm.number", modem.dial]);

  return { name: MODEM_CONNECTION, type: "gsm", ifname: iface, settings };
}
