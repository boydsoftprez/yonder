// SPDX-License-Identifier: GPL-3.0-or-later
import { registerPoller } from "./poll.js";
import type { RED } from "./red.js";

/**
 * `yonder-status` — what the board says about itself (R-SYS-01, R-SYS-02).
 *
 * A thin adapter over `GET /system`. Every field it emits was parsed in
 * `yonder-core/src/system/`, where the parsing is tested against captured
 * text; nothing here reads a file, converts a unit or formats a number.
 */
export = function register(RED: RED): void {
  registerPoller(RED, "yonder-status", {
    path: () => "/system",
    payload: (value) => value,
    describe: (value) => {
      const model = (value as { facts?: { model?: unknown } } | undefined)?.facts?.model;
      return typeof model === "string" ? model : "ok";
    },
  });
};
