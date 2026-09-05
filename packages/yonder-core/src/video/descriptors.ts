// SPDX-License-Identifier: GPL-3.0-or-later
import type { CameraCapabilities, ControlRange } from "./capability.js";

/**
 * The adapter boundary: the one place that knows a control's operator-facing
 * label, its display unit, how to convert between what the device stores and
 * what a person reads, and which control gates it (R-CTL-10, R-CTL-11).
 *
 * **Config stores what the device stores, in the device's own units; display
 * conversion happens here and nowhere else.** V4L2's absolute exposure is 100
 * µs per raw unit (the kernel control reference, cited below) — the bench
 * camera's `exposure_time_absolute` answers 156, and an operator reads 15600
 * µs. If that factor were written once at the page and once at the config
 * schema it would eventually disagree with itself, and an operator would set
 * a shutter speed and get a different one back. `config.yaml` and
 * `CameraControls` (R-CFG's device-native rule) keep the device's own number;
 * every value a page shows goes through `toDisplay` first, and every value a
 * write sends goes through `toRaw` first. Nothing downstream — a page, a
 * picker, the config schema — is allowed to know the factor itself.
 *
 * **Gating is device knowledge, not a universal UI rule, for the same
 * reason.** The bench camera's shutter is live only when `auto_exposure`
 * holds Manual Mode (menu id 1); under Aperture Priority Mode (id 3) the same
 * read still answers a real range, but carries `flags=inactive`
 * (`probe/fixtures/list-ctrls-menus-globalshutter.txt`). A different camera
 * gates the same kind of control under a different set of modes — the DJI
 * Pocket 2 leaves shutter live under Manual *or* Shutter priority — so "only
 * Manual permits a manual control" cannot be a rule the console carries once
 * for every device; it has to be a fact stated once per device, beside the
 * unit conversion rather than scattered through the console. **Every
 * `openWhen` below is the bench ELP's rule** — read straight off the fixture
 * cited above, the only device this task has hard numbers for. A second
 * device modelled through this same `CameraCapabilities` shape gets its own
 * rule written the same way, not a branch threaded into this one's.
 *
 * **Every capability has an entry, including four that are not a numeric
 * V4L2 control.** `DESCRIPTORS` is typed `Record<keyof CameraCapabilities,
 * ControlDescriptor>`, so the compiler refuses to compile this file with one
 * missing — the same reasoning `CAPABILITY_KEYS` in `capability.ts` was
 * written out for, applied to a second table. `formats`, `aim`, `recording`
 * and `stills` are not `ControlRange`s and have no raw/display distinction to
 * convert; each gets the same inert, honest default a `ControlDescriptor` can
 * hold — no unit, the number passed through unchanged, nothing gating and
 * nothing gated. Nothing in this codebase calls `toDisplay`/`toRaw` for one of
 * these four today; the entry exists so that a capability added later is a
 * compile error here, at the one place someone has to decide what it means,
 * rather than a silently-missing row on a page.
 */
export interface ControlDescriptor {
  readonly key: keyof CameraCapabilities;
  readonly label: string;                       // "Shutter"
  readonly unit: string;                        // "µs", "K", "" — never uppercased downstream
  readonly toDisplay: (raw: number) => number;
  readonly toRaw: (shown: number) => number;
  readonly gates?: readonly (keyof CameraCapabilities)[];
  /** Which of the gate's values leave this control live. Menu id or 0/1. */
  readonly openWhen?: (gateValue: number) => boolean;
}

/**
 * A control whose device and display units are the same number: no ratio has
 * been established, or none exists (R-CTL-14 on zoom — "no × ratio until the
 * device's scale is established" — is the rule this default states for every
 * other unlabelled control too, rather than guessing one the way an earlier
 * mockup guessed µs for a raw exposure count). `unit` is `""`, never a symbol
 * invented for a scale nobody has measured.
 */
function deviceNative(key: keyof CameraCapabilities, label: string): ControlDescriptor {
  return { key, label, unit: "", toDisplay: (raw) => raw, toRaw: (shown) => shown };
}

/**
 * One entry per `CameraCapabilities` key (R-CTL-10, R-CTL-11 … R-CTL-14).
 *
 * **A label-case note for whichever task next reads `autoExposure`,
 * `autoWhiteBalance` or `autoFocus`.** Their `label` is lowercase —
 * `"auto exposure"`, not `"Auto exposure"` — because the call site this task
 * was handed reads a gated control's `gates[0]`, looks up *that* key's
 * descriptor, and drops the result mid-sentence: `` `${label}: ${gateLabel}
 * has it` ``, exactly the shape `capability.ts`'s own `gated()` doc comment
 * and `summarise()` already use (`` `${key}: ${cap.by.label} has it` ``, and
 * `capability.test.ts`/`present.test.ts` both fix `by.label` at
 * `"auto exposure"`, lowercase, for the same reason). A menu-driven control
 * drawn on its own — the "Exposure `Aperture priority | Manual`" segmented
 * control itself, which the interactive blueprint heads `"Auto exposure"`,
 * title case — would read wrong taking this same string verbatim as its
 * heading. One field cannot be both a sentence-initial heading and a
 * mid-sentence name; this file resolves it towards the call site it was
 * actually asked to serve, and whichever task draws that segmented control's
 * own heading will need to capitalise it there (or hold a second string),
 * not read `label` and assume it is already title case.
 */
