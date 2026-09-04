// SPDX-License-Identifier: GPL-3.0-or-later
import { cameraId, registerAdapter, NO_CAMERA } from "./adapter.js";
import type { RED } from "./red.js";

/**
 * `yonder-camera` — one camera, as the device answers it (R-CTL-10).
 *
 * **A read, and never an echo, by default.** The requirement says to show
 * current settings and running state *reading back stored values rather than
 * form defaults*, and the spec leans on it harder than the wording implies: a
 * control shows what the camera reports, never what was sent. So a plain
 * input message ignores whatever settings it is carrying and answers with the
 * daemon's read-back — which is a `current` per control, taken from the
 * device, beside the run state the supervisor observed.
 *
 * **A camera's *stored* settings still have no write path here.** Changing
 * what `config.yaml` holds goes through `yonder-apply` like every other
 * configuration change, so it inherits the confirmation window and the
 * rollback — a second write into that document, from a node, would be a way
 * to change it without either. `msg.topic === "controls"` is a different
 * thing: it posts to `POST /cameras/:id/controls`, the live route
 * `video/controls.ts` added for R-CTL-04 and R-CTL-05, which reaches the
 * sensor directly and touches config.yaml not at all — the same runtime-only
 * shape `yonder-stream`'s start and stop already have, for the same reason:
 * an operator moving a slider needs the picture to answer now, not after a
 * confirmation window. A plain input carrying a payload still stays a read
 * (nothing about that changed) — a control change has to name itself.
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
      if (msg.topic === "controls") {
        const controls = msg.payload;
        // Nothing here decides whether a value is one this device will take —
        // that is `capabilities`, in yonder-core, checked once the daemon has
        // read the device (rule 2 of R-CTL-04/05). This only rejects a shape
        // that could never be controls at all, before spending a round trip.
        if (controls === null || typeof controls !== "object" || Array.isArray(controls)) {
          return { refuse: "this control needs an object naming brightness, contrast or rotation" };
        }
        return { method: "POST", path: `/cameras/${id}/controls`, body: controls };
      }
      return msg.topic === "probe"
        ? { method: "POST", path: `/cameras/${id}/probe` }
        : { method: "GET", path: `/cameras/${id}` };
    },
    (value) => {
      const body = value as {
        camera?: { id?: unknown };
        run?: { state?: unknown };
        refusal?: unknown;
        applied?: unknown;
        refused?: unknown;
      } | undefined;
      // The controls route answers a different shape — `applied`/`refused`,
      // no `camera` or `run` — so the badge is composed from those instead of
      // falling through to "camera: unknown".
      if (body?.applied !== undefined || body?.refused !== undefined) {
        const applied = typeof body?.applied === "object" && body.applied !== null
          ? Object.entries(body.applied as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`)
          : [];
        const refused = Array.isArray(body?.refused)
          ? (body.refused as { control?: unknown }[]).map((r) => (
            typeof r.control === "string" ? `${r.control} refused` : "a control refused"
          ))
          : [];
        const said = [...applied, ...refused];
        return said.length > 0 ? said.join(" · ") : "nothing changed";
      }
      const id = typeof body?.camera?.id === "string" ? body.camera.id : "camera";
      const state = typeof body?.run?.state === "string" ? body.run.state : "unknown";
      // A refusal is named on the badge, because it is the thing an operator
      // has to fix before Start will do anything at all (R-CAM-10).
      return typeof body?.refusal === "string" ? `${id}: ${body.refusal}` : `${id}: ${state}`;
    },
  );
};
