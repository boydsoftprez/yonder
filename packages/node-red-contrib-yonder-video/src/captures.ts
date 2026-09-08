// SPDX-License-Identifier: GPL-3.0-or-later
import { cameraId, registerAdapter, NO_CAMERA } from "./adapter.js";
import type { RED } from "./red.js";

/**
 * `yonder-captures` — the shutter, and the files it makes (R-CAM-17,
 * R-CAM-18, R-STO-06).
 *
 * **This node exists because a press had nowhere to go.** `YonderDeck` has
 * emitted `{ shutter: "record" | "stop" | "photo" }` since the deck was
 * built, and `cam-deck-route` switched on `control`, `apply`, `output` and
 * `mode` — so a shutter message matched no rule, reached no output and was
 * dropped in silence. Pressing RECORD on the camera page did nothing at all,
 * with no error anywhere, which is the same class of invisible failure
 * `widget.ts` records for `emitsActions` one layer up.
 *
 * **The message says what happened; this node says which route that is.**
 * The alternative was a `change` node composing `{"action": "start"}` in
 * JSONata from `payload.shutter`, and CLAUDE.md rule 2 is exactly about that:
 * a decision serialised into `flows.json` beside a wire coordinate is a
 * decision nobody can review a diff of. So the deck posts what the operator
 * did, this file maps it to a route, and `flows.json` carries a wire.
 *
 * **A stop is a `record` with `action: "stop"`, not a route of its own.** The
 * daemon's own route takes the action in the body (33a), and inventing a
 * second path here would be this node deciding something about recording.
 *
 * Four things reach four routes:
 *
 * | the message carries | the route |
 * |---|---|
 * | `shutter: "record"` | `POST /cameras/:id/record` `{action:"start"}` |
 * | `shutter: "stop"` | `POST /cameras/:id/record` `{action:"stop"}` |
 * | `shutter: "photo"` | `POST /cameras/:id/photo` |
 * | `remove: "<name>"` | `DELETE /cameras/:id/captures/<name>` |
 * | anything else | `GET /cameras/:id/captures` |
 *
 * **The listing is the fall-through, deliberately.** Every one of the four
 * actions above is followed by wanting the list again — a photo lands in it,
 * a delete leaves it, a recording that has stopped becomes a file in it — so
 * the flow re-reads through this same node afterwards, and a plain message
 * with nothing in it is that read. It is also what the `CAPTURES ›` link
 * sends, which is the same request for the same reason.
 *
 * **`remove`, not `delete`.** `delete` is a reserved word, and a payload key
 * an operator cannot write in a JSONata expression without quoting it is a
 * key that will be got wrong once. The panel emits `remove` and this reads
 * it; nothing in between has to spell it twice.
 *
 * **Nothing here decides whether a capture may be taken or deleted.** The
 * reserve, the one-at-a-time guard, whether the camera holds the file — all
 * `video/recorder.ts`'s, refused there with the sentence an operator reads
 * and a kind the route turns into a status. This node's own refusals are the
 * two a round trip cannot answer: no camera named, and a shape that could
 * never be a name.
 */

/**
 * A capture name, as the daemon's own `SAFE_CAPTURE_NAME`.
 *
 * Checked here as well as there because this one goes into a *path* — the
 * same reason `camera.ts` checks a viewer id it also sends — and a string
 * with a slash in it would address a different route entirely. The daemon
 * checks it again where it means a file, which is where it must be right.
 */
const CAPTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export = function register(RED: RED): void {
  registerAdapter(
    RED,
    "yonder-captures",
    (msg, config) => {
      const id = cameraId(msg, config);
      if (id === null) return { refuse: NO_CAMERA };
      const sent = (msg.payload ?? {}) as { shutter?: unknown; remove?: unknown };

      if (sent.shutter === "record" || sent.shutter === "stop") {
        return {
          method: "POST",
          path: `/cameras/${id}/record`,
          body: { action: sent.shutter === "stop" ? "stop" : "start" },
          camera: id,
        };
      }
      if (sent.shutter === "photo") {
        return { method: "POST", path: `/cameras/${id}/photo`, camera: id };
      }
      if (sent.shutter !== undefined) {
        // A shutter this node does not know is refused rather than quietly
        // read as a listing. The deck sends three words; a fourth arriving
        // here means the two have drifted, and the honest answer is to say so
        // rather than to answer a question nobody asked.
        return { refuse: 'a shutter press is "record", "stop" or "photo"' };
      }

      if (sent.remove !== undefined) {
        if (typeof sent.remove !== "string" || !CAPTURE_NAME.test(sent.remove)) {
          return { refuse: "name the capture to delete on payload.remove" };
        }
        return {
          method: "DELETE",
          path: `/cameras/${id}/captures/${encodeURIComponent(sent.remove)}`,
          camera: id,
        };
      }

      return { method: "GET", path: `/cameras/${id}/captures`, camera: id };
    },
    (value) => {
      const body = value as {
        destination?: unknown;
        kind?: unknown;
        captures?: unknown;
        name?: unknown;
        recording?: unknown;
        since?: unknown;
        ended?: { reason?: unknown } | null;
      } | undefined;

      // The listing: how many, which is what the link beside the shutter key
      // says too.
      if (body?.destination === 'camera' && body?.kind === 'photo') return 'Photo saved to camera card';
      if (Array.isArray(body?.captures)) {
        const n = body.captures.length;
        return n === 1 ? "1 capture" : `${String(n)} captures`;
      }
      // A recording started or stopped. **How it ended is on the badge**, not
      // only in the panel: a recording that stopped at the reserve and one the
      // operator stopped are the same silence otherwise, and R-STO-06 is only
      // honest if the interface can say which happened.
      if (typeof body?.recording === "boolean") {
        if (body.recording) return "recording";
        const reason = body.ended === null || body.ended === undefined
          ? undefined
          : body.ended.reason;
        return typeof reason === "string" ? `recording ended · ${reason}` : "recording stopped";
      }
      // A still, or a delete: both answer with the capture's own name.
      if (typeof body?.name === "string") return body.name;
      return "nothing changed";
    },
  );
};
