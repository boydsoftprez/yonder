// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera } from "../schema/config.js";

/**
 * The draft's own shape, and the two pure functions over it a *browser* needs.
 *
 * Split out of `draft.ts` for one reason, stated so it is not merged back:
 * `draft.ts` imports `PREVIEW_RUNGS` — a runtime value from
 * `schema/config.ts`, which imports zod — and `console/presentation.ts`
 * exists to keep exactly that out of a browser bundle (see its own opening
 * comment). `YonderDeck` has to call `interruption()` and `deckDraft()` to
 * warn an operator *before* Apply is pressed, and it cannot reach them
 * through a module that drags the config schema in behind them. Everything
 * here imports types only, and `import type` is erased at build time.
 *
 * `draft.ts` re-exports all of it, so nothing on the device side has to know
 * this file exists.
 */

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
  image?: Partial<Camera['image']>;
  outputs?: Partial<Record<Camera['outputs'][number]['kind'], boolean>>;
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
  /**
   * The turns the **board** performs, and only those (R-CTL-05).
   *
   * A turn the sensor can do is a live device write and never reaches a
   * draft. A turn the board does is a `videoflip` in the launch line — a
   * pipeline change, so it restarts the picture, so it is an Apply like a
   * bitrate rather than a press like brightness.
   */
  controls?: Partial<Camera["controls"]>;
  preview?: Partial<Camera["preview"]>;
}

/**
 * Every path the deck can stage, and the dotted place in a `CameraDraft` it
 * lands in.
 *
 * **One table, read in both directions.** `deckDraft()` below goes one way —
 * the deck's flat, UI-facing names into the schema's nested ones — and the
 * deck itself needs the other: `POST /cameras/:id/apply` answers `problems`
 * keyed by *schema* path (`preview.floor_kbps`), and the pending block that
 * has to mark the offending field knows only its own name for it
 * (`previewFloor`). Two hand-kept lists would be two chances to disagree
 * about thirteen names; `apply/draft.test.ts` holds this one against
 * `deckDraft` by feeding it every key here and checking each lands.
 *
 * `name` is deliberately absent: it is the camera's own name, not a stream or
 * preview policy, and `deckDraft` returns it separately so a caller has to
 * decide to write it rather than getting it by omission.
 */
export const DRAFT_PATHS: Record<string, string> = {
  imageBrightness: 'image.brightness', imageContrast: 'image.contrast',
  imageSaturation: 'image.saturation', imageHue: 'image.hue',
  outputRtp: 'outputs.rtp',
  outputRtsp: 'outputs.rtsp',
  outputSrt: 'outputs.srt',
  width: "width",
  height: "height",
  framerate: "framerate",
  codec: "codec",
  streamBitrate: "bitrate_kbps",
  streamMode: "stream.mode",
  streamFloor: "stream.floor_kbps",
  streamCeiling: "stream.ceiling_kbps",
  previewMode: "preview.mode",
  previewSize: "preview.size",
  previewLadderBottom: "preview.ladder_bottom",
  previewLadderTop: "preview.ladder_top",
  previewFloor: "preview.floor_kbps",
  previewCeiling: "preview.ceiling_kbps",
  previewBitrate: "preview.bitrate_kbps",
  previewRate: "preview.framerate",
  /**
   * **The three turns, when the board is doing the turning** (R-CTL-05).
   *
   * A turn the *sensor* performs is a live control: it goes to the device and
   * changes the picture, like brightness. A turn the *board* performs is a
   * change to the pipeline — `compose()` puts a `videoflip` after the decode
   * and before the tee — so it is a configuration change like a bitrate, it
   * restarts the picture, and it belongs on the staged draft with an Apply
   * behind it.
   *
   * Shipped once without this, and it was the operator who found it: the
   * controls drew, the press went to `/controls`, and a camera whose sensor
   * cannot turn its own picture answered *"this camera does not offer
   * horizontalFlip"* — a refusal for a thing Yonder can do perfectly well.
   */
  rotation: "controls.rotation",
  horizontalFlip: "controls.horizontalFlip",
  verticalFlip: "controls.verticalFlip",
};

