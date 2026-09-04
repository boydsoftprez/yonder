// SPDX-License-Identifier: GPL-3.0-or-later
import { num, registerWidget, str } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-picture` — the live picture, and what happens to it (R-VID-03).
 *
 * **The cheap copy is the default, always** (R-VID-13). A component that
 * defaulted to the full-rate stream would spend most of a field uplink the
 * moment somebody opened a page, and the operator would have no reason to
 * suspect it. The full rate is reached by holding a key (holdkey.ts), which is
 * both deliberate and self-limiting.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-picture",
    emitsActions: true,
    props: (_node, config) => {
      const path = str(config.path);
      return {
        /** Always the preview path. The full rate is a held key, not a default. */
        path: path.endsWith("-preview") ? path : `${path}-preview`,
        label: str(config.label),
        /** How long to wait for live video before serving stills (R-VID-14). */
        stillsAfterMs: num(config.stillsAfterMs, 12_000),
        /**
         * Where the stills come from, when the fall-back happens.
         *
         * Configuration rather than something discovered, because nothing in
         * this repository serves stills yet. Left unset, the fall-back still
         * happens and still reports why — which is the half of R-VID-14 that
         * sends an operator to the right place — and draws no picture.
         */
        stillsUrl: str(config.stillsUrl),
        cost: str(config.cost),
      };
    },
  });
};
