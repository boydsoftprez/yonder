// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-captures` — what this board is holding, and the three things
 * that can be done with one (R-CAM-18).
 *
 * Like `ui-yonder-index` and `ui-yonder-aim`, this node contributes nothing
 * but its editor form and its registration — every decision about what to
 * draw lives in `YonderCaptures.vue`, and every decision about what a capture
 * *is* lives in `yonder-core`. No static editor field beyond the ones every
 * widget in this package already carries: the whole listing arrives on
 * `msg.payload`, exactly as the daemon's own route answers it.
 *
 * `emitsActions`, because a delete leaves through this node's output.
 * Without it Dashboard drops the event silently, with no error anywhere —
 * `widget.ts`'s own note, and the failure this package has already shipped
 * once across every soft key on every page.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-captures",
    emitsActions: true,
    props: () => ({}),
  });
};
