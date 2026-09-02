// SPDX-License-Identifier: GPL-3.0-or-later
import { num, optionalNum, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-tape` — a vertical scale with a bug (R-UI-09, ADR-0009).
 *
 * For a quantity being watched rather than read once. The scale carries the
 * marked limits, a fill rises to the value, and a bug and a boxed reading sit
 * at the current value — the airspeed-tape idiom, because it is the one an
 * operator already knows how to read at a glance.
 *
 * A gauge and a tape draw the same `Reading`; which one a page uses is a
 * question about the data, not about the value. Watched quantities get a
 * tape, glanced ones get a bar.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-tape",
    props: (_node, config) => ({
      label: str(config.label),
      unit: str(config.unit),
      min: num(config.min, 0),
      max: num(config.max, 100),
      caution: optionalNum(config.caution),
      limit: optionalNum(config.limit),
      limitLabel: str(config.limitLabel),
      precision: num(config.precision, 1),
      /** Scale height in px. */
      height: num(config.height2, 196),
      /** How many labelled divisions to draw down the scale. */
      divisions: num(config.divisions, 5),
    }),
  });
};
