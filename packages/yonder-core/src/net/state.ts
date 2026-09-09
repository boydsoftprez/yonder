// SPDX-License-Identifier: GPL-3.0-or-later
import { AP_CONNECTION, CLIENT_CONNECTION, wifiMode } from "./profiles.js";
import type { Config } from "../schema/config.js";
import type { DeviceInfo } from "./nmcli/client.js";

/**
 * What the radio is doing, in the words a status line uses.
 *
 * The console had the raw configuration on screen — a client SSID, an access
 * point SSID — and left the operator to work out which one was in force. On a
 * board that had just joined a network, standing on the page that joined it,
 * that was not answerable: both fields had values and neither said which was
 * live. "Am I still connected? Am I sitting in limbo?" is the question this
 * exists to answer in one line.
 *
 * Computed from the configuration *and* the device list, because the two can
 * disagree and the operator needs what is true rather than what was asked
 * for. A configuration naming a network the radio never associated with is
 * exactly the state an apply is about to revert, and reporting it as "joined"
 * would be a lie at the worst moment.
 */

export type RadioMode = "access-point" | "joined" | "joining" | "off";

export interface NetworkState {
  mode: RadioMode;
  /** A phrase for the status line: what the radio is doing, in one go. */
  summary: string;
  /** The network this device is on, when it is on one. */
  network: string | null;
  /** Its address there, when it has one. */
  address: string | null;
}

/** The first IPv4 address an interface holds, without its prefix. */
function addressOf(addresses: { device: string; address: string }[], device?: string): string | null {
  if (device === undefined) return null;
  const found = addresses.find((a) => a.device === device);
  return found === undefined ? null : (found.address.split("/")[0] ?? null);
}

const WORDS: Record<RadioMode, string> = {
  "access-point": "Serving its own access point",
  joined: "Joined a network",
  joining: "Joining — not connected yet",
  off: "Radio off",
};

export function networkState(
  config: Config,
  devices: DeviceInfo[],
  addresses: { device: string; address: string }[] = [],
): NetworkState {
  const wifi = devices.find((d) => d.type === "wifi");
  const active = wifi?.connection ?? "";
  const wanted = wifiMode(config);

  if (active === CLIENT_CONNECTION) {
    const ssid = config.network.client.ssid;
    return {
      mode: "joined",
      summary: ssid === null || ssid === "" ? WORDS.joined : `Joined ${ssid}`,
      network: ssid,
      address: addressOf(addresses, wifi?.device),
    };
  }

  if (active === AP_CONNECTION) {
    return {
      mode: "access-point",
      summary: `${WORDS["access-point"]}: ${config.network.ap.ssid}`,
      network: config.network.ap.ssid,
      address: addressOf(addresses, wifi?.device),
    };
  }

  // The configuration asks for a network the radio is not on. Either the
  // apply is still settling, or it failed and is about to be rolled back.
  if (wanted === "client") {
    return { mode: "joining", summary: WORDS.joining, network: config.network.client.ssid, address: null };
  }
  return { mode: "off", summary: WORDS.off, network: null, address: null };
}
