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
 *
 * **The rail can also be handed its keys on a message**, and one rail is:
 * R-CFG-11 says a change that moved the Wi-Fi radio is confirmed by the
 * device, so the banner over that change must not offer a control to confirm
 * it. Which keys those are is decided in `yonder-core` and travels on
 * `msg.payload.keys`; the component draws that list when it is given one and
 * its own configuration when it is not. Nothing here decides anything, which
 * is the rule this package is built on.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-softkeys",
    // The only widget in this package that sends anything back.
    emitsActions: true,
    props: (node, config) => ({
      keys: list<SoftKey>(config.keys, node, "keys"),
      /**
       * A message that arrives here is drawn, not forwarded.
       *
       * Dashboard's default input handling ends in `send(msg)` unless the
       * widget's configuration carries `passthru: false` — the same switch
       * `ui-form` sets on itself. Without it this rail would forward every
       * message it was given down its own output, and its output goes to the
       * node that re-reads `/status` and feeds the rail: one poll would
       * become an endless loop of them, at socket speed, on the panel that
       * exists to say a device is about to roll back.
       *
       * A press is unaffected. That travels as a `widget-action`, which is
       * sent from the widget's `onAction` hook and never touches this.
       */
      passthru: false,
    }),
  });
};
