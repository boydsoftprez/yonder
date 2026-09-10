// SPDX-License-Identifier: GPL-3.0-or-later
import type { PathName } from "./reach/standing.js";

/**
 * Every address this device answers on, and **which path a peer would reach
 * each one over** (R-UI-24).
 *
 * **Two different questions wear the same word.** *An address this device
 * answers on* is what R-VID-15 wants for the line an operator copies, and it
 * is the set the console session itself arrived through. *An address a peer
 * can open a socket to, over a path that is up* is a smaller and differently
 * shaped set, and it is the one an RTSP or SRT listener needs: `outputReach()`
 * in `video/outputs.ts` states the rule — nothing dials in to a device behind
 * carrier-grade NAT — and this is that rule applied to the addresses rather
 * than to the paths.
 *
 * **A flat "somebody can dial this" flag was not enough, and that is why this
 * answers a path per address.** A verdict rests on a *particular* path: on a
 * flying board with cellular and the mesh up, `outputReach` says a listener is
 * reachable **because of the mesh**, and an address chosen from anywhere else
 * in a flat set is an address no mesh peer can use. The default `wifiMode` is
 * `ap`, so `wlan0` permanently holds the access point's address and
 * `activeIpv4()` reports it — first, ahead of the mesh's — which is exactly
 * the address a flat set plus `[0]` would have printed. Whoever chooses has to
 * be able to ask *which path*, so the answer carries it.
 *
 * **The modem has two names and neither answers for the other.** The address
 * is bound to the control port NetworkManager lists — `cdc-wdm0` — while
 * ModemManager names the net port the bytes leave by, `wwan0`. Comparing an
 * address's device against one of them alone is a comparison that is trivially
 * true, which marked the CGNAT address dialable on every board in auto mode.
 * So both names are taken, exactly as `pathsHolding` and `pathsDown` take
 * their `alsoKnownAs`, and for the same reason.
 *
 * It is a function here rather than a dozen lines inside `daemon/server.ts`
 * because that is the join the whole of R-UI-24 rests on: `video/receive.ts`
 * builds an RTSP URL out of whichever address it is handed, and a caller that
 * handed it the modem's would put the CGNAT address under the sentence "a peer
 * on the mesh or a LAN has an address that reaches this RTSP output" — the
 * claim true and the address beside it useless, which is precisely the failure
 * the surface exists to prevent. A pure function is a join a test can stand on;
 * `server.wiring.test.ts` stands on the assembly above it.
 */

/** One address, and the interface NetworkManager holds it on. */
export interface HeldAddress {
  readonly device: string;
  /** As nmcli reports it, with or without a prefix length. */
  readonly address: string;
}

/**
 * How a peer would reach one of this device's addresses.
 *
 * `lan` and `mesh` are the two `outputReach()` lets a listener's verdict rest
 * on. The other three exist so that nothing is silently folded into those two:
 *
 *   - `cellular` — behind the carrier's NAT. Nothing dials in to it.
 *   - `access-point` — the network this device raises itself. A peer *joined
 *     to it* can dial this address, and no `ReachPaths` field is ever true
 *     because of it (`pathDevices` deliberately omits the radio while it is
 *     serving), so it must never stand in for a LAN or the mesh.
 *   - `unattributed` — an address on an interface no path names: a second NIC,
 *     a container bridge, the mesh's own interface on a board whose mesh state
 *     could not be read. Something may well be able to dial it; nothing here
 *     has established what, so it is never chosen for a verdict.
 */
export type AddressPath = "lan" | "mesh" | "access-point" | "cellular" | "unattributed";

export interface AnswerableAddress {
  readonly address: string;
  readonly path: AddressPath;
}

/** `192.168.1.8/24` → `192.168.1.8`. nmcli reports both forms. */
function bare(address: string): string {
  return address.split("/")[0] ?? address;
}

/** The paths an address can be attributed to, in the order they are tried. */
const ATTRIBUTABLE: readonly PathName[] = ["ethernet", "wifi_client", "modem"];

export function answerableAddresses(input: {
  /** Every IPv4 address the radio holds, by interface. */
  readonly local: readonly HeldAddress[];
  /** Every address the mesh has assigned this device. */
  readonly mesh: readonly string[];
  /**
   * `pathDevices(config, devices, modemNetPort)` — the modem named as the net
   * port its bytes leave by.
   */
  readonly devices: Partial<Record<PathName, string>>;
  /**
   * `pathDevices(config, devices)` — the same map with the modem named as the
   * control port NetworkManager binds the address to. Both are needed: see the
   * note above, and `pathsHolding`, which takes the identical pair.
   */
  readonly alsoKnownAs?: Partial<Record<PathName, string>>;
  /** The access point's own address, from `config.network.ap.address`. */
  readonly apAddress: string;
}): AnswerableAddress[] {
  const { local, mesh, devices, alsoKnownAs = {}, apAddress } = input;

  const pathOf = (device: string): PathName | null =>
    ATTRIBUTABLE.find((p) => devices[p] === device || alsoKnownAs[p] === device) ?? null;

  const meshAddresses = mesh.map(bare).filter((a) => a !== "");
  const isMesh = new Set(meshAddresses);
  const ap = bare(apAddress);

  const out: AnswerableAddress[] = [];
  const seen = new Set<string>();
  const add = (address: string, path: AddressPath): void => {
    if (address === "" || seen.has(address)) return;
    seen.add(address);
    out.push({ address, path });
  };

  for (const held of local) {
    const address = bare(held.address);
    // Loopback is not an address anything outside this board arrived on and
    // not one anything outside it can dial. `pathsHolding` excludes it for the
    // same reason, and `fixtures/device-show-ip4.txt` — a real capture — leads
    // with it, so without this the *first* address this device claims to
    // answer on is 127.0.0.1.
    if (held.device === "lo" || address.startsWith("127.")) continue;
    // The mesh's own interface is reported by nmcli too, and its address is
    // the same string the mesh reports. Attributing it here rather than
    // letting it fall through to `unattributed` is what stops one address
    // appearing twice under two different answers.
    if (isMesh.has(address)) { add(address, "mesh"); continue; }
    if (ap !== "" && address === ap) { add(address, "access-point"); continue; }
    const path = pathOf(held.device);
    add(address, path === "modem" ? "cellular" : path === null ? "unattributed" : "lan");
  }
  for (const address of meshAddresses) add(address, "mesh");

  return out;
}
