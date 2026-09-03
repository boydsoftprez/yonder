// SPDX-License-Identifier: GPL-3.0-or-later
import { num, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-sparkline` — a rate, drawn (R-NET-10, R-UI-13).
 *
 * Two lines, receive and transmit, over the sampler's own two-minute window.
 * Nothing here decides what the lines mean or how they are scaled — that is
 * the Vue half's job, from `msg.payload.series` — this module only resolves
 * the editor's static configuration, the same division of labour as every
 * other widget in this package.
 *
 * `height2` in the editor, `chartHeight` in the prop — neither may be called
 * `height`. Dashboard builds the widget object it sends the page with
 * `props: widgetConfig` and `layout.height: widgetConfig.height || 1` reading
 * the *same* merged object (`nodes/config/ui_base.js`), so a computed prop
 * named `height` does not sit beside the grid's row-count field, it
 * overwrites it. A widget given a sensible pixel height this way is handed
 * to the page as that many *grid rows* instead — this widget's default of 48
 * would ask Dashboard for a widget 48 rows tall. `ui-yonder-tape` carries the
 * identical mistake (`height: num(config.height2, 196)`) and has never
 * shown it, because nothing has ever wired a tape into a page; this widget
 * found it the moment `flows/flows.json` did, and does not repeat it.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-sparkline",
    props: (_node, config) => ({
      label: str(config.label),
      /** Chart height in px. */
      chartHeight: num(config.height2, 48),
    }),
  });
};
