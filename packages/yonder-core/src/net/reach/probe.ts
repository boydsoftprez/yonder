// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRunner } from "../runner.js";

/** Does this path complete a request? Injected, so tests reach no network. */
export type Probe = (device: string) => Promise<boolean>;

/** Seconds a whole probe may take. Short: a link this slow is not usable. */
const TIMEOUT_S = 8;

/**
 * What is asked, and deliberately not a name.
 *
 * Two of them, because a probe that trusts one host reads that host's bad
 * afternoon as a dead aircraft link — and three consecutive readings of it
 * stand the path down. Any one answering is the path answering; the question
 * is whether traffic gets through, not who replies.
 *
 * Both are anycast addresses of services that answer on port 80 from
 * everywhere, so neither depends on where the carrier lands a bearer.
 * `1.1.1.1` is first because it is the one that was measured returning
 * exit 0 over a working `wwan0`.
 */
export const PROBE_ADDRESSES = ["1.1.1.1", "8.8.8.8"] as const;

/**
 * The share of the budget each address gets.
 *
 * The bound that matters is the one on the whole probe: a tick spends at most
 * one probe per path, and `REACH_TICK_DEADLINE_MS` is sized on the probe
 * costing at most `TIMEOUT_S`. Trying a second address must not double what a
 * probe can cost, so the budget is divided rather than repeated — and a link
 * that cannot answer either address within it is not a link this aircraft can
 * use.
 */
const PER_ADDRESS_TIMEOUT_S = Math.max(1, Math.floor(TIMEOUT_S / PROBE_ADDRESSES.length));

/**
 * The active test, bound to one interface.
 *
 * **Bound to the device, not left to the routing table.** The question is
 * whether *this* path works, and the default route is usually another one —
 * the whole point is to find out about a path nothing is currently using.
 *
 * **No hostname appears here, and that is the whole of this test's
 * correctness.** `curl --interface` binds the *name lookup* to that interface
 * too, so a hostname makes this a test of whether DNS is reachable over the
 * path rather than whether the path carries traffic. Measured on the board,
 * with cellular working perfectly:
 *
 *     curl --interface eth0  http://connectivity-check.ubuntu.com/   → 0
 *     curl --interface wwan0 http://connectivity-check.ubuntu.com/   → 28 (timeout)
 *     curl --interface wwan0 http://1.1.1.1/                         → 0
 *     curl --interface wwan0 --resolve <name>:80:91.189.91.58 …      → 0
 *
 * That board's `/etc/resolv.conf` names the LAN router first, which is
 * reachable over Ethernet and nowhere else — so bound to `wwan0` the query
 * went nowhere and the probe timed out having never tested the link. Every
 * board this project targets has a LAN resolver and a modem, so a hostname
 * here means cellular always reads as dead, three failures stand it down, and
 * a working link is demoted. Resolution is a different question that happens
 * to be answerable on only one interface; it is not this one.
 *
 * `curl` rather than `ping`: a carrier that drops ICMP is common and would
 * read as a dead link, and the thing an operator cares about is whether an
 * ordinary request completes. An HTTP HEAD stays the right shape without the
 * name — a reply proves the far end sent bytes back through the carrier's
 * gateway, which is exactly the failure in design spec §2 that a handshake
 * alone would not settle. `--head` so nothing is downloaded on a metered
 * link, and plain HTTP so a broken clock cannot fail it the way a certificate
 * check would.
 *
 * Any non-zero exit is a failure, 127 included: a board with no curl cannot
 * establish that a path works, and reporting "reachable" because the test
 * could not run is the direction that costs an aircraft.
 */
export function commandProbe(runner: CommandRunner): Probe {
  return async (device) => {
    for (const address of PROBE_ADDRESSES) {
      const result = await runner([
        "curl", "--silent", "--head", "--output", "/dev/null",
        "--interface", device,
        "--max-time", String(PER_ADDRESS_TIMEOUT_S),
        `http://${address}/`,
      ]);
      // The first answer ends it. A path that works costs one request, not
      // one per address, which is what makes this affordable on a metered
      // link.
      if (result.code === 0) return true;
    }
    return false;
  };
}
