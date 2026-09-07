// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-flow` — where telemetry comes from, what it passes through, and
 * where it goes (R-MAV-10, R-UI-13).
 *
 * **The one instrument in this set that draws a relationship.** Every other
 * one draws a quantity (gauge, tape, sparkline) or a state (annunciator,
 * databar). A flow has three places and two legs between them, and the thing
 * an operator reads off it is not any single value — it is *which leg is
 * dead*. A page can say "no heartbeat" and "nothing to send" in two separate
 * rows and still leave that reading to be assembled in the operator's head.
 *
 * A leg with nothing crossing it is dashed and grey rather than red: nothing
 * has failed when telemetry is stopped, or when no autopilot is wired yet.
 * Red here would be the same lie the path check refuses to tell by showing a
 * dash for a link nobody attempted.
 *
 * Nothing here decides what any of that means. The node resolves the editor's
 * static configuration and the Vue half renders `msg.payload`, as in every
 * other widget in this package.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-flow",
    props: (_node, config) => ({
      label: str(config.label),
    }),
  });
};
