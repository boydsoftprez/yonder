// SPDX-License-Identifier: GPL-3.0-or-later
import { previewCaptureRefusal } from "../video/settings.js";
import { PREVIEW_RUNGS, CameraImage, type Config } from "../schema/config.js";
import type { CameraDraft } from "./draft-shape.js";

/**
 * The draft's shape, and the two pure functions over it, live in
 * `draft-shape.ts` — see that file's own comment: `PREVIEW_RUNGS` below is a
 * runtime import of the config schema, and therefore of zod, which
 * `console/presentation.ts` exists to keep out of a browser bundle. They are
 * re-exported here so nothing on the device side has to know about the split.
 */
export {
  deckDraft, draftPathFor, interruption, DRAFT_PATHS,
  type CameraDraft, type DeckDraft,
} from "./draft-shape.js";

/** One thing wrong with a draft, named by the field the page should mark. */
export interface DraftProblem {
  /** A dotted path into the draft, e.g. `"preview.floor_kbps"`. */
  path: string;
  /** What is wrong, in an operator's words, for the page to show beside the field. */
  message: string;
}

function rungIndex(size: string): number {
  return (PREVIEW_RUNGS as readonly string[]).indexOf(size);
}

/** Kept here so draft validation can name the field before the schema runs. */
const IPV4_PATTERN = /^(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]{1,2})$/;

/**
 * What is wrong with a draft, by path — and never a fix for it (R-CMD-04).
 *
 * **This never repairs, and that is the whole point (Coordinator resolution
 * 2).** Swapping a reversed floor and ceiling, clamping an out-of-range
 * value, or substituting the nearest legal size would all be Yonder deciding
 * what the operator meant. It reports, and the page shows what is wrong;
 * the operator decides what to type instead.
 *
 * Three checks, each only where the draft actually carries both sides of it
 * — a draft is partial by design, and a field an operator has not touched
 * yet is not a problem:
 *
 *   - **floor ≤ ceiling**, on `stream` and on `preview` alike (spec §7 gives
 *     both a Floor · Ceiling control).
 *   - **`ladder_bottom` ≤ `ladder_top`** — the smallest automatic size is not
 *     larger than the largest one, compared by `PREVIEW_RUNGS`' own order
 *     rather than by string, because `"640x360" > "854x480"` as text.
 *   - **a held `size` is a rung this camera actually offers.** `"auto"` is
 *     always legal — it is the controller's own free-running mode, not a
 *     claim about any one size — so only a pinned rung is checked against
 *     `supportedRungs`, the sizes a real camera's own probe found. This
 *     schema's own `PREVIEW_RUNGS` is not what a held size is checked
 *     against: a camera can offer fewer than all three, and a size the
 *     schema allows in general is still wrong for a camera that does not
 *     make it.
 */
export function validateDraft(draft: CameraDraft, supportedRungs: readonly string[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (draft.image !== undefined) {
    const parsed = CameraImage.partial().safeParse(draft.image);
    if (!parsed.success) for (const issue of parsed.error.issues) problems.push({ path: `image.${issue.path.join('.')}`, message: issue.message });
  }
  if (draft.outputs !== undefined) {
    if (!draft.outputs || typeof draft.outputs !== 'object' || Array.isArray(draft.outputs)) problems.push({ path: 'outputs', message: 'Output edits must name configured output kinds' });
    else for (const [kind, value] of Object.entries(draft.outputs)) {
      if (kind === 'rtpHost') {
        if (typeof value !== 'string' || !IPV4_PATTERN.test(value)) problems.push({ path: 'outputs.rtpHost', message: 'must be an IPv4 address, for example 192.168.1.50' });
      } else if (kind === 'rtpPort') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) problems.push({ path: 'outputs.rtpPort', message: 'must be a whole port number from 1 to 65535' });
      } else if (!['rtp', 'rtsp', 'srt'].includes(kind)) problems.push({ path: `outputs.${kind}`, message: 'Unknown output kind' });
      else if (typeof value !== 'boolean') problems.push({ path: `outputs.${kind}`, message: 'Output enablement must be true or false' });
    }
  }

  const checkFloorCeiling = (scope: "stream" | "preview", floor?: number, ceiling?: number): void => {
    if (floor === undefined || ceiling === undefined) return;
    if (floor > ceiling) {
      problems.push({
        path: `${scope}.floor_kbps`,
        message: `the floor (${floor} kb/s) is above the ceiling (${ceiling} kb/s)`,
      });
    }
  };
  checkFloorCeiling("stream", draft.stream?.floor_kbps, draft.stream?.ceiling_kbps);
  checkFloorCeiling("preview", draft.preview?.floor_kbps, draft.preview?.ceiling_kbps);

  const bottom = draft.preview?.ladder_bottom;
  const top = draft.preview?.ladder_top;
  if (bottom !== undefined && top !== undefined && rungIndex(bottom) < rungIndex(top)) {
    problems.push({
      path: "preview.ladder_bottom",
      message: `the smallest automatic size (${bottom}) is larger than the largest (${top})`,
    });
  }

  const size = draft.preview?.size;
  if (size !== undefined && size !== "auto" && !supportedRungs.includes(size)) {
    problems.push({
      path: "preview.size",
      message: supportedRungs.length > 0
        ? `this camera does not offer ${size}; it offers ${supportedRungs.join(", ")}`
        : `this camera has not offered any size yet, so ${size} cannot be held`,
    });
  }

  return problems;
}


