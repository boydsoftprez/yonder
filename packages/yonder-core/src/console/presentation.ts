// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The presentation vocabulary, and nothing that touches the machine.
 *
 * `yonder-core`'s main entry pulls in the config loader, the daemon, the
 * nmcli client — everything that makes this a device package. None of that can
 * be bundled into a browser, and the first attempt to import `reading()` into
 * a Vue component failed exactly there: rollup followed the barrel to
 * `readFileSync`.
 *
 * The fix is not a deep path into `dist/`, which would couple the widget
 * package to this one's build layout. It is this: a second entry point that
 * exports **only the pure decisions a page needs**, reachable as
 * `yonder-core/presentation`, with the boundary stated rather than implied.
 *
 * The rule for what belongs here: it must be a pure function of its
 * arguments, it must import nothing from `node:`, and it must be something
 * both a node and a component legitimately need to agree about. Those are the
 * decisions that would otherwise get made twice and drift — which is the
 * whole reason ADR-0005 asked for the command-state language to be built once.
 */

export {
  presentation,
  type CommandState,
  type CommandStatus,
  type CommandPresentation,
} from "./command.js";

export {
  reading,
  type Reading,
  type ReadingBounds,
  type ReadingTone,
} from "./reading.js";

/**
 * The two shapes the camera page's instruments draw.
 *
 * **Types only**, so nothing at runtime follows this line: `video/present.ts`
 * imports the schema, and the schema imports zod, which is exactly the kind of
 * thing this entry point exists to keep out of a browser bundle. `export type`
 * emits nothing at all.
 *
 * They are here rather than declared a second time in
 * `node-red-dashboard-2-yonder/src/shapes.ts` because `capabilityFacts()` and
 * `uplinkBudget()` produce them and those components draw them — which is this
 * file's own rule for what belongs in it: something both a node and a
 * component have to agree about, so it gets decided once rather than twice
 * and drifting.
 */
export type { CapabilityFact, BudgetSegment } from "../video/present.js";

/**
 * The operator-facing word for each capability key — `whiteBalance` is not a
 * label, and a page that showed one would be showing its own field name.
 *
 * A value, not a type, and safe here for the same reason: confirmed against
 * the compiled `dist/video/present.js` before relying on it, that file's own
 * `import type { Camera }` is erased entirely at build time, so nothing pulls
 * the schema (and therefore zod) in behind it. `YonderDeck` is the reader —
 * it draws a heading for all 21 keys, not the 3 `capabilityFacts()` already
 * summarises for the shipped facts row — and a second, hand-typed copy of
 * this exact map inside the dashboard package is precisely the drift this
 * file exists to stop.
 */
export { LABELS } from "../video/present.js";

/**
 * The adapter boundary: labels, display units and gating for one V4L2
 * control (R-CTL-10, R-CTL-11).
 *
 * `DESCRIPTORS` and `describe` are runtime values, not types, and belong
 * here anyway: `video/descriptors.ts` imports only types from
 * `video/capability.ts`, which itself imports nothing, so neither pulls in
 * `node:fs` or the config loader this file's own opening comment keeps out
 * of a browser bundle. A picker or a set bar in
 * `node-red-dashboard-2-yonder` needs the same conversion the config schema
 * and the write path use — raw 156 is 15600 µs everywhere, never
 * recomputed with a second copy of the factor — which is this file's own
 * rule for what belongs in it.
 */
export {
  DESCRIPTORS,
  describe,
  sentenceLabel,
  type ControlDescriptor,
  type DescriptorView,
} from "../video/descriptors.js";

/**
 * Whether a peer can reach one configured output, and by which path
 * (R-VID-16, R-UI-24).
 *
 * A pure function of a kind and three booleans — no device, no socket, no
 * `node:` import — so a camera page can ask it the same question the daemon
 * would ask, and draw the same answer. It states a fact and never acts
 * (R-CMD-04): see `video/outputs.ts` for why disabling an output and an
 * output being unreachable are independent facts, neither implying the
 * other.
 */
