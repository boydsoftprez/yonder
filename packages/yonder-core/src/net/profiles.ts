// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { SecretStore } from "../secrets/store.js";
import type { ConnectionSpec } from "./nmcli/client.js";

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
 * is no pool in the configuration (K-14, R-NET-02).
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

export function clientProfile(config: Config, psk: string | null, iface: string): DesiredProfile | null {
  const client = config.network.client;
  if (client.ssid === null || client.ssid === "") return null;

  const settings: string[][] = [
    ["802-11-wireless.mode", "infrastructure"],
    ["802-11-wireless.ssid", client.ssid],
    ["ipv4.method", "auto"],
    ["connection.autoconnect", "yes"],
  ];
  if (psk !== null) {
    settings.push(["802-11-wireless-security.key-mgmt", "wpa-psk"]);
    settings.push(["802-11-wireless-security.psk", psk]);
  }
  return { name: CLIENT_CONNECTION, type: "wifi", ifname: iface, settings };
}

export function ethernetProfile(config: Config, iface: string): DesiredProfile {
  return {
    name: ETHERNET_CONNECTION,
    type: "ethernet",
    ifname: iface,
    settings: [
      ["ipv4.method", config.network.ethernet.dhcp ? "auto" : "disabled"],
      ["connection.autoconnect", "yes"],
    ],
  };
}

export interface Interfaces {
  wifi: string | null;
  ethernet: string | null;
}

/** Everything the config asks for, for the interfaces this board actually has. */
export function desiredProfiles(config: Config, secrets: SecretStore, ifaces: Interfaces): DesiredProfile[] {
  const out: DesiredProfile[] = [];

  if (ifaces.wifi !== null) {
    out.push(apProfile(config, secrets.resolve(config.network.ap.psk), ifaces.wifi));
    const clientPsk = config.network.client.psk === null ? null : secrets.resolve(config.network.client.psk);
    const client = clientProfile(config, clientPsk, ifaces.wifi);
    if (client !== null) out.push(client);
  }
  if (ifaces.ethernet !== null) {
    out.push(ethernetProfile(config, ifaces.ethernet));
  }
  return out;
}
