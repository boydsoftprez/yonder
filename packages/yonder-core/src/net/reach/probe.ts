// SPDX-License-Identifier: GPL-3.0-or-later
import type { CommandRunner } from "../runner.js";

/** Does this path complete a request? Injected, so tests reach no network. */
export type Probe = (device: string) => Promise<boolean>;

/** Seconds before a probe is a failure. Short: a link this slow is not usable. */
const TIMEOUT_S = 8;

/**
 * The active test, bound to one interface.
 *
 * **Bound to the device, not left to the routing table.** The question is
 * whether *this* path works, and the default route is usually another one —
 * the whole point is to find out about a path nothing is currently using.
 *
 * `curl` rather than `ping`: a carrier that drops ICMP is common and would
 * read as a dead link, and the thing an operator cares about is whether an
 * ordinary request completes. `--head` so nothing is downloaded on a metered
 * link, and a plain HTTP request so a broken clock cannot fail it the way a
 * certificate check would.
 *
 * Any non-zero exit is a failure, 127 included: a board with no curl cannot
 * establish that a path works, and reporting "reachable" because the test
 * could not run is the direction that costs an aircraft.
 */
export function commandProbe(runner: CommandRunner): Probe {
  return async (device) => {
    const result = await runner([
      "curl", "--silent", "--head", "--output", "/dev/null",
      "--interface", device,
      "--max-time", String(TIMEOUT_S),
      "http://connectivity-check.ubuntu.com/",
    ]);
    return result.code === 0;
  };
}
