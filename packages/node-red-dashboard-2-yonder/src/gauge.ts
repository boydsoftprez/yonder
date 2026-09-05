// SPDX-License-Identifier: GPL-3.0-or-later
import { list, num, optionalNum, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-gauge` — the engine bar (R-UI-09, ADR-0009).
 *
 * The workhorse of the console: label, a track carrying the caution and limit
 * bands, a pointer at the value, and the digital reading. It exists because
 * R-UI-09 says a bounded quantity is drawn against its bounds — `62.4 °C` is
 * a number, and `62.4 °C against a caution at 60 and a throttle at 80` is a
 * reading.
 *
 * Its one layout rule, and the reason it is a component rather than CSS on a
 * `ui-text`: **the track has a fixed width and never stretches to its
 * container.** A bar that fills its column is the slab this design language
 * replaced, wearing a different name.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-gauge",
    props: (node, config) => ({
      label: str(config.label),
      unit: str(config.unit),
      min: num(config.min, 0),
      max: num(config.max, 100),
      // No band configured means no band drawn. `reading()` reports such a
      // value as neutral rather than good, because nobody has said what good
      // is for it.
      caution: optionalNum(config.caution),
      limit: optionalNum(config.limit),
      // Named in the flow, never guessed. See ReadingBounds.sense.
      sense: config.sense === "higher-is-better" ? "higher-is-better" : "higher-is-worse",
      limitLabel: str(config.limitLabel),
      precision: num(config.precision, 1),
      /** Track width in px. Fixed by design; see the note above. */
      track: num(config.track, 118),
      /** Optional extra readings drawn from the same payload object. */
      series: list<{ key: string; label: string }>(config.series, node, "series"),
    }),
  });
};
