// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Which of the addresses this device answers on a peer can **dial in** to
 * (R-UI-24).
 *
 * **Two different questions wear the same word.** *An address this device
 * answers on* is what R-VID-15 wants for the line an operator copies, and it
 * is the set the console session itself arrived through. *An address a peer
 * can open a socket to* is a smaller set, and it is the one an RTSP or SRT
 * listener needs: `outputReach()` in `video/outputs.ts` states the rule —
 * nothing dials in to a device behind carrier-grade NAT — and this is that
 * rule applied to the addresses rather than to the paths.
 *
 * **The modem's is the one address that is never dialable**, and everything
 * else the radio holds is. Ethernet, a Wi-Fi client and the access point this
 * device raises itself are all addresses something on the same wire can reach;
 * every mesh address is one by construction, because the mesh exists to give
 * peers a route to each other. Cellular is the exception because the carrier's
 * NAT is doing exactly what it is for.
 *
 * It is a function here rather than four lines inside `daemon/server.ts`
 * because that is the join the whole of R-UI-24 rests on: `video/receive.ts`
 * builds an RTSP URL out of whichever address it is handed, and a caller that
 * marked the modem's dialable would put the CGNAT address under the sentence
 * "a peer on the mesh or a LAN has an address that reaches this RTSP output"
 * — the claim true and the address beside it useless, which is precisely the
 * failure the surface exists to prevent. A pure function is a join a test can
 * stand on.
 */

/** One address, and the interface NetworkManager holds it on. */
export interface HeldAddress {
  readonly device: string;
  /** As nmcli reports it, with or without a prefix length. */
  readonly address: string;
}

export interface AnswerableAddress {
  readonly address: string;
  /** Whether a peer could open a socket to this address. */
  readonly dialIn: boolean;
}

/** `192.168.1.8/24` → `192.168.1.8`. nmcli reports both forms. */
function bare(address: string): string {
  return address.split("/")[0] ?? address;
}

export function answerableAddresses(input: {
  /** Every IPv4 address the radio holds, by interface. */
  readonly local: readonly HeldAddress[];
  /** Every address the mesh has assigned this device. */
  readonly mesh: readonly string[];
  /**
   * The interface the modem is on, or `null` when nothing has named one.
   *
   * `null` excludes nothing rather than everything, and that is the right
   * direction: a modem with no interface name has no IPv4 address for nmcli to
   * report either, so there is nothing to exclude — while treating an unread
   * reach monitor as "exclude everything" would leave a board printing no
   * address at all for the first few seconds after a start.
   */
  readonly modemDevice: string | null;
}): AnswerableAddress[] {
  const { local, mesh, modemDevice } = input;
  return [
    // The radio's own first, then the mesh's — the order `daemon/server.ts`
    // has always answered them in, because the address a console session
    // arrived on is far more often a local one.
    ...local.map((a) => ({ address: bare(a.address), dialIn: a.device !== modemDevice })),
    ...mesh.map((a) => ({ address: bare(a), dialIn: true })),
  ].filter((a) => a.address !== "");
}
