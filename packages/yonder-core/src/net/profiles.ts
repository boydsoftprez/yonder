// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";
import type { SecretStore } from "../secrets/store.js";

export const AP_CONNECTION = "yonder-ap";
export const CLIENT_CONNECTION = "yonder-wifi";
export const ETHERNET_CONNECTION = "yonder-eth";

export interface DesiredProfile {
  name: string;
  settings: string[][];
  autoconnect: boolean;
}

/**
 * The access point. `ipv4.method shared` makes NetworkManager run DHCP and
 * masquerade for clients; the pool itself comes from a dnsmasq drop-in, see
 * dnsmasq.ts. autoconnect is false because the access point is brought up
 * deliberately — by configuration or by the fallback watchdog — never as a
 * side effect of a radio appearing.
 */
export function apProfile(config: Config, psk: string, iface: string): DesiredProfile {
  const ap = config.network.ap;
  return {
    name: AP_CONNECTION,
    autoconnect: false,
    settings: [
      ["type", "wifi"],
      ["ifname", iface],
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
    ["type", "wifi"],
    ["ifname", iface],
    ["802-11-wireless.mode", "infrastructure"],
    ["802-11-wireless.ssid", client.ssid],
    ["ipv4.method", "auto"],
    ["connection.autoconnect", "yes"],
  ];
  if (psk !== null) {
    settings.push(["802-11-wireless-security.key-mgmt", "wpa-psk"]);
    settings.push(["802-11-wireless-security.psk", psk]);
  }
  return { name: CLIENT_CONNECTION, autoconnect: true, settings };
}

export function ethernetProfile(config: Config, iface: string): DesiredProfile {
  return {
    name: ETHERNET_CONNECTION,
    autoconnect: true,
    settings: [
      ["type", "ethernet"],
      ["ifname", iface],
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
