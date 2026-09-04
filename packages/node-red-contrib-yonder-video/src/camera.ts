// SPDX-License-Identifier: GPL-3.0-or-later
import { cameraId, registerAdapter, NO_CAMERA } from "./adapter.js";
import type { RED } from "./red.js";

/**
 * `yonder-camera` — one camera, as the device answers it (R-CTL-10).
 *
 * **A read, and never an echo.** The requirement says to show current settings
 * and running state *reading back stored values rather than form defaults*,
 * and the spec leans on it harder than the wording implies: a control shows
 * what the camera reports, never what was sent. So this node ignores whatever
 * settings a message is carrying and answers with the daemon's read-back —
 * which is a `current` per control, taken from the device, beside the run
 * state the supervisor observed.
 *
 * **There is no settings write here, deliberately.** A camera's settings live
 * in `config.yaml`, and changing one goes through `yonder-apply` like every
 * other configuration change, so it inherits the confirmation window and the
 * rollback. A second write path into the same document, from a node, would be
 * a way to change what the aircraft sends without either.
 *
 * `msg.topic === "probe"` re-reads the one device — the Setup deck's
 * *Re-probe* key. It is a different route, not different behaviour: both
 * answer the same shape, and the daemon owns what a re-probe means.
 */
export = function register(RED: RED): void {
  registerAdapter(
    RED,
    "yonder-camera",
    (msg, config) => {
      const id = cameraId(msg, config);
      if (id === null) return { refuse: NO_CAMERA };
      return msg.topic === "probe"
        ? { method: "POST", path: `/cameras/${id}/probe` }
        : { method: "GET", path: `/cameras/${id}` };
    },
    (value) => {
      const body = value as {
        camera?: { id?: unknown };
        run?: { state?: unknown };
        refusal?: unknown;
      } | undefined;
      const id = typeof body?.camera?.id === "string" ? body.camera.id : "camera";
      const state = typeof body?.run?.state === "string" ? body.run.state : "unknown";
      // A refusal is named on the badge, because it is the thing an operator
      // has to fix before Start will do anything at all (R-CAM-10).
      return typeof body?.refusal === "string" ? `${id}: ${body.refusal}` : `${id}: ${state}`;
    },
  );
};
