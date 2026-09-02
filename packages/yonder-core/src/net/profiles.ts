// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { SecretStore } from "../secrets/store.js";
import type { ConnectionSpec } from "./nmcli/client.js";
import { MODEM_CONNECTION, STOOD_DOWN_METRIC, metricFor, modemProfile } from "./modem/profiles.js";
import { NOTHING_STOOD_DOWN, type PathName, type StandingView } from "./reach/standing.js";

export { MODEM_CONNECTION, STOOD_DOWN_METRIC, metricFor };

/**
 * The setup access point's passphrase: published, documented, and the same on
 * every device (ADR-0007, R-SEC-01).
 *
 * It is not a secret and must never be described as one. A per-device value
 * printed to the journal can only be read by someone already on the device,
 * and joining this access point is how you get on the device — so it guarded
 * nothing and locked out the legitimate operator. The credential that matters
 * is the console's administrator password, which the operator sets at first
 * use and which does not exist until they do (R-SEC-09).
 *
 * Named here so the README, the setup procedure and the tests all read one
 * value instead of three copies of a string.
 */
export const DEFAULT_AP_PASSPHRASE = "yonder1234";

export const AP_CONNECTION = "yonder-ap";
export const CLIENT_CONNECTION = "yonder-wifi";
export const ETHERNET_CONNECTION = "yonder-eth";

/**
 * A connection this renderer owns.
 *
 * There is no `autoconnect` field. There used to be one, set on every profile
 * and read by nothing: the behaviour comes entirely from the
 * `connection.autoconnect` pair in `settings`, which is what actually reaches
 * nmcli. A second, dead copy of a safety-relevant flag is worse than none —
 * it reads like the source of truth and cannot be.
 */
export interface DesiredProfile extends ConnectionSpec {
  name: string;
}

/**
 * The access point. `ipv4.method shared` makes NetworkManager run DHCP and
 * masquerade for clients, from a range it derives from `ipv4.addresses` and
 * passes to its own dnsmasq on the command line — which is why the address
 * below is the only thing that decides what clients are given, and why there
 * is no pool in the configuration (K-15, R-NET-02).
 *
 * `connection.autoconnect no` is the one that matters here: the access point
 * is brought up deliberately — by configuration or by the fallback watchdog —
 * never as a side effect of a radio appearing.
 */
export function apProfile(config: Config, psk: string, iface: string): DesiredProfile {
  const ap = config.network.ap;
  return {
    name: AP_CONNECTION,
    type: "wifi",
    ifname: iface,
    settings: [
      ["802-11-wireless.mode", "ap"],
      ["802-11-wireless.ssid", ap.ssid],
      ["802-11-wireless-security.key-mgmt", "wpa-psk"],
      ["802-11-wireless-security.psk", psk],
      ["ipv4.method", "shared"],
      ["ipv4.addresses", ap.address],
      ["connection.autoconnect", "no"],
    ],
  };
}

export function clientProfile(
  config: Config,
  psk: string | null,
  iface: string,
  standing: StandingView = NOTHING_STOOD_DOWN,
): DesiredProfile | null {
  const client = config.network.client;
  if (client.ssid === null || client.ssid === "") return null;

  const metric = String(metricFor(config, "wifi_client", standing));
  const settings: string[][] = [
    ["802-11-wireless.mode", "infrastructure"],
    ["802-11-wireless.ssid", client.ssid],
    ["ipv4.method", "auto"],
    ["ipv4.route-metric", metric],
    ["ipv6.route-metric", metric],
    ["connection.autoconnect", "yes"],
  ];
  if (psk !== null) {
    settings.push(["802-11-wireless-security.key-mgmt", "wpa-psk"]);
    settings.push(["802-11-wireless-security.psk", psk]);
  }
  return { name: CLIENT_CONNECTION, type: "wifi", ifname: iface, settings };
}

export function ethernetProfile(
  config: Config,
  iface: string,
  standing: StandingView = NOTHING_STOOD_DOWN,
): DesiredProfile {
  const metric = String(metricFor(config, "ethernet", standing));
  return {
    name: ETHERNET_CONNECTION,
    type: "ethernet",
    ifname: iface,
    settings: [
      ["ipv4.method", config.network.ethernet.dhcp ? "auto" : "disabled"],
      ["ipv4.route-metric", metric],
      ["ipv6.route-metric", metric],
      ["connection.autoconnect", "yes"],
    ],
  };
}

export interface Interfaces {
  wifi: string | null;
  ethernet: string | null;
  /**
   * The modem's control port — `cdc-wdm0`, not `wwan0` — or the adapter the
   * operator named when the modem is one that dials for itself.
   */
  modem: string | null;
}

/**
 * What the one Wi-Fi radio is doing for a given configuration.
 *
 * A board with built-in Wi-Fi — every Raspberry Pi this runs on — has one
 * radio, and one radio can be an access point or a client, not both. That is
 * physics rather than a defect, and the whole of K-13 is that nothing used to
 * say which.
 *
 * **The configured client wins.** An operator who has entered an SSID and a
 * passphrase has asked for the radio to go and join that network; there is no
 * reading of that request under which the access point is what they wanted.
 * The access point is what they get back automatically when it does not work,
 * which is the rollback engine and the fallback watchdog doing their jobs,
 * not a second interpretation of the configuration.
 */
