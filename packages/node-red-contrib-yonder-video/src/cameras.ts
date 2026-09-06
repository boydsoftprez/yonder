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
    (msg) => {
      /**
       * **Adopt the camera the operator pressed ADD on** (R-UI-03, R-CAM-05).
       *
       * A detected camera on a socket nothing is configured for carries no id,
       * so it has no page and `YonderIndex` draws an ADD key rather than a
       * dead OPEN. That key posts the socket, and this turns it into the one
       * request that writes an entry. Found by the operator on a board: the
       * row was there, the key was inert, and nothing anywhere could configure
       * it.
       *
       * **The socket, never `/dev/videoN`.** The daemon accepts only a
       * `by-path` name, because that is what still means this camera after a
       * replug — and it asks its own probe rather than trusting this, so a
       * string that names no attached camera is refused rather than written.
       */
      const adopt = (msg as { payload?: { adopt?: unknown } }).payload?.adopt;
      if (typeof adopt === "string" && adopt !== "") {
        return { method: "POST", path: "/cameras", body: { device: adopt } };
      }
      return { method: "GET", path: "/cameras" };
    },
    (value) => {
      const body = value as { found?: unknown; rejected?: unknown } | undefined;
      const found = Array.isArray(body?.found) ? body.found.length : 0;
      const rejected = Array.isArray(body?.rejected) ? body.rejected.length : 0;
      return `${found} found, ${rejected} rejected`;
    },
  );
};