export {
  outputReach,
  type OutputReach,
  type OutputDirection,
  type ReachPaths,
  type OutputKind,
} from "../video/outputs.js";

/**
 * What a camera answered, and the discriminated union each capability comes
 * back as (R-CAM-14, R-UI-20, R-UI-21).
 *
 * `video/capability.ts` imports nothing — not `node:fs`, not the config
 * loader, not zod — so re-exporting it here costs a browser bundle nothing,
 * the same reasoning that already applies to `descriptors.ts`'s runtime
 * values above. `YonderDeck` is the first component that draws straight from
 * a capability's own `state`/`reason`/`by`/`value` rather than from a shape
 * something in `yonder-core` has already summarised for it (`CapabilityFact`,
 * above, is exactly that kind of summary, and loses `by.id` and the raw
 * `ControlRange` a control needs to draw itself). `CAPABILITY_KEYS` travels
 * too, as a value: it is what lets a static per-key table compile against
 * the real 21 keys instead of a second, hand-typed list that could quietly
 * fall out of step with it — precisely the reason that array is written down
 * in `capability.ts` rather than derived.
 *
 * **`summarise` joins them for the same reason (R-CAM-12, Task 24).** It is
 * `capability.ts`'s own one-line-per-camera probe summary for the Cameras
 * index page — `exposure: auto exposure has it`, `aim: none` — and until
 * this line it had no way to reach a component at all: not re-exported from
 * this package's main entry either, so `ui-yonder-index` would otherwise
 * have had to compose a second sentence with the same job, which is exactly
 * what the coordinator's own resolution for that task warns against. A pure
 * function of a `CameraCapabilities`, imported from the identical
 * zero-import module the rest of this block already re-exports — nothing
 * new for a browser bundle to carry.
 */
/**
 * **`captureSizes` and `captureRefusal` travel too, and for this file's own
 * reason** (R-CAM-14, R-VID-07). The deck's Resolution and Frame rate
 * pickers are built from the first; the second is the sentence it draws when
 * a staged pair is one this camera cannot make, the sentence the apply route
 * refuses with, and the sentence `video/pipeline.ts`'s own `refuse()`
 * returns. One comparison, three callers — a second copy in the browser
 * would offer a rate the device would then refuse, which is a control that
 * draws and cannot work.
 */
export {
  CAPABILITY_KEYS,
  captureRefusal,
  captureSizes,
  summarise,
  type CaptureSize,
  type Capability,
  type CameraCapabilities,
  type ControlRange,
  type AimCapability,
  type RecordingCapability,
  type StillsCapability,
  type VideoFormat,
} from "../video/capability.js";

/**
 * The draft the deck stages, and the warning it owes an operator *before*
 * Apply is pressed (R-CFG-03, spec §7 and §8.1).
 *
 * Runtime values, and safe here only because `apply/draft-shape.ts` was
 * split out of `apply/draft.ts` to make them so: the latter imports
 * `PREVIEW_RUNGS`, a runtime value from the config schema, and therefore
 * zod — exactly what this file's opening comment keeps out of a browser
 * bundle. `draft-shape.ts` imports nothing but a type.
 *
 * Both belong here by this file's own rule. `interruption()` is the sentence
 * the deck shows before the press and the sentence the apply's answer
 * carries; two copies would drift the first time §8.1's table changes.
 * `deckDraft()` and `draftPathFor()` are the two directions of one seam
 * between the deck's flat, UI-facing paths and the schema's nested ones —
 * the deck translates its own draft to ask `interruption()` about it, and
 * translates back to put a refusal's `problems` beside the field each names.
 */
export {
  deckDraft,
  draftPathFor,
  interruption,
  DRAFT_PATHS,
  type CameraDraft,
  type DeckDraft,
} from "../apply/draft-shape.js";
