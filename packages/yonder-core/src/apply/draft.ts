// SPDX-License-Identifier: GPL-3.0-or-later
import { PREVIEW_RUNGS, type Camera } from "../schema/config.js";

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
