// SPDX-License-Identifier: GPL-3.0-or-later
import { PREVIEW_RUNGS, type Camera, type Config } from "../schema/config.js";

/**
 * A partial edit to one camera's stream and preview policy, as the shared
 * draft (spec §7) holds it before Apply.
 *
 * Every field optional, at every level. An operator changes one control at a
 * time, and Setup lists whatever has been touched so far beside the applied
 * values — never a complete `Camera`, and this file must not require one to
 * say what is wrong with what has actually been typed.
 */
export interface CameraDraft {
  width?: number;
  height?: number;
  framerate?: number;
  codec?: Camera["codec"];
  /**
   * The Fixed target for the main stream.
   *
   * A camera leaf and not a `stream` one, because that is where
   * `schema/config.ts` keeps it: `stream` is the adaptive envelope around
   * this number, seeded from it. Named here so a draft can carry the one
   * control spec §7 calls *Fixed bitrate* — without it the deck's own
   * `streamBitrate` edit had nowhere to land and was silently dropped by the
   * apply path, which is a control that reports success and changes nothing.
   */
  bitrate_kbps?: number;
  stream?: Partial<Camera["stream"]>;
  preview?: Partial<Camera["preview"]>;
}

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
 * What applying this draft over the currently applied values would interrupt
 * — *restarts the picture*, *preview branch only*, or nothing, per spec §8.1
 * and the table in §11.
 *
 * Compares only the fields the draft actually carries: a field the operator
 * has not touched cannot itself be the reason for an interruption, whatever
 * it happens to hold.
 *
 *   - **A source change — width, height, framerate or codec — restarts the
 *     picture.** These describe the pipeline's own capture, not a policy
 *     layered on top of it, and today's respawn-only pipeline has no way to
 *     change one without stopping and starting again.
 *   - **A preview rung or rate change is preview-branch-only.** Spec §8.1
 *     groups "preview-only size/rate reconfiguration" as one mechanism, kept
 *     off the main stream and board recording.
 *   - **Everything else — floor, ceiling, the fixed target, either mode —
 *     interrupts nothing.** Runtime adaptation inside an applied envelope is
 *     exactly what the rate controller exists to do without a respawn.
 */
export function interruption(draft: CameraDraft, applied: CameraDraft): string[] {
  const out: string[] = [];

  const sourceChanged =
    (draft.width !== undefined && draft.width !== applied.width)
    || (draft.height !== undefined && draft.height !== applied.height)
    || (draft.framerate !== undefined && draft.framerate !== applied.framerate)
    || (draft.codec !== undefined && draft.codec !== applied.codec);
  if (sourceChanged) out.push("restarts the picture");

  const previewBranchChanged =
    (draft.preview?.size !== undefined && draft.preview.size !== applied.preview?.size)
    || (draft.preview?.framerate !== undefined && draft.preview.framerate !== applied.preview?.framerate);
  if (previewBranchChanged) out.push("preview branch only");

  return out;
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

  const config = structuredClone(current);
  const camera = config.cameras[index];
  if (camera === undefined) return { ok: false, error: `no camera is configured with the id "${id}"` };

  if (draft.width !== undefined) camera.width = draft.width;
  if (draft.height !== undefined) camera.height = draft.height;
  if (draft.framerate !== undefined) camera.framerate = draft.framerate;
  if (draft.bitrate_kbps !== undefined) camera.bitrate_kbps = draft.bitrate_kbps;
  if (draft.codec !== undefined) camera.codec = draft.codec;
  if (draft.stream !== undefined) camera.stream = { ...camera.stream, ...draft.stream };
  if (draft.preview !== undefined) camera.preview = { ...camera.preview, ...draft.preview };

  return { ok: true, config };
}

