// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";

/**
 * Turning "join this network" into a configuration (R-NET-03).
 *
 * A browser form produces two strings. What the apply engine takes is a whole
 * configuration document, because that is what it validates and what it
 * snapshots as the rollback target. The step in between is this function, and
 * it is here rather than in a page for the reason CLAUDE.md rule 2 gives: a
 * form that merged into a configuration would be doing it in wiring, in a
 * browser, to the document that decides whether the device is reachable.
 *
 * Pure apart from one thing it is handed: somewhere to put the passphrase.
 * The passphrase never goes into `config.yaml` — that file is 0644 and read by
 * anything on the device — so it goes into `secrets.yaml` and the
 * configuration carries a reference to it. That is the same shape the access
 * point's own passphrase has had since M0.
 */

/** The name the Wi-Fi client's passphrase is stored under in secrets.yaml. */
export const CLIENT_PSK_SECRET = "wifi_psk";

export interface JoinRequest {
  ssid?: unknown;
  psk?: unknown;
}

/** Somewhere to put a secret. `SecretStore` satisfies this; a test can fake it. */
export interface SecretSink {
  put(name: string, value: string): void;
}

export type JoinResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

/**
 * WPA2's own limits. Below 8 characters no access point will accept it, and
 * above 63 it is not a passphrase at all — so an operator finds out here,
 * immediately, rather than by watching a five-minute confirmation window
 * expire on a board that was never going to associate.
 */
const MIN_PSK = 8;
const MAX_PSK = 63;

/** 32 octets, and it may not be empty — the same rule the schema holds `ap.ssid` to. */
const MAX_SSID = 32;

/**
 * The configuration this device should have in order to join that network.
 *
 * The whole document, with `network.client` filled in and everything else left
 * exactly as it was. Nothing else is touched — in particular `network.ap` is
 * not disabled, because whether the access point can stay up is a question
 * about the radio and not about this request, and `radioPlan` is what answers
 * it (K-13).
 *
 * An open network is allowed: no passphrase means no `psk`, and the client
 * profile is written without a key. That is a real kind of network and
 * refusing it would be inventing a rule.
 */
export function joinNetwork(
  current: Config,
  request: JoinRequest | undefined,
  secrets: SecretSink,
): JoinResult {
  const ssid = request?.ssid;
  if (typeof ssid !== "string" || ssid === "" || ssid.length > MAX_SSID) {
    // The submitted value is never echoed. It is unvalidated input on its way
    // back into a browser, and the operator still has what they typed.
    return { ok: false, error: `ssid must be between 1 and ${String(MAX_SSID)} characters` };
  }

  const psk = request?.psk;
  const hasPsk = typeof psk === "string" && psk !== "";
  if (psk !== undefined && psk !== null && typeof psk !== "string") {
    return { ok: false, error: "psk must be text" };
  }
  if (hasPsk && (psk.length < MIN_PSK || psk.length > MAX_PSK)) {
    return {
      ok: false,
      error: `the passphrase must be between ${String(MIN_PSK)} and ${String(MAX_PSK)} characters; `
        + "that is what WPA2 accepts, and a shorter one no access point would take",
    };
  }

  const config = structuredClone(current);
  config.network.client.ssid = ssid;
  if (hasPsk) {
    // Into secrets.yaml, never into config.yaml. The configuration file is
    // world-readable on the device and travels in a support bundle; the secret
    // store is 0600 root and does not.
    secrets.put(CLIENT_PSK_SECRET, psk);
    config.network.client.psk = { secret: CLIENT_PSK_SECRET };
  } else {
    config.network.client.psk = null;
  }
  return { ok: true, config };
}

/**
 * How the console's three join widgets label what they send.
 *
 * The network, the passphrase and the button are separate widgets — `ui-form`
 * has no password field type, and `ui-text-input`, which does mask, is its own
 * widget — so they arrive as three messages and `msg.topic` is what tells them
 * apart. Defined here so the flows and `yonder-join` read one set of strings
 * rather than two copies that can drift.
 */
export const JOIN_TOPIC = {
  ssid: "ssid",
  psk: "psk",
  join: "join",
} as const;
