// SPDX-License-Identifier: GPL-3.0-or-later
import { registerAdapter } from "./adapter.js";
import type { RED } from "./red.js";

/**
 * `yonder-cameras` — what is attached, and what was rejected and why
 * (R-CAM-12).
 *
 * The rejections travel with the answer rather than being filtered out of it.
 * `/dev/video10` on this board is the JPEG *decoder*: it advertises MJPEG,
 * cannot be started, and looks like a camera to everything that asks. Without
 * a stated reason it would simply not appear, and an operator would go looking
 * for the camera that vanished.
 */
export = function register(RED: RED): void {
  registerAdapter(
    RED,
    "yonder-cameras",
    () => ({ method: "GET", path: "/cameras" }),
    (value) => {
      const body = value as { found?: unknown; rejected?: unknown } | undefined;
      const found = Array.isArray(body?.found) ? body.found.length : 0;
      const rejected = Array.isArray(body?.rejected) ? body.rejected.length : 0;
      return `${found} found, ${rejected} rejected`;
    },
  );
};
