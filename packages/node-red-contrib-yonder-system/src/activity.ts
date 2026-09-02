// SPDX-License-Identifier: GPL-3.0-or-later
import { registerPoller } from "./poll.js";
import type { RED } from "./red.js";

/**
 * `yonder-activity` — the live activity log (R-DIA-05).
 *
 * Reads `GET /log?since=`, keeping the cursor the daemon hands back so each
 * poll carries only what is new. That is what makes this usable on a link
 * with hundreds of milliseconds of latency (R-UI-06): the whole buffer once,
 * and after that a few lines.
 *
 * The entries arrive already redacted — `yonder-core` strips secrets on the
 * way into the buffer rather than on the way out — so there is nothing for
 * this node to filter and no filtering step here for a future edit to remove.
 */
export = function register(RED: RED): void {
  registerPoller(RED, "yonder-activity", {
    path: (node) => `/log?since=${String(node.cursor)}`,
    payload: (value) => (value as { entries?: unknown } | undefined)?.entries ?? [],
    seen: (value, node) => {
      const newest = (value as { newestSeq?: unknown } | undefined)?.newestSeq;
      if (typeof newest === "number" && newest > node.cursor) node.cursor = newest;
    },
    describe: (value) => {
      const entries = (value as { entries?: unknown[] } | undefined)?.entries;
      return `${Array.isArray(entries) ? entries.length : 0} new`;
    },
  });
};
