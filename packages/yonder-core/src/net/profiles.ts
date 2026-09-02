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
 * **Raise before lower.** In client mode the client comes up first and only
 * then does the access point go down. The operator submitting these
 * credentials is standing in the failure — they are talking to this device
 * over the very radio being retuned — so a board that fails to associate must
 * not have already thrown away the thing they are talking through. The
 * renderer additionally raises the access point again if the client's
 * activation fails and nothing else is up; see NetworkRenderer.settleRadio.
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
      { action: "up", connection: CLIENT_CONNECTION },
      { action: "down", connection: AP_CONNECTION },
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
