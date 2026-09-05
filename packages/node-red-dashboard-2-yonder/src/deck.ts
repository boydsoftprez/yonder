// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-deck` — a camera's whole control surface, composed from what it
 * answered (R-UI-08, R-UI-20, R-UI-21, R-CFG-03).
 *
 * This node contributes nothing but its editor form and its registration —
 * every decision about what to draw, and where an edit goes, lives in
 * `YonderDeck.vue`, the same rule every widget in this package follows.
 *
 * `mode` is the one static editor field, and it is not something a message
 * ever changes: which controls this instance draws — Setup adds the
 * housekeeping group, the camera's name and the Apply/Discard keys — comes
 * from whichever page it was dropped on, not from `msg.payload`. Pressing
 * the rail's own Live/Setup key instead *posts* `{ mode: "live" | "setup" }`,
 * for a flow to act on — typically navigating to the other page's own deck
 * instance, never toggling this one's own rendering.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-deck",
    // Every press on this page — an image control, Apply, Discard, an
    // output toggle, the shutter, the rail itself — reaches the node's
    // output through here. See `widget.ts`'s own note: without this,
    // Dashboard drops every one of them silently, with no error anywhere.
    emitsActions: true,
    props: (_node, config) => ({
      mode: config.mode === "setup" ? "setup" : "live",
    }),
  });
};