export const DESCRIPTORS: Record<keyof CameraCapabilities, ControlDescriptor> = {
  formats: deviceNative("formats", "Capture formats"),
  zoom: deviceNative("zoom", "Zoom"),
  focus: {
    ...deviceNative("focus", "Focus"),
    gates: ["autoFocus"],
    // `focus_automatic_continuous` default=1 in the fixture, and
    // `focus_absolute` carries `flags=inactive` at that same reading — live
    // only once the continuous auto-focus control is turned off (0).
    openWhen: (gateValue) => gateValue === 0,
  },
  exposure: {
    key: "exposure",
    label: "Shutter",
    unit: "µs",
    /**
     * 100 µs per raw unit, exactly, per the kernel control reference
     * (docs.kernel.org/userspace-api/media/v4l/ext-ctrls-camera.html):
     * raw 156 is 15600 µs. No `Math.round` anywhere in either direction —
     * multiplying and dividing by the same exact integer factor is exact
     * for every integer this control's documented range can hold (1..10000,
     * giving displayed values up to 1,000,000, nowhere near float64's
     * 2^53 exact-integer ceiling), so there is no imprecision here for
     * rounding to paper over. The exhaustive test below checks every one of
     * those raw values, not just the fixture's 156.
     */
    toDisplay: (raw) => raw * 100,
    toRaw: (shown) => shown / 100,
    gates: ["autoExposure"],
    // Manual Mode is menu id 1 on the ELP; `exposure_time_absolute` carries
    // `flags=inactive` while `auto_exposure` reads its other offered id, 3
    // (Aperture Priority Mode) — read straight off
    // `probe/fixtures/list-ctrls-menus-globalshutter.txt`.
    openWhen: (gateValue) => gateValue === 1,
  },
  whiteBalance: {
    ...deviceNative("whiteBalance", "Temperature"),
    // The device already stores kelvin (`white_balance_temperature` min=2800
    // max=6500 default=4600 in the fixture) — a real physical unit with
    // nothing to convert, unlike exposure's raw hundredths-of-a-microsecond
    // count.
    unit: "K",
    gates: ["autoWhiteBalance"],
    // `white_balance_automatic` default=1 in the fixture, and
    // `white_balance_temperature` carries `flags=inactive` at that same
    // reading — live only once auto white balance is turned off (0).
    openWhen: (gateValue) => gateValue === 0,
  },
  brightness: deviceNative("brightness", "Brightness"),
  contrast: deviceNative("contrast", "Contrast"),
  rotation: deviceNative("rotation", "Rotation"),
  aim: deviceNative("aim", "Aim"),
  recording: deviceNative("recording", "Recording"),
  stills: deviceNative("stills", "Stills"),
  saturation: deviceNative("saturation", "Saturation"),
  hue: deviceNative("hue", "Hue"),
  autoWhiteBalance: deviceNative("autoWhiteBalance", "auto white balance"),
  gamma: deviceNative("gamma", "Gamma"),
  gain: deviceNative("gain", "Gain"),
  powerLineFrequency: deviceNative("powerLineFrequency", "Mains frequency"),
  sharpness: deviceNative("sharpness", "Sharpness"),
  backlightCompensation: deviceNative("backlightCompensation", "Backlight compensation"),
  autoExposure: deviceNative("autoExposure", "auto exposure"),
  autoFocus: deviceNative("autoFocus", "auto focus"),
};

/** What a page actually draws for one control: display units throughout. */
export interface DescriptorView {
  readonly label: string;
  readonly unit: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly current: number;
  readonly default: number;
}

/**
 * A device's own `ControlRange` for `key`, converted once at the boundary
 * (R-CTL-10, R-CTL-11).
 *
 * Every field goes through the same `toDisplay`, including `step` — correct
 * because every conversion in `DESCRIPTORS` is a plain multiply (or the
 * identity), never an offset, so scaling the step size by the same factor as
 * any other value *is* the displayed step size. A future descriptor that
 * needed an offset (`shown = raw * m + b`) would have to convert `step` as
 * `range.step * m` rather than `toDisplay(range.step)`, which would double-
 * count `b`; nothing here needs that yet, and the exhaustive round-trip test
 * would need a partner the day it does.
 */
export function describe(key: keyof CameraCapabilities, range: ControlRange): DescriptorView {
  const d = DESCRIPTORS[key];
  return {
    label: d.label,
    unit: d.unit,
    min: d.toDisplay(range.min),
    max: d.toDisplay(range.max),
    step: d.toDisplay(range.step),
    current: d.toDisplay(range.current),
    default: d.toDisplay(range.default),
  };
}
