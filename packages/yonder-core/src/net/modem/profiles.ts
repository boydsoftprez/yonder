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
  /**
   * The bearer settings the configuration does not hold, named so they are
   * **removed** rather than left behind (R-CFG-13).
   *
   * Omitting them is what a profile used to do, and `nmcli connection modify`
   * writes only what it is given — so an operator who cleared an APN went on
   * dialling on the old one, with `config.yaml` saying otherwise and nothing
   * anywhere saying which was true. `null` in this file is the configuration's
   * word for *there is no such setting*, and this is that word reaching the
   * device.
   *
   * `password` is null only when `network.modem.password` is null: a reference
   * that names a row the store does not have throws out of `resolve` and fails
   * the render, so a missing secret can never arrive here as "clear it"
   * (R-SEC-10 is why the value itself never appears in a line — an empty one
   * is redacted the same as any other).
   */
  const clear: string[] = [];
  // No default APN, ever. Guessing one is what R-CEL-09 forbids, and the
  // measured cost of guessing wrong is a link that reports success and moves
  // nothing.
  if (modem.apn !== null) settings.unshift(["gsm.apn", modem.apn]);
  else clear.push("gsm.apn");
  if (modem.username !== null) settings.push(["gsm.username", modem.username]);
  else clear.push("gsm.username");
  if (password !== null) settings.push(["gsm.password", password]);
  else clear.push("gsm.password");
  // Only when configured. A QMI or MBIM bearer has no dial step and the link
  // that worked had this empty.
  if (modem.dial !== null) settings.push(["gsm.number", modem.dial]);
  else clear.push("gsm.number");

  return { name: MODEM_CONNECTION, type: "gsm", ifname: iface, settings, clear };
}

/**
 * The settings a bearer that is already dialled will not pick up.
 *
 * NetworkManager does not re-dial a bearer that is up because the profile
 * behind it changed. Measured on the board: connected on `ereseller`,
 * `network.modem.apn` changed to `nxtgenphone` in `config.yaml`, the daemon
 * restarted, the profile rewritten — and `GET /modem/state` went on reporting
 * `apn: ereseller` and the same address. So a written setting that only a
 * dial reads is a setting that has not been applied, and correcting a wrong
 * APN is *the* recovery action this milestone is built around (design spec
 * §2, R-CEL-09): an operator fixing a mistyped APN from the console saw
 * nothing happen at all.
 *
 * **Only the settings that define the bearer are in this list, and that
 * narrowness is the safety property.** `ipv4.route-metric` changes every time
 * a path is stood down or `network.priority` is edited, and `ipv4.method` and
 * `connection.autoconnect` are taken up in place — none of them needs the
 * link cycled, and cycling a working cellular link because its route metric
 * moved is exactly the thing that must not happen on an aircraft. A metric is
 * `device reapply`'s business; see `NetworkRenderer.remetric`.
 *
 * In `appliance` mode there are no such settings at all — the modem dials for
 * itself and this board only speaks DHCP to it — so an appliance is never
 * cycled by this mechanism, which is correct rather than an omission.
 */
export const REDIAL_SETTINGS: ReadonlySet<string> = new Set([
  "gsm.apn",
  "gsm.username",
  "gsm.password",
  "gsm.number",
]);

/**
 * The subset of a profile's settings that a live bearer would not pick up.
 *
 * `cleared` is folded in as an empty value, because a setting being *removed*
 * is a change to the bearer exactly as a setting being altered is — and it is
 * the one the comparison could not see. A property absent from `wanted` is a
 * property `bearerChanges` never asks nmcli about, so clearing an APN wrote
 * the reset and left the modem dialled on the old bearer, which is the same
 * defect R-CEL-09 was written for arriving by a different road.
 */
export function redialSettings(settings: string[][], cleared: string[] = []): string[][] {
  return [...settings, ...cleared.map((name) => [name, ""])]
    .filter(([name]) => name !== undefined && REDIAL_SETTINGS.has(name));
}

/**
 * nmcli's terse `connection show` output, as a property → value map.
 *
 * One `property:value` line per field asked for, in the order asked. Values
 * escape a colon or a backslash with a backslash, so they are unescaped here
 * — an APN containing a colon is not a shape to be surprised by later.
 */
function reported(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    const name = line.slice(0, at).trim();
    if (name === "") continue;
    values.set(name, line.slice(at + 1).replace(/\\(.)/g, "$1").trim());
  }
  return values;
}

/**
 * Which of these settings NetworkManager reports differently from what is
 * wanted — the difference that has to be dialled to take effect.
 *
 * **Silence is never a difference.** A property that is absent from the
 * output, empty, or `--` is one this nmcli would not tell us about, and the
 * commonest reason is that it is a secret: `gsm.password` is not printed
 * without `--show-secrets`, and reading a credential back out of
 * NetworkManager to compare it puts it one accident away from a log line.
 * Treating unreadable as *changed* would cycle the link on every render — the
 * outcome that is unacceptable on an aircraft — so unreadable is treated as
 * "cannot tell", and the cost is recorded here: a modem password changed on
 * its own takes effect when the bearer next dials rather than immediately. It
 * also means a setting going from unset to set is not by itself a re-dial,
 * which costs nothing in practice, because a bearer with no APN is not a
 * bearer that came up.
 *
 * The comparison is made against what nmcli reports **before** the render
 * writes the new profile. Afterwards the stored profile already says what was
 * wanted, and there is nothing left to notice.
 */
export function bearerChanges(wanted: string[][], stdout: string): string[] {
  const values = reported(stdout);
  const changed: string[] = [];
  for (const [name, value] of wanted) {
    if (name === undefined) continue;
    const now = values.get(name);
    if (now === undefined || now === "" || now === "--") continue;
    if (now !== value) changed.push(name);
  }
  return changed;
}
