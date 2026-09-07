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
        /**
         * How long to wait for live video before serving stills (R-VID-14).
         *
         * The stills themselves are not configured anywhere: the picture
         * derives their address from the camera it is showing, and the
         * daemon takes them on the interval it states. An editor field
         * that named a source used to sit here and nothing could ever fill
         * it — a field that was never fillable is not a feature.
         */
        stillsAfterMs: num(config.stillsAfterMs, 12_000),
        cost: str(config.cost),
      };
    },
  });
};