/**
 * The deck's own staged edits, in the shape the apply path takes.
 *
 * **Two naming conventions meet here, and this is the seam.** `YonderDeck`
 * stages a draft under the blueprint's UI-facing names — `streamMode:
 * "Adaptive"`, `previewLadderBottom`, `name` — flat, because `draft.ts`'s own
 * `pending(camera, applied)` in the browser compares one flat map of paths
 * against one flat map of applied values, and it spans both the image-control
 * domain (keyed by capability name) and this schema-shaped one. The
 * configuration is nested and schema-cased (`stream.mode: "adaptive"`).
 * `YonderDeck.appliedForDraft()` is the same seam facing the other way, and
 * this is the one facing in.
 *
 * It is in `yonder-core` rather than in the flows or the browser because both
 * ends have to agree about it, and a JSONata expression translating thirteen
 * field names beside a wire coordinate is CLAUDE.md rule 2. It is separate
 * from `validateDraft` because translation and judgement are different jobs:
 * this renames, and never decides whether the result is applicable.
 *
 * **Anything it does not recognise is returned, named.** A key the deck does
 * not stage — an old draft in a browser that has not reloaded, a hand-written
 * request — must not be dropped silently and must not be written blindly: the
 * caller answers with the names, so an operator is told which of their edits
 * this device does not know about rather than pressing Apply and watching one
 * of them quietly not happen.
 *
 * `name` is deliberately not part of `CameraDraft`: it is the camera's own
 * name, not a stream or preview policy, and it is returned separately so a
 * caller has to decide to write it rather than getting it by omission.
 */
export interface DeckDraft {
  draft: CameraDraft;
  /** The camera's new name, when the deck staged one. */
  name?: string;
  /** Staged paths this translation does not know, in the order given. */
  unknown: string[];
}

/** `"Adaptive" | "Fixed"` back to the schema's own casing. See `toUiMode`. */
function fromUiMode(value: unknown): Camera["stream"]["mode"] | undefined {
  if (value === "Adaptive" || value === "adaptive") return "adaptive";
  if (value === "Fixed" || value === "fixed") return "fixed";
  return undefined;
}

export function deckDraft(staged: Record<string, unknown>): DeckDraft {
  const draft: CameraDraft = {};
  const stream: Record<string, unknown> = {};
  const preview: Record<string, unknown> = {};
  let name: string | undefined;
  const unknown: string[] = [];

  for (const [path, value] of Object.entries(staged)) {
    switch (path) {
      // The four the two conventions already share a name for — the capture
      // itself, which `CameraDraft` has carried since it was written and
      // `interruption()` compares. `YonderDeck` has no Resolution picker yet
      // (spec §7 gives it one), so nothing stages these today; they are here
      // rather than in `unknown` because when that control arrives the name
      // it stages is one of these, and a seam that refused them would make
      // adding the control a change in three files instead of one.
      case "width": draft.width = value as number; break;
      case "height": draft.height = value as number; break;
      case "framerate": draft.framerate = value as number; break;
      case "codec": draft.codec = value as Camera["codec"]; break;
      case "name": if (typeof value === "string") name = value; break;
      case "streamMode": stream.mode = fromUiMode(value); break;
      case "streamFloor": stream.floor_kbps = value; break;
      case "streamCeiling": stream.ceiling_kbps = value; break;
      // The Fixed target lives on the camera itself, not inside `stream` —
      // `schema/config.ts` keeps `bitrate_kbps` a camera leaf and `stream`
      // the envelope around it. The deck's one name for it lands on both
      // sides of that split, which is exactly why this seam is a function.
      case "streamBitrate": draft.bitrate_kbps = value as number; break;
      case "previewMode": preview.mode = fromUiMode(value); break;
      case "previewSize": preview.size = value; break;
      case "previewLadderBottom": preview.ladder_bottom = value; break;
      case "previewLadderTop": preview.ladder_top = value; break;
      case "previewFloor": preview.floor_kbps = value; break;
      case "previewCeiling": preview.ceiling_kbps = value; break;
      case "previewBitrate": preview.bitrate_kbps = value; break;
      case "previewRate": preview.framerate = value; break;
      default: unknown.push(path);
    }
  }
  if (Object.keys(stream).length > 0) draft.stream = stream as CameraDraft["stream"];
  if (Object.keys(preview).length > 0) draft.preview = preview as CameraDraft["preview"];
  return { draft, ...(name === undefined ? {} : { name }), unknown };
}