/** The staged path a schema-keyed problem is about, or `null`. */
export function draftPathFor(schemaPath: string): string | null {
  for (const [ui, path] of Object.entries(DRAFT_PATHS)) if (path === schemaPath) return ui;
  return null;
}

/** What the deck's own translation answers. */
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
 */
export function deckDraft(staged: Record<string, unknown>): DeckDraft {
  const draft: CameraDraft = {};
  const stream: Record<string, unknown> = {};
  const preview: Record<string, unknown> = {};
  // The three turns the *board* performs. They are a pipeline change, not a
  // device write, so they travel on the draft and land under `controls`.
  const controls: Record<string, unknown> = {};
  const outputs: Record<string, unknown> = {};
  const image: Record<string, unknown> = {};
  let name: string | undefined;
  const unknown: string[] = [];

  for (const [path, value] of Object.entries(staged)) {
    switch (path) {
      case 'imageBrightness': image.brightness = value; break;
      case 'imageContrast': image.contrast = value; break;
      case 'imageSaturation': image.saturation = value; break;
      case 'imageHue': image.hue = value; break;
      case 'outputRtp': outputs.rtp = value; break;
      case 'outputRtsp': outputs.rtsp = value; break;
      case 'outputSrt': outputs.srt = value; break;
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
      case "rotation": controls.rotation = value; break;
      case "horizontalFlip": controls.horizontalFlip = value; break;
      case "verticalFlip": controls.verticalFlip = value; break;
      default: unknown.push(path);
    }
  }
  if (Object.keys(controls).length > 0) draft.controls = controls as CameraDraft["controls"];
  if (Object.keys(image).length > 0) draft.image = image as CameraDraft['image'];
  if (Object.keys(outputs).length > 0) draft.outputs = outputs as CameraDraft['outputs'];
  if (Object.keys(stream).length > 0) draft.stream = stream as CameraDraft["stream"];
  if (Object.keys(preview).length > 0) draft.preview = preview as CameraDraft["preview"];
  return { draft, ...(name === undefined ? {} : { name }), unknown };
}

/**
 * What applying this draft over the currently applied values would interrupt
 * — *restarts the picture*, *preview branch only*, or nothing, per spec §8.1
 * and the table in §11.
 *
 * **Called from both sides, which is the point.** `YonderDeck.buildPending()`
 * calls it over its own staged draft so the warning is on the page *before*
 * Apply is pressed; `daemon/routes.ts` calls it over the draft it was sent so
 * the answer carries the same sentence. One calculation, two callers — the
 * alternative is a second copy in the browser that drifts the first time this
 * table changes.
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
  // **A turn the board performs restarts the picture too**, and for the same
  // reason a size change does: it is an element in the launch line, so the
  // line differs, so `PipelineRenderer` respawns. It reached the operator
  // with an empty interruption list once — the Apply confirmed, the picture
  // cut, and nothing had said it would.
  //
  // Only a turn that actually moves. Staging Mirror and unstaging it before
  // Apply leaves the draft naming a value the camera already holds, and a
  // warning about a restart that will not happen is the kind of noise that
  // teaches an operator to stop reading them.
  const turnChanged = (["rotation", "horizontalFlip", "verticalFlip"] as const)
    .some((k) => draft.controls?.[k] !== undefined && draft.controls[k] !== applied.controls?.[k]);
  const imageChanged = Object.entries(draft.image ?? {}).some(([key, value]) => value !== applied.image?.[key as keyof Camera['image']]);
  if (sourceChanged || turnChanged || imageChanged) out.push("restarts the picture");
  if (Object.entries(draft.outputs ?? {}).some(([kind, enabled]) => enabled !== applied.outputs?.[kind as keyof NonNullable<CameraDraft['outputs']>]) && !out.includes('restarts the picture')) out.push('restarts the picture');

  const previewBranchChanged =
    (draft.preview?.size !== undefined && draft.preview.size !== applied.preview?.size)
    || (draft.preview?.framerate !== undefined && draft.preview.framerate !== applied.preview?.framerate);
  if (previewBranchChanged) out.push("preview branch only");

  return out;
}
