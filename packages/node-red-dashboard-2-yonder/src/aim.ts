// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-aim` — the gimbal panel as a node of its own (R-UI-28,
 * R-CAM-11), so the Cockpit (M5) can carry the picture and this panel with
 * no camera deck beside them.
 *
 * This node contributes nothing but its editor form and its registration —
 * every decision about what to draw lives in `YonderAim.vue`, the same rule
 * every widget in this package follows. There is no static editor field at
 * all beyond the ones every widget in this package already carries (group,
 * name): unlike `ui-yonder-deck`'s own `mode`, nothing about this panel is a
 * flow-time choice — the whole of what it draws arrives on `msg.payload`.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-aim",
    // A press on the pad, the mode control or Recentre all reach this
    // node's output through here. Without this, Dashboard drops every one
    // of them silently, with no error anywhere (widget.ts's own note).
    emitsActions: true,
    props: () => ({}),
  });
};
