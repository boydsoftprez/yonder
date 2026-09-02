// SPDX-License-Identifier: GPL-3.0-or-later
import { list, registerWidget } from "./widget.js";
import type { RED } from "./red.js";
import type { SoftKey } from "./shapes.js";

/**
 * `ui-yonder-softkeys` — every action on a page, in one rail (R-UI-10).
 *
 * The answer to the complaint this whole design language began with: a button
 * that spans half the page. It spanned half the page because a stock widget
 * *is* a row of its group and cannot be smaller than one, so shrinking the
 * button only added empty space around it. The fix is not a smaller button;
 * it is that actions stop being widgets.
 *
 * So they live along the foot of the display, the way a multi-function
 * display puts them under the bezel, and **R-UI-10 says no action lives
 * anywhere else on the page.** One rail, sized to its words.
 *
 * Tones are the ones every other surface uses. `warn` is reserved for the one
 * control on this console that takes the page away from the operator — the
 * join that drops the access point (K-13) — and there is deliberately at most
 * one of those on any page.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-softkeys",
    props: (node, config) => ({
      keys: list<SoftKey>(config.keys, node, "keys"),
    }),
  });
};
