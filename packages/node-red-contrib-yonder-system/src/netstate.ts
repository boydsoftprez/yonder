// SPDX-License-Identifier: GPL-3.0-or-later
import { registerPoller } from "./poll.js";
import type { RED } from "./red.js";

/**
 * `yonder-netstate` — what the radio is doing, in one line.
 *
 * The console used to put the raw configuration on screen — a client SSID and
 * an access point SSID — and leave the operator to work out which was in
 * force. Standing on the page that had just joined a network, that was not
 * answerable: both had values and neither said which was live.
 *
 * Polled rather than asked, because it is the answer to "where am I", and a
 * status line that only updates when somebody presses a button is a status
 * line that is wrong most of the time. `registerPoller` reads once on
 * registration too, so the page says something before the first tick.
 *
 * It lives in this package rather than beside the network *controls* because
 * this is a readout, and the readouts are what poll. Nothing here decides
 * anything: `GET /net/state` computes it in `yonder-core` from the
 * configuration and the devices together.
 */
export = function register(RED: RED): void {
  registerPoller(RED, "yonder-netstate", {
    path: () => "/net/state",
    payload: (value) => value,
    failedPayload: () => ({ summary: "Wi-Fi state unavailable — waiting for a new observation", address: "—" }),
    describe: (value) =>
      String((value as { summary?: unknown } | undefined)?.summary ?? "unknown"),
  });
};
