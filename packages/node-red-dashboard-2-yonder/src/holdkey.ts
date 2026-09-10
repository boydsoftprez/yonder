// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-holdkey` — a soft key that acts while it is held (R-VID-11).
 *
 * The cheap preview is what the interface watches by default (R-VID-13), and
 * the full-rate picture stays available *while the operator asks for it*. A
 * toggle would be wrong: an operator who forgot they had left it on would be
 * spending most of a field uplink on a picture nobody was looking at, and
 * would have no reason to suspect it. Holding costs what it costs for as long
 * as you hold it, and the key states that cost before it is pressed — R-VID-11
 * doing work rather than reporting a number.
 *
 * **This is a primitive, and it is deliberately built before anything that
 * needs it.** ADR-0009 records that every soft key on this console once
 * shipped dead, because Dashboard drops a `widget-action` from a widget that
 * never registered `onAction` — no error, no warning. A key that must be *held*
 * has four more ways to fail than one that is clicked, and every one of them
 * leaves the aircraft sending a stream nobody asked for.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-holdkey",
    emitsActions: true,
    props: (_node, config) => ({
      label: str(config.label),
      action: str(config.action),
      /** What holding this costs, stated before it is asked (R-VID-11). */
      cost: str(config.cost),
      tone: str(config.tone, "plain"),
    }),
  });
};
