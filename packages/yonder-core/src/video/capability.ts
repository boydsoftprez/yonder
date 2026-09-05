// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * What a camera can do, as the camera answered it (R-CAM-14).
 *
 * The cameras this project supports really are different — one has a gimbal
 * and its own card, three have neither — but none of those differences is a
 * *kind of page*. Every one is a different set of answers to the same
 * questions, so a camera is an identity, a source and this, and the page is
 * generated from it. The consequence that matters: a zoom control looks and
 * behaves identically whether it is a sensor crop, a UVC control, or a
 * protocol message answered by cropping at the receiver.
 *
 * **Four states. Two of them are why this is a union rather than an
 * optional** — a plain `{ value?: T }` cannot also carry a reason, or name
 * who is in charge.
 *
 * - `present` — the device answered and the control works.
 * - `not-offered` — the device does not have it. The page states this as a
 *   fact where the control would have been: one row of text, never a control
 *   that cannot be used and never silently nothing (R-UI-20).
 * - `advertised` — the device lists it, accepts the command, and does
 *   nothing. **This is a fault, not a feature the camera lacks**, and it
 *   carries its reason. It is the state most likely to be got wrong in code,
 *   because on the wire it is indistinguishable from success: the accessory
 *   camera's live-view resolution was tried at fifteen values across three
 *   payload widths and every one was acknowledged while the frame stayed
 *   1280x720. **It carries a value too** — the same reading `present` would
 *   have, when the device gave one before it stopped taking effect — so the
 *   page still has something to draw the dead control from, rather than a
 *   bare sentence where a control used to be (R-UI-21).
 * - `gated` — the control is real and working, and another control currently
 *   has charge of it (R-UI-21). **Not a fault.** The bench camera's
 *   `exposure_time_absolute` answers a real range right up until
 *   `auto_exposure` is put in Manual, which is the device behaving exactly as
 *   documented, not a defect to report. The page draws it inert, in a
 *   neutral tone, and names the control that has charge of it in words an
 *   operator would use — `auto exposure` — never the V4L2 name
 *   `auto_exposure` an operator has no reason to know.
 *
 * A discriminated union rather than `{ value?: T }` because the compiler is
 * then the thing that stops a caller reading a value off a capability that has
 * none — which is the whole failure this vocabulary exists to prevent.
 *
 * **The field names are chosen to map onto MAVLink's `CAMERA_CAP_FLAGS`
 * without a translation layer.** `CAMERA_INFORMATION` carries a capability
 * flagset, which is the same idea this arrived at independently, and R-VID-12
 * in M7 turns these into bits: `zoom` -> HAS_BASIC_ZOOM, `focus` ->
 * HAS_BASIC_FOCUS, `recording` -> CAPTURE_VIDEO, `stills` -> CAPTURE_IMAGE,
 * `formats` -> HAS_VIDEO_STREAM. No numeric value is written here: M7 reads
 * them from the dialect it links against rather than from a copy in this file
 * that could drift from it.
 */
export type Capability<T> =
  | { readonly state: "present"; readonly value: T }
  | { readonly state: "not-offered" }
  | { readonly state: "advertised"; readonly value: T | undefined; readonly reason: string }
  | {
      readonly state: "gated";
      readonly value: T;
      /** Who has charge of it — an id for code, a label for an operator. */
      readonly by: { readonly id: string; readonly label: string };
    };

export function present<T>(value: T): Capability<T> {
  return { state: "present", value };
}
export function notOffered<T>(): Capability<T> {
  return { state: "not-offered" };
}
/**
 * `reason` is shown on the inoperative control, so write it for an operator.
 *
 * `value` is what the device last answered for it — the same reading
 * `present` would carry — so the page can still draw the dead control
 * instead of falling back to a bare sentence (R-UI-21). Kept optional via
 * overload rather than made a required second argument: every existing
 * caller has only a reason, never a value, and none of them is this task's
 * to edit. `advertised<T>(reason)` is exactly `advertised<T>(undefined,
 * reason)`.
 */
