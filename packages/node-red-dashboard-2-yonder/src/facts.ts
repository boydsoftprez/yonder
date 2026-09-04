// SPDX-License-Identifier: GPL-3.0-or-later
import { list, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";
import type { CapabilityFact } from "./shapes.js";

/**
 * `ui-yonder-facts` — what this camera cannot do, stated (R-UI-15).
 *
 * **Nothing is ever silently missing.** An operator must be able to tell *this
 * camera cannot* from *this page failed*, and an empty space says nothing
 * about which.
 *
 * A fact rather than a dead control, for two reasons. A dead control takes the
 * room of a control and carries the information of a label — on a fixed camera
 * that is a dead aim dial, a dead zoom picker, dead focus and a dead record
 * key, which pushes the live controls off a tablet. And it teaches an operator
 * to stop reading muted styling, which then costs us the advertised state,
 * whose whole job is to be noticed.
 *
 * The soft-key rail is the exception R-UI-15 names: it carries only actions
 * that can be taken. A camera that cannot record has no Record key, and the
 * fact that it cannot is stated here.
 *
 * Read-only, deliberately. A facts row that could emit is a facts row that
 * could originate a command.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-facts",
    props: (node, config) => ({
      title: str(config.title),
      facts: list<CapabilityFact>(config.facts, node, "facts"),
    }),
  });
};