/**
 * The configuration this device should have with that draft applied to one
 * camera — the whole document, with nothing else touched.
 *
 * **Nothing is checked here that the schema owns.** Bounds, enums and the
 * shape of every leaf are the schema's, run by the engine on the way in; a
 * second copy of `min(100).max(20000)` in this file is a copy to keep in
 * step for no benefit (`video/settings.ts`'s own `setCameraSettings` states
 * the same rule for the same reason). What *is* checked before this runs is
 * `validateDraft` above, which is the set of cross-field rules the schema
 * cannot express — a floor above its ceiling is two legal numbers in an
 * illegal order.
 *
 * **And nothing is repaired** (R-CMD-04, and `validateDraft`'s own note):
 * a draft that failed validation never reaches here, so this function has no
 * branch that could quietly clamp or reorder what the operator typed.
 *
 * Undefined fields are left alone at every level, which is the whole reason
 * this exists rather than a spread of the draft over the camera: `{...camera,
 * ...draft}` would write `stream: undefined` over a real envelope for a draft
 * that never mentioned `stream`.
 */
export function applyCameraDraft(
  current: Config,
  id: string,
  draft: CameraDraft,
): { ok: true; config: Config } | { ok: false; error: string } {
  const index = current.cameras.findIndex((c) => c.id === id);
  if (index === -1) return { ok: false, error: `no camera is configured with the id "${id}"` };

  if (draft.image !== undefined && !CameraImage.partial().safeParse(draft.image).success) return { ok: false, error: "Stream color values are outside their supported ranges" };
  const config = structuredClone(current);
  const camera = config.cameras[index];
  if (camera === undefined) return { ok: false, error: `no camera is configured with the id "${id}"` };
  if (draft.outputs !== undefined) {
    const outputDraft = draft.outputs;
    const invalidDestination = validateDraft({ outputs: outputDraft }, []).find((problem) =>
      problem.path === 'outputs.rtpHost' || problem.path === 'outputs.rtpPort',
    );
    if (invalidDestination !== undefined) return { ok: false, error: invalidDestination.message };

    const rtp = camera.outputs.find((output) => output.kind === 'rtp');
    const hasRtpDestination = outputDraft.rtpHost !== undefined || outputDraft.rtpPort !== undefined;
    if (rtp === undefined && hasRtpDestination) {
      // An RTP output has no safe default peer.  It is created only when the
      // operator supplied the complete destination in this same draft.
      if (typeof outputDraft.rtpHost !== 'string' || typeof outputDraft.rtpPort !== 'number') {
        return { ok: false, error: 'An RTP destination needs both an IPv4 host and a port' };
      }
      camera.outputs.push({
        kind: 'rtp',
        host: outputDraft.rtpHost,
        port: outputDraft.rtpPort,
        // Entering a destination only prepares it.  Traffic starts only when
        // the operator also chose Enable in this draft.
        enabled: outputDraft.rtp === true,
      });
    } else if (rtp !== undefined && hasRtpDestination) {
      if (outputDraft.rtpHost !== undefined) rtp.host = outputDraft.rtpHost;
      if (outputDraft.rtpPort !== undefined) rtp.port = outputDraft.rtpPort;
    }

    for (const [kind, enabled] of Object.entries(outputDraft)) {
      if (kind === 'rtpHost' || kind === 'rtpPort') continue;
      if (typeof enabled !== 'boolean') return { ok: false, error: 'Output enablement must be true or false' };
      if (!camera.outputs.some(output => output.kind === kind)) {
        // There is no RTP stream to stop, and no peer has been supplied to
        // create one.  Treat an initial default-off switch as unchanged.
        if (kind === 'rtp' && enabled === false) continue;
        if (kind === 'rtsp') camera.outputs.push({ kind: 'rtsp', enabled, password: { secret: 'rtsp_password' } });
        else return { ok: false, error: `This camera has no configured ${kind} output to change` };
      }
      for (const output of camera.outputs) if (output.kind === kind) output.enabled = enabled;
    }
  }

  if (draft.width !== undefined) camera.width = draft.width;
  if (draft.height !== undefined) camera.height = draft.height;
  if (draft.framerate !== undefined) camera.framerate = draft.framerate;
  if (draft.bitrate_kbps !== undefined) camera.bitrate_kbps = draft.bitrate_kbps;
  if (draft.codec !== undefined) camera.codec = draft.codec;
  if (draft.stream !== undefined) camera.stream = { ...camera.stream, ...draft.stream };
  if (draft.preview !== undefined) camera.preview = { ...camera.preview, ...draft.preview };
  // **Merged, never replaced** — as `stream` and `preview` are, and for the
  // same reason: a draft names the one control the operator moved, and
  // assigning the object would set every other control on this camera to the
  // schema's `null` and undo them.
  //
  // Missing here once, and the omission was silent: `deckDraft()` translated
  // the staged turn, `validateDraft()` passed it, the route answered 200, and
  // the value never reached the camera. That is exactly the "an Apply that
  // reported success and left one of the operator's edits unmade" this route's
  // own comment says the draft mechanism exists to remove — one layer below
  // where it says it.
  if (draft.controls !== undefined) camera.controls = { ...camera.controls, ...draft.controls };
  if (draft.image !== undefined) camera.image = { ...camera.image, ...draft.image };

  const refusal = previewCaptureRefusal(camera);
  if (refusal) return { ok: false, error: refusal };
  return { ok: true, config };
}