export function advertised<T>(reason: string): Capability<T>;
export function advertised<T>(value: T | undefined, reason: string): Capability<T>;
export function advertised<T>(valueOrReason: T | undefined | string, reason?: string): Capability<T> {
  return reason === undefined
    ? { state: "advertised", value: undefined, reason: valueOrReason as string }
    : { state: "advertised", value: valueOrReason as T | undefined, reason };
}
/**
 * The control is real and in range; another one has charge of it (R-UI-21).
 * **Not a fault**, so unlike `advertised` there is no reason to carry — only
 * `by`, the control that has it, named as an operator would: `{ id:
 * "auto_exposure", label: "auto exposure" }`, never the id alone.
 */
export function gated<T>(value: T, by: { readonly id: string; readonly label: string }): Capability<T> {
  return { state: "gated", value, by };
}

/** One capture mode the device offered: a pixel format, a size and its rates. */
export interface VideoFormat {
  readonly fourcc: string;
  readonly width: number;
  readonly height: number;
  /** Frames per second, largest first. */
  readonly rates: readonly number[];
}

/** A V4L2 control's range, as the device reported it (R-CTL-10). */
export interface ControlRange {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
  /** What the device says it is *now* — never what was last sent. */
  readonly current: number;
  /**
   * Whether another setting has this one gated right now (R-UI-21).
   * **Not a fault** — the device still answers a range for it, so the page
   * draws it inert and names the setting that has charge of it, rather than
   * hiding it or drawing a control nothing will move. Non-optional and
   * `false` when nothing gates it, so a caller never has to tell "not gated"
   * apart from "the parser did not look".
   */
  readonly inactive: boolean;
  /**
   * The entries a `(menu)` control actually offers, in the device's own
   * order (R-CAM-14) — never widened to fill `min…max`: the bench camera's
   * `auto_exposure` reports `min=0 max=3` but lists only ids 1 and 3, and
   * expanding the range would put two modes on the page it does not have.
   * Absent for a control that is not a menu, and for a menu whose entry
   * lines did not parse — an empty array would claim the device offers a
   * menu with nothing in it, which is a different and false claim.
   */
  readonly menu?: readonly { id: number; label: string }[];
}

/** What a gimbal can reach. M5 fills it; M4 always reports `not-offered`. */
export interface AimCapability {
  readonly pitch: { readonly min: number | null; readonly max: number | null };
  readonly yaw: { readonly min: number | null; readonly max: number | null };
  /** The work mode the envelope was learned in; an envelope is per mode. */
  readonly mode: string;
}

/** Where a recording lands. M5 fills it. */
export interface RecordingCapability {
  readonly medium: "camera" | "board";
}

/** Where a still comes from, and therefore whether Yonder can show it. */
export interface StillsCapability {
  readonly source: "camera" | "pipeline";
}

export interface CameraCapabilities {
  readonly formats: Capability<readonly VideoFormat[]>;
  readonly zoom: Capability<ControlRange>;
  readonly focus: Capability<ControlRange>;
  readonly exposure: Capability<ControlRange>;
  readonly whiteBalance: Capability<ControlRange>;
  readonly brightness: Capability<ControlRange>;
  readonly contrast: Capability<ControlRange>;
  /**
   * V4L2's `rotate` control, in degrees (R-CTL-05). **Not every UVC camera
   * implements it** — probed like any other control rather than assumed, so
   * a camera that lacks it reports `not-offered` instead of the page falling
   * back to rotating the pipeline, which would be a stream control wearing
   * an image control's clothes (see `video/controls.ts`).
   */
  readonly rotation: Capability<ControlRange>;
  readonly aim: Capability<AimCapability>;
  readonly recording: Capability<RecordingCapability>;
  readonly stills: Capability<StillsCapability>;

