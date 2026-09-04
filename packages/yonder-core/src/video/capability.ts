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
 * **Three states, and the middle one is the reason this is a union rather
 * than an optional.**
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
 *   1280x720.
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
  | { readonly state: "advertised"; readonly reason: string };

export function present<T>(value: T): Capability<T> {
  return { state: "present", value };
}
export function notOffered<T>(): Capability<T> {
  return { state: "not-offered" };
}
/** `reason` is shown on the inoperative control, so write it for an operator. */
export function advertised<T>(reason: string): Capability<T> {
  return { state: "advertised", reason };
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
}

/**
 * Written down rather than derived, so that adding a capability fails a test
 * instead of quietly not appearing on the page it was added for.
 */
export const CAPABILITY_KEYS = [
  "formats", "zoom", "focus", "exposure", "whiteBalance",
  "brightness", "contrast", "rotation", "aim", "recording", "stills",
] as const satisfies readonly (keyof CameraCapabilities)[];

/** A camera with nothing answered. The base every probe builds on. */
export function noCapabilities(): CameraCapabilities {
  return {
    formats: notOffered(), zoom: notOffered(), focus: notOffered(),
    exposure: notOffered(), whiteBalance: notOffered(), brightness: notOffered(),
    contrast: notOffered(), rotation: notOffered(), aim: notOffered(), recording: notOffered(),
    stills: notOffered(),
  };
}

/**
 * One line per camera for the Cameras index page (spec section 5).
 *
 * `aim: none · zoom: none` explains why that camera's page has no Aim group
 * before anyone goes looking for one — which is R-UI-20 applied a level up
 * from the page it governs.
 */
export function summarise(caps: CameraCapabilities): string {
  return CAPABILITY_KEYS.map((key) => {
    const cap = caps[key] as Capability<unknown>;
    if (cap.state === "not-offered") return `${key}: none`;
    if (cap.state === "advertised") return `${key}: unanswered`;
    if (key === "formats") return `${key}: ${(cap.value as readonly unknown[]).length}`;
    return `${key}: yes`;
  }).join(" · ");
}
