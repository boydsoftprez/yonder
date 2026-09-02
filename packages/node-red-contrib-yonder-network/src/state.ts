// SPDX-License-Identifier: GPL-3.0-or-later
import { registerReader } from "./read.js";
import type { RED } from "./red.js";

/**
 * `yonder-netstate` — what the radio is doing, in one line.
 *
 * The console used to put the raw configuration on screen — a client SSID, an
 * access point SSID — and leave the operator to work out which was in force.
 * Standing on the page that had just joined a network, that was not
 * answerable: both had values and neither said which was live.
 *
 * The daemon computes it from the configuration *and* the devices, because
 * those disagree exactly when it matters.
 */
export = function register(RED: RED): void {
  registerReader(RED, "yonder-netstate", "/net/state", (value) =>
    String((value as { summary?: unknown } | undefined)?.summary ?? "unknown"));
};