  /**
   * Ten more controls the bench camera answers, read off `v4l2-ctl
   * --list-ctrls` alongside the eighteen it reports in total: `brightness`,
   * `contrast`, `white_balance_temperature`, `exposure_time_absolute`,
   * `pan_absolute`, `tilt_absolute`, `focus_absolute` and `zoom_absolute`
   * already had a field above, which leaves these ten with nowhere to live
   * (R-CTL-11 … R-CTL-14). `probe/camera.ts`'s `CONTROL_MAP` reads all ten,
   * so a camera that answers them reports `present` rather than the
   * `not-offered` this file defaults them to — which asserts the device does
   * not have the control, and would be a page telling an operator their
   * camera is short of ten controls it has. `video/controls.ts`'s
   * `CONTROL_NAMES` does not write them yet, so they are readable and not
   * yet settable.
   *
   * **Ordered as the camera reports them, not alphabetically**, so a diff
   * against a `v4l2-ctl` dump reads by eye — skipping the eight names above
   * that already had a field, rather than moving those eight to interleave
   * exactly and touching every place their old position was relied on.
   */
  readonly saturation: Capability<ControlRange>;
  readonly hue: Capability<ControlRange>;
  /** `white_balance_automatic` — gates `whiteBalance` (R-UI-21). */
  readonly autoWhiteBalance: Capability<ControlRange>;
  readonly gamma: Capability<ControlRange>;
  readonly gain: Capability<ControlRange>;
  readonly powerLineFrequency: Capability<ControlRange>;
  readonly sharpness: Capability<ControlRange>;
  readonly backlightCompensation: Capability<ControlRange>;
  /** `auto_exposure` — gates `exposure` (R-UI-21). */
  readonly autoExposure: Capability<ControlRange>;
  /** `focus_automatic_continuous` — gates `focus` (R-UI-21). */
  readonly autoFocus: Capability<ControlRange>;
}

/**
 * Written down rather than derived, so that adding a capability fails a test
 * instead of quietly not appearing on the page it was added for.
 */
export const CAPABILITY_KEYS = [
  "formats", "zoom", "focus", "exposure", "whiteBalance",
  "brightness", "contrast", "rotation", "aim", "recording", "stills",
  "saturation", "hue", "autoWhiteBalance", "gamma", "gain", "powerLineFrequency",
  "sharpness", "backlightCompensation", "autoExposure", "autoFocus",
] as const satisfies readonly (keyof CameraCapabilities)[];

/** A camera with nothing answered. The base every probe builds on. */
export function noCapabilities(): CameraCapabilities {
  return {
    formats: notOffered(), zoom: notOffered(), focus: notOffered(),
    exposure: notOffered(), whiteBalance: notOffered(), brightness: notOffered(),
    contrast: notOffered(), rotation: notOffered(), aim: notOffered(), recording: notOffered(),
    stills: notOffered(),
    // A camera that has not been probed has not offered any of these ten
    // either — the same fact the eleven above already state, not a second
    // default for a device Yonder has not asked.
    saturation: notOffered(), hue: notOffered(), autoWhiteBalance: notOffered(),
    gamma: notOffered(), gain: notOffered(), powerLineFrequency: notOffered(),
    sharpness: notOffered(), backlightCompensation: notOffered(),
    autoExposure: notOffered(), autoFocus: notOffered(),
  };
}

/**
 * One line per camera for the Cameras index page (spec section 5).
 *
 * `aim: none · zoom: none` explains why that camera's page has no Aim group
 * before anyone goes looking for one — which is R-UI-20 applied a level up
 * from the page it governs.
 *
 * The `.map` callback is annotated `: string` and switches on `cap.state`,
 * every case returning, no `default:` — the same shape `absentFact` in
 * `present.ts` uses, for the same reason: a fifth `Capability` state must
 * fail to compile here, not silently print `yes` for a state nobody has
 * decided how to summarise. **The `: string` annotation is load-bearing,
 * not decoration** — remove it and TypeScript infers `string | undefined`
 * for this callback, which accepts a missing case without complaint and
 * takes the whole guarantee with it; confirmed by trying it before relying
 * on it.
 */
export function summarise(caps: CameraCapabilities): string {
  return CAPABILITY_KEYS.map((key): string => {
    const cap = caps[key] as Capability<unknown>;
    switch (cap.state) {
      case "not-offered":
        return `${key}: none`;
      case "advertised":
        return `${key}: unanswered`;
      case "gated":
        // Neutral, not a fault (R-UI-21) — named in the operator's own
        // words, never the V4L2 control name that has charge of it.
        return `${key}: ${cap.by.label} has it`;
      case "present":
        return key === "formats"
          ? `${key}: ${(cap.value as readonly unknown[]).length}`
          : `${key}: yes`;
    }
  }).join(" · ");
}
