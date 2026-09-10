// SPDX-License-Identifier: GPL-3.0-or-later
import { registerWidget } from "./widget.js";
import type { RED } from "./red.js";

/**
 * `ui-yonder-index` — the Cameras page: what the probe found, and what it
 * refused (R-CAM-12).
 *
 * Named `index-widget.ts`/`.html`, not `index.ts`/`.html`: this package's own
 * `package.json` states no `main` field, on purpose, since it ships nothing
 * but Node-RED nodes — and Node's own module resolution falls back to
 * `index.js` as a package's default entry when `main` is unset. A file named
 * `index.ts` here would compile to exactly that path, and a camera-list
 * widget becoming this package's own implicit `require()` target purely on
 * account of its filename is precisely the kind of accidental collision
 * this codebase goes out of its way to avoid elsewhere (`YonderAim.vue`'s
 * own `aimState`, dodging Dashboard's reserved `state` prop, is the same
 * care applied to a different collision). `gallery.test.ts`'s own
 * Task 15 guard, which otherwise derives a widget's registration file
 * mechanically from its component name, carries the one matching exception
 * this filename needs.
 *
 * Like `ui-yonder-aim`, this node contributes nothing but its editor form
 * and its registration — every decision about what to draw lives in
 * `YonderIndex.vue`. No static editor field beyond the ones every widget in
 * this package already carries (group, name): the whole of what it draws,
 * and the counts in its own placard, arrive on `msg.payload`.
 */
export = function register(RED: RED): void {
  registerWidget(RED, {
    type: "ui-yonder-index",
    // A press on a found camera's row reaches this node's output through
    // here. Without this, Dashboard drops it silently, with no error
    // anywhere (widget.ts's own note) — the same guarantee `ui-yonder-deck`
    // and `ui-yonder-aim` each state for their own presses.
    emitsActions: true,
    props: () => ({}),
  });
};
