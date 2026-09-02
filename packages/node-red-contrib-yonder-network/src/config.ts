// SPDX-License-Identifier: GPL-3.0-or-later
import { registerReader } from "./read.js";
import type { RED } from "./red.js";

/**
 * `yonder-config` — the device's configuration, as it stands (R-CFG-03).
 *
 * A read. Nothing here writes: an apply goes through `yonder-apply`, which is
 * a separate node precisely so a flow cannot read and write in one wire
 * without somebody having drawn the second one.
 */
export = function register(RED: RED): void {
  registerReader(RED, "yonder-config", "/config", () => "read");
};
