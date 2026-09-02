// SPDX-License-Identifier: GPL-3.0-or-later
import type { AccessPointInfo, NmcliClient } from "./nmcli/client.js";

/**
 * What is in the air (R-NET-03).
 *
 * `NmcliClient.scan()` was built in M1a and is not rebuilt here. What this
 * adds is the two decisions between a raw `device wifi list` and something a
 * page can render, and they live here rather than in a Node-RED node because
 * a node has no tests worth the name (CLAUDE.md rule 2).
 */

export interface ScanResult {
  /** The radio that was scanned, or null when this board has none. */
  interface: string | null;
  /**
   * One entry per network, strongest first.
   *
   * **Never a pre-shared key.** This is a list of what is broadcasting, which
   * is public by construction — anything with a radio can see it. The shape
   * makes that structural rather than a promise: `AccessPointInfo` has three
   * fields and none of them is a credential.
   */
  networks: AccessPointInfo[];
}

/**
 * Scan the board's Wi-Fi radio, and fold the result into one row per network.
 *
 * `nmcli device wifi list` emits **one row per BSS**, not per network: a house
 * with a mesh reports the same SSID three or four times at different
 * strengths, and a form that lists them all asks an operator to choose between
 * four identical-looking entries. Folded on the SSID, keeping the strongest
 * sighting, because that is the one the radio will actually associate with.
 *
 * Sorted by signal descending, then by name, so the list is stable between two
 * scans that saw the same networks at the same strength — an order that
 * reshuffles under the cursor is how the wrong network gets clicked.
 *
 * **What this does not do is hide a failure.** A scan that `nmcli` refuses
 * throws, and the daemon's catch-all turns that into a generic 500 with the
 * detail in the journal. Returning an empty list instead would tell an
 * operator their neighbourhood has no Wi-Fi in it, which is a different and
 * much more expensive statement than "the scan did not run".
 *
 * NOT OBSERVED: what a real board returns when it is scanning with the radio
 * already serving an access point. On a single-radio board that is the
 * ordinary case for this route — the operator is scanning over the very access
 * point they are connected through — and whether NetworkManager can scan in AP
 * mode, returns a stale cache, or refuses outright has not been seen here. It
 * is part of K-13 and it is what the hardware run has to settle.
 */
export async function scanForNetworks(client: NmcliClient): Promise<ScanResult> {
  const devices = await client.devices();
  const iface = devices.find((d) => d.type === "wifi")?.device ?? null;
  if (iface === null) return { interface: null, networks: [] };

  const strongest = new Map<string, AccessPointInfo>();
  for (const ap of await client.scan(iface)) {
    const seen = strongest.get(ap.ssid);
    // Number(signal) is NaN when nmcli printed something unexpected, and NaN
    // loses every comparison — so an unreadable signal never displaces a
    // reading, and a network seen only with an unreadable one is still listed.
    if (seen === undefined || ap.signal > seen.signal) strongest.set(ap.ssid, ap);
  }

  const networks = [...strongest.values()].sort((a, b) =>
    b.signal - a.signal || a.ssid.localeCompare(b.ssid));
  return { interface: iface, networks };
}
