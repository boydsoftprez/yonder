// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-identity` — an identifier, with a means of copying it (R-VPN-06).
 *
 * R-VPN-06 says the identifier a person must approve is shown "with a means of
 * copying it". Dashboard 1.31.0 has no clipboard path, so what shipped was a
 * `ui-button` whose own tooltip told the operator to select the text above and
 * copy it by hand — a control that says it will act and does not, which is
 * worse than no control at all. CLAUDE.md rule 2 forbids the `function` node
 * and the `ui-template` that would have wired one up; it does not forbid a
 * component in this package, which is where behaviour is supposed to live.
 *
 * It reads one property of `msg.payload` and emits nothing: copying happens in
 * the browser and never reaches the device. `emitsActions` is therefore off,
 * and an instrument that could emit is one that could originate a command
 * (R-CMD-04).
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-identity",
    props: (_node, config) => ({
      label: str(config.label),
      /** Which property of `msg.payload` holds the identifier. */
      key: str(config.key, "value"),
    }),
  });
};
