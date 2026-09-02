// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-annunciator` — command state as a lit caption (R-UI-11).
 *
 * R-UI-11 exists because the four tones from `command.ts` were reaching the
 * page as coloured body text, which is the weakest expression available: it
 * has to be read to be understood, and on a console driven at arm's length
 * the whole point of a state is that it is legible before it is read.
 *
 * The tone and the words both come from `yonder-core` — `presentation()`
 * decides them — so this widget renders a `CommandStatus` and chooses
 * nothing. Every node in both contrib packages already puts one on
 * `msg.yonder`, which is what makes a control mean the same thing on every
 * page (ADR-0005).
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-annunciator",
    props: (_node, config) => ({
      label: str(config.label),
      /**
       * Where to read the status from. `yonder` is the shared command-state
       * channel and the default; `payload` is for a node that reports a state
       * it computed for itself.
       */
      source: config.source === "payload" ? "payload" : "yonder",
    }),
  });
};
