// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget } from "./widget.js";
import type { RED } from "./red.js";

/** One unified camera workspace with immediate device controls and a single
 * staged/authoritative transaction area. Layout modes are intentionally absent. */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-deck",
    // Every press on this page — an image control, Apply, Discard, an
    // output toggle, the shutter, the rail itself — reaches the node's
    // output through here. See `widget.ts`'s own note: without this,
    // Dashboard drops every one of them silently, with no error anywhere.
    emitsActions: true,
    props: () => ({ mode: undefined }),
  });
};
