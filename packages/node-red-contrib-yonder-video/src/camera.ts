// SPDX-License-Identifier: GPL-3.0-or-later
import { applyStatus, confirmed } from "yonder-core";
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
        return { method: "POST", path: `/cameras/${id}/controls`, body: controls, camera: id };
      }
      /**
       * The Setup deck's **Apply** — one whole draft, once (R-CFG-03).
       *
       * A different route from `settings` below, and the difference is the
       * defect this task is named for. `settings` takes one flat key at a
       * time, which is the shape a `ui-number-input` posts on blur: one
       * field, one apply, one confirmation window per box an operator tabs
       * out of. `apply` takes everything the deck staged, validated as a
       * whole by `apply/draft.ts` before any of it is written — and the deck
       * emits it exactly once, on a press.
       *
       * The daemon answers the engine's own state, so `applyStatus` below
       * draws a countdown exactly where a window armed.
       */
      if (msg.topic === "apply") {
        const draft = msg.payload;
        // As with `controls`: nothing here decides whether a draft is
        // applicable — `validateDraft` does, in yonder-core, once the daemon
        // has the camera's own supported sizes to check a held rung against.
        // This only rejects a shape that could never be a draft at all.
        if (draft === null || typeof draft !== "object" || Array.isArray(draft)) {
          return { refuse: "an apply needs a draft naming what to change" };
        }
        return { method: "POST", path: `/cameras/${id}/apply`, body: draft, camera: id };
      }
      /**
       * One output stopped or started (R-UI-24). `msg.output` names which,
       * because the kind is part of the route rather than of the body — the
       * same addressing shape `msg.camera` already has, one level down.
       */
      if (msg.topic === "output") {
        const kind = msg.output;
        if (kind !== "rtp" && kind !== "rtsp" && kind !== "srt") {
          return { refuse: "name the output to switch: rtp, rtsp or srt" };
        }
        const enabled = (msg.payload as { enabled?: unknown } | undefined)?.enabled;
        if (typeof enabled !== "boolean") {
          return { refuse: "an output is switched with { enabled: true } or { enabled: false }" };
        }
        return { method: "POST", path: `/cameras/${id}/outputs/${kind}`, body: { enabled }, camera: id };
      }
      // R-CTL-02, R-CTL-03. A different thing again from `controls` above:
      // this changes what the camera *is* rather than what it is doing, so it
      // goes through the apply engine and inherits the confirmation window and
      // the rollback — which is why the answer is an apply's, and why the
      // Setup deck's countdown is the engine's own and not a guess.
      if (msg.topic === "settings") {
        const settings = msg.payload;
        if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
          return { refuse: "this control needs an object naming a setting to change" };
        }
        return { method: "POST", path: `/cameras/${id}/settings`, body: settings, camera: id };
      }
      return msg.topic === "probe"
        ? { method: "POST", path: `/cameras/${id}/probe`, camera: id }
        : { method: "GET", path: `/cameras/${id}`, camera: id };
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
      // An apply's answer, from the settings route: it carries an id and a
      // deadline, not a camera. Reported as what it is, so a node badge does
      // not read "camera: unknown" for a change that worked.
      if (typeof (body as { id?: unknown } | undefined)?.id === "string"
        && body?.camera === undefined && body?.run === undefined) {
        const expiresAt = (body as { expiresAt?: unknown }).expiresAt;
        return expiresAt === null
          ? "applied, and kept"
          : "applied, waiting to be confirmed";
      }
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
    /**
     * A settings change is an apply, and an apply may be *pending*.
     *
     * `applyStatus` is the same function `yonder-apply` uses, so the wording,
     * the tone and the deadline are the ones every other apply on this console
     * produces — and the Setup deck's countdown is therefore the engine's own
     * answer rather than a prediction of it. Everything else this node asks
     * for is a question, and a question answered is confirmed.
     */
    (value, said, at) => {
      const body = value as { id?: unknown } | undefined;
      return typeof body?.id === "string"
        ? applyStatus({ ok: true, status: 200, body: value }, at)
        : confirmed(said, { at });
    },
  );
};
