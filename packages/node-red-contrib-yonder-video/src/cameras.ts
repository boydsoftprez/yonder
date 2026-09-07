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
      /**
       * **Take out the camera the operator pressed the removal key on**
       * (R-CAM-21, R-CFG-01).
       *
       * The **id**, not the socket — the opposite of the adoption above, and
       * for the same reason each is what it is. An adoption names a socket
       * because there is no entry yet to name; a removal names the entry,
       * and on the board this was found on there were two entries whose
       * sockets had nothing on them at all. A camera that is not there cannot
       * be addressed by where it is not.
       *
       * `DELETE /cameras/<id>` rather than a `POST /cameras/<id>/remove`, for
       * the reason `Ask` states about captures: the daemon makes it a verb on
       * the address the camera already has, and a second spelling of one fact
       * is one more thing for the router to keep in step.
       */
      const forget = (msg as { payload?: { forget?: unknown } }).payload?.forget;
      if (typeof forget === "string" && forget !== "") {
        return { method: "DELETE", path: `/cameras/${forget}`, camera: forget };
      }
      return { method: "GET", path: "/cameras" };
    },
    (value) => {
      const body = value as { found?: unknown; rejected?: unknown; camera?: unknown } | undefined;
      // A sweep answers `found`; an adoption and a removal answer the one
      // camera they were about. Reporting either of those as "0 found, 0
      // rejected" — which is what a count of two absent arrays comes to —
      // puts a sentence on the badge that is true of nothing that happened.
      if (!Array.isArray(body?.found) && typeof body?.camera === "string") {
        return `${body.camera}: the configuration was changed`;
      }
      const found = Array.isArray(body?.found) ? body.found.length : 0;
      const rejected = Array.isArray(body?.rejected) ? body.rejected.length : 0;
      return `${found} found, ${rejected} rejected`;
    },
  );
};
