// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../../schema/config.js";
import type { DesiredProfile } from "../profiles.js";
import { NOTHING_STOOD_DOWN, type PathName, type StandingView } from "../reach/standing.js";

export const MODEM_CONNECTION = "yonder-modem";

/**
 * Route metrics, generated from `network.priority` (R-NET-06).
 *
 * The numbers are NetworkManager's own defaults for these connection types,
 * read off a board: ethernet 100, gsm 700. Keeping them means a Yonder-written
 * profile sorts against a connection Yonder did not write exactly as it would
 * have anyway, which matters on a board where an operator has added one.
 *
 * **Every egress profile gets one, not just the modem.** Left to
 * NetworkManager's defaults the Wi-Fi client sits at 600 and the modem at
 * 700, so at the shipped `priority: [ethernet, modem, wifi_client]` the radio
 * outranks the modem while the configuration says the opposite — and a
 * `priority` beginning `[modem, ethernet, …]` would tie the two at 100 and
 * express nothing at all. It is more than untidiness because
 * `net/reach/monitor.ts` derives the path traffic is leaving by from
 * `network.priority` on the stated premise that the metrics were generated
 * from it; with two addresses up and no metrics written, the watch reads the
 * wrong device's counters and judges the wrong link.
 *
 * The access point is deliberately not in this list. `ipv4.method shared`
 * hands out addresses and masquerades for clients — it is how an operator
 * reaches a board with no way out, not a way out — so it has no place in an
 * ordering of egress paths.
 */
const METRIC_BY_RANK = [100, 700, 800, 900];

/**
 * What is added to a path's generated metric while it is stood down.
 *
 * **A metric, and deliberately not a disconnect.** A path that has stopped
 * reaching the internet has not stopped being a way to reach *this device*:
 * an operator may be sitting on the very cable that has just been stood down,
 * and `nmcli device disconnect` or a lowered connection would take the
 * on-link route with it and strand them. Rule 6 is the whole reason this is
 * a number and not a command. Raising the metric moves the default route and
 * nothing else — the link keeps its carrier, its address and its own subnet.
 *
 * **Added to the generated metric rather than replacing it**, so that the
 * operator's order still decides between two paths that have both been stood
 * down. Without that they would tie, the kernel would break the tie however
 * it liked, and `pathInUse`'s premise — that the metrics follow
 * `network.priority` — would stop holding on exactly the board where it
 * matters most.
 *
 * A million is far above anything NetworkManager generates for itself (the
 * measured board's own defaults are 100, 600 and 700) and far below what a
 * kernel route metric can hold, so a demoted path loses to every healthy one
 * including connections Yonder did not write.
 */
export const STOOD_DOWN_METRIC = 1_000_000;

/**
 * The metric this path gets, from the operator's order and its standing.
 *
 * The standing is an **input to generating the metric**, never a second
 * writer of one: `config.yaml` states preference, this function turns that
 * into numbers, and the renderer is still the only thing that writes them
 * (R-NET-13). The default is a board where nothing has been stood down, so
 * every caller that does not know about standing behaves exactly as it did.
 */
export function metricFor(
  config: Config,
  iface: PathName,
  standing: StandingView = NOTHING_STOOD_DOWN,
): number {
  const rank = config.network.priority.indexOf(iface);
  const base = METRIC_BY_RANK[rank === -1 ? METRIC_BY_RANK.length - 1 : rank] ?? 900;
  return standing.isStoodDown(iface) ? base + STOOD_DOWN_METRIC : base;
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
  standing: StandingView = NOTHING_STOOD_DOWN,
): DesiredProfile | null {
  const modem = config.network.modem;
  if (!modem.enabled) return null;

  const metric = String(metricFor(config, "modem", standing));

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