export type WifiMode = "ap" | "client";

export function wifiMode(config: Config): WifiMode {
  const ssid = config.network.client.ssid;
  return ssid !== null && ssid !== "" ? "client" : "ap";
}

/** One thing the renderer does to the radio, in the order it does it. */
export interface RadioStep {
  action: "up" | "down";
  connection: string;
}

/**
 * The arbitration, as an ordered list.
 *
 * Pure and separate from the renderer so that the *decision* is testable
 * without an nmcli, and so that what this project chose is written down in
 * one readable place rather than distributed through a sequence of `if`s.
 *
 * **Lower before raise, because the hardware gives no choice.**
 *
 * This used to be the other way round, and the reasoning read well: the
 * operator submitting these credentials is talking to the device over the
 * very radio being retuned, so a board that fails to associate should not
 * have already thrown away the thing they are talking through. Raise the
 * client first, then drop the access point.
 *
 * A Raspberry Pi 4 says otherwise:
 *
 *     nmcli connection up yonder-wifi
 *     Error: Connection activation failed: The Wi-Fi network could not be found
 *
 * — with the radio at that moment sitting on channel 6 beaconing as `yonder`.
 * A single radio can *scan* while it serves an access point (observed, and
 * what makes the console's network list work at all), but it cannot
 * **associate**: the interface is busy being an AP, so the network it is
 * asked to join is not there to be found. Every unit test passed, because a
 * fake nmcli activates anything it is asked to.
 *
 * So the access point comes down first, freeing the radio, and only then does
 * the client come up. The operator does lose the page at that moment, and
 * that is not a flaw in the ordering — it is what one radio means.
 *
 * What protects them is not the ordering but everything underneath it: an
 * activation failure fails the render and the engine restores the previous
 * configuration, `NetworkRenderer.settleRadio` raises the access point again
 * when the client did not come up, and the fallback watchdog raises it when
 * nothing is reachable (R-NET-07). All three have now been seen doing so on
 * hardware.
 *
 * The access point goes down in client mode **whatever `ap.enabled` says**.
 * The radio cannot serve both, so leaving it up is not an option the hardware
 * offers; `ap.enabled` decides what happens in AP mode, which is the only
 * mode where there is a choice to make.
 *
 * What this deliberately does not do is delete the access point's *profile*.
 * `nmcli connection up yonder-ap` is the fallback watchdog's only action
 * (R-NET-07) and a profile no render has written is the failure K-16
 * describes — a device unreachable until a power cycle. So the profile is
 * always written and only its activation is arbitrated.
 */
export function radioPlan(config: Config): RadioStep[] {
  if (wifiMode(config) === "client") {
    return [
      { action: "down", connection: AP_CONNECTION },
      { action: "up", connection: CLIENT_CONNECTION },
    ];
  }
  return [{ action: config.network.ap.enabled ? "up" : "down", connection: AP_CONNECTION }];
}

/**
 * Everything the config asks for, for the interfaces this board actually has.
 *
 * The access point's profile is written on any board with a radio, including
 * one configured as a client and one with `ap.enabled` false. It is not
 * activated in either case — `radioPlan` decides that — but it has to *exist*,
 * because raising it is the only move the fallback watchdog has and a
 * watchdog whose one action names a profile nothing created is not a
 * watchdog (R-NET-07, K-16).
 */
export function desiredProfiles(
  config: Config,
  secrets: SecretStore,
  ifaces: Interfaces,
  standing: StandingView = NOTHING_STOOD_DOWN,
): DesiredProfile[] {
  const out: DesiredProfile[] = [];

  if (ifaces.wifi !== null) {
    out.push(apProfile(config, secrets.resolve(config.network.ap.psk), ifaces.wifi));
    const clientPsk = config.network.client.psk === null ? null : secrets.resolve(config.network.client.psk);
    const client = clientProfile(config, clientPsk, ifaces.wifi, standing);
    if (client !== null) out.push(client);
  }
  if (ifaces.ethernet !== null) {
    out.push(ethernetProfile(config, ifaces.ethernet, standing));
  }
  if (ifaces.modem !== null) {
    const password = config.network.modem.password === null
      ? null
      : secrets.resolve(config.network.modem.password);
    const modem = modemProfile(config, password, ifaces.modem, standing);
    if (modem !== null) out.push(modem);
  }
  return out;
}

/**
 * The connections that carry a route metric, and which path each one is.
 *
 * The list `NetworkRenderer.remetric` walks when a path's standing changes,
 * and the reason it is here rather than there: it is the same set
 * `desiredProfiles` writes a metric into, and two lists that must agree
 * would eventually stop agreeing — a connection added to one and not the
 * other is a path that renders with a metric and then never has it rewritten
 * when it stops working.
 *
 * **The access point is not in it, and must never be.** `ipv4.method shared`
 * is how an operator reaches a board with no way out, not a way out. It has
 * no metric to recompute and nothing about a dead egress path is a reason to
 * disturb the one connection the operator may be standing on.
 */
export const EGRESS_CONNECTIONS: readonly (readonly [string, PathName])[] = [
  [ETHERNET_CONNECTION, "ethernet"],
  [CLIENT_CONNECTION, "wifi_client"],
  [MODEM_CONNECTION, "modem"],
];
