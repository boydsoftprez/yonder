// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../net/runner.js";
import type { Camera } from "../schema/config.js";
import type { CameraCapabilities, Capability, ControlRange } from "./capability.js";
import { DESCRIPTORS } from "./descriptors.js";
import { parseControls } from "./probe/parse.js";

/**
 * Image controls actually reach the camera (R-CTL-04, R-CTL-05).
 *
 * `config.yaml`'s `cameras[].controls` is stored the moment it is applied —
 * `apply/reachability.ts` exempts it from the confirmation window on the
 * grounds that it changes nothing about what leaves the aircraft — but
 * storing a number is not the same as the sensor holding it. This file is
 * the one place that runs `v4l2-ctl --set-ctrl` against a capture device.
 *
 * **Live, not a respawn.** Spec §2 puts image controls in the first of three
 * kinds: they take effect on the running stream. `v4l2-ctl` talks to the
 * device node directly, while the pipeline holds that same node open, so a
 * change here never touches the supervisor or the argv `pipeline.ts` built —
 * doing either would make an image control a resolution change wearing a
 * different label.
 *
 * **Every rule here has a failure mode it exists to close:**
 *
 * 1. A value is clamped to what *this device* reported, never to the
 *    schema's bound — the schema allows brightness -100..100 because it must
 *    accept every camera, and a real one answers a narrower range. Sending
 *    the schema's edge to it is a command the device would reject or clamp
 *    on its own, silently, which is exactly the silent alteration this
 *    function exists to avoid causing a second time.
 * 2. A control the device did not offer is refused before anything is run —
 *    `capabilities` already carries that answer, so asking `v4l2-ctl` and
 *    interpreting its refusal would be re-deriving a fact this file was
 *    handed for free, one command slower and one wording less clear.
 * 3. Nothing throws. `CommandRunner` never rejects (`net/runner.ts`); a
 *    non-zero exit is data, not an exception, for the same reason `probe/`
 *    treats one that way — a caller rendering a page cannot render a throw.
 * 4. Every applied value is read back after the write, never assumed to be
 *    what was sent (R-CTL-10). `--get-ctrl` runs in the same invocation as
 *    `--set-ctrl`, so the reading reflects this write and not a stale one a
 *    concurrent request left behind.
 * 5. A `gated` control is refused too (R-UI-21) — real and working, but not
 *    this operator's to move right now. Named in the operator's own words:
 *    `capability.by.label` is already `sentenceLabel()`'s lowercase form
 *    (Task 7), so this file only relays it, never the V4L2 name the gate is
 *    stored under and never the heading form.
 * 6. A `(menu)` control's ids are a subset of its own min..max, never the
 *    whole range — the bench camera's `auto_exposure` answers 0..3 but
 *    lists only 1 and 3 as selectable (R-CTL-11 … R-CTL-14). A requested id
 *    inside range but off that list is refused by name, checked against the
 *    raw request before any clamping — clamping would otherwise move an
 *    invalid id onto whichever valid one happens to be nearest, silently
 *    substituting a mode the operator did not choose.
 * 7. A boolean control goes on the wire as `1` or `0`. V4L2 takes an
 *    integer; the config schema's own `false` reaching the device as the
 *    four-character string `"false"` is a command it would refuse, and the
 *    console would show a control that will not take.
 * 8. Writing a control that gates another one changes what that other
 *    control can do *at that instant* — the bench camera's shutter goes live
 *    the moment `auto_exposure` is set to Manual — and nothing has told the
 *    console. So every capability key a just-written control gates
 *    (`descriptors.ts`'s own `gates` arrays, read once at load rather than
 *    kept a third time by hand) is re-read in one further call and named in
 *    `reprobed`, so a page can stop drawing an inoperative control without a
 *    reload.
 */

/**
 * The V4L2 control name every schema control maps to. One place.
 *
 * **Must agree with `probe/camera.ts`'s `CONTROL_MAP`.** That file maps the
 * same V4L2 names onto the same capability keys in the other direction —
 * device to capability, rather than capability to device — and the two are
 * maintained by hand rather than one deriving the other. `controls.test.ts`
 * cross-checks them **in both directions**: forward, that every entry here
 * names the same V4L2 control the probe reads for the same capability, so a
 * control is never probed under one name and set under another; backward,
 * that every control the probe reads has an entry here, so a control an
 * operator can see on the page always has a field that can change it. The
 * second direction only became meaningful once Task 8 gave the schema a
 * field for every control the probe already read — before that, a probed
 * control with nowhere to be written was the plan of record, not a bug.
 *
 * **Two keys are not spelled like their own capability key.** `exposureTime`
 * reads and writes the `exposure` capability, and `whiteBalanceTemperature`
 * reads and writes `whiteBalance` — `schema/config.ts`'s own header comment
 * explains why: a config field says what it stores (a raw exposure count, a
 * raw kelvin reading), which is not the same word as the capability's own
 * name. `CAPABILITY_KEY_OVERRIDE` below is the one place that exception is
 * written down; every other key here is spelled exactly as its capability.
 *
 * `satisfies Record<keyof Camera["controls"], string>` ties the *keys* here
 * to the schema's own `CameraControls` fields at compile time, so a control
 * added to the schema and forgotten here is a type error rather than a
 * control nobody can move — `TS1360` is how Task 8 handed this file
 * fourteen more fields than it knew what to do with.
 */
export const CONTROL_NAMES = {
  brightness: "brightness",
  contrast: "contrast",
  /**
   * Rotation is not a V4L2 given. `rotate` is a standard control — degrees,
   * usually in steps of 90 — but many UVC cameras do not implement it.
   * `probe/camera.ts` probes for it exactly like brightness and contrast; a
   * camera that does not answer it reports `not-offered` here, and this
   * file refuses a request for it with that reason rather than falling back
   * to rotating the frame in the pipeline. That fallback would be a stream
   * control wearing an image control's badge — indistinguishable on the page
   * from the sensor actually doing it, which is the one distinction spec §2
   * exists to keep visible.
   */
  rotation: "rotate",
  // Fourteen more, ordered as `probe/camera.ts`'s `CONTROL_MAP` reads them
  // off the device and `schema/config.ts`'s `CameraControls` declares them,
  // rather than alphabetically, so a diff against either reads by eye
  // (R-CTL-11 … R-CTL-14).
  zoom: "zoom_absolute",
  focus: "focus_absolute",
  exposureTime: "exposure_time_absolute",
  whiteBalanceTemperature: "white_balance_temperature",
  gain: "gain",
  backlightCompensation: "backlight_compensation",
  gamma: "gamma",
  sharpness: "sharpness",
  saturation: "saturation",
  hue: "hue",
  powerLineFrequency: "power_line_frequency",
  autoExposure: "auto_exposure",
  autoWhiteBalance: "white_balance_automatic",
  autoFocus: "focus_automatic_continuous",
  // R-CTL-05. Switches, so rule 7 above carries them: `true` reaches the
  // device as `1`, never as the four-character string a boolean stringifies
  // to. Kept apart from `rotation` above rather than folded into it — a flip
  // is not a rotation, and `rotate=180` is not a request to mirror anything.
  horizontalFlip: "horizontal_flip",
  verticalFlip: "vertical_flip",
} as const satisfies Record<keyof Camera["controls"], string>;

/**
 * The two config keys whose name differs from the capability key that
 * answers them (see `CONTROL_NAMES`'s own comment above) — `schema/
 * config.ts`'s naming choice, not a fact about V4L2. Exported so
 * `controls.test.ts`'s cross-check translates a config key to its capability
 * exactly the way this file does, rather than keeping a second copy of the
 * same two names that could quietly drift from this one.
 */
export const CAPABILITY_KEY_OVERRIDE: Readonly<Record<string, string>> = {
  exposureTime: "exposure",
  whiteBalanceTemperature: "whiteBalance",
};

/** A config control's name, translated to the capability key that answers it. */
export function capabilityKeyFor(control: string): string {
  return CAPABILITY_KEY_OVERRIDE[control] ?? control;
}

/**
 * capability key -> the capability keys *it* gates, read once off
 * `descriptors.ts`'s own `gates` arrays rather than kept a third time by
 * hand (rule 8 above) — that file is already the one place gating is
 * declared (R-UI-21), and a second hand-kept list here is exactly the kind
 * of silent drift `CONTROL_NAMES`'s own cross-check exists to catch
 * elsewhere in this file.
 */
const GATED_BY = new Map<string, string[]>();
for (const key of Object.keys(DESCRIPTORS) as (keyof CameraCapabilities)[]) {
  for (const gate of DESCRIPTORS[key].gates ?? []) {
    const gated = GATED_BY.get(gate) ?? [];
    gated.push(key);
    GATED_BY.set(gate, gated);
  }
}

/** capability key -> the V4L2 name that reads and writes it, from `CONTROL_NAMES` itself. */
const V4L2_NAME_BY_CAPABILITY = new Map<string, string>();
for (const control of Object.keys(CONTROL_NAMES) as (keyof typeof CONTROL_NAMES)[]) {
  V4L2_NAME_BY_CAPABILITY.set(capabilityKeyFor(control), CONTROL_NAMES[control]);
}

export interface ApplyControlsOptions {
  /** The resolved `/dev/videoN` capture node — never a by-path name. */
  node: string;
  /** The controls to change. A key absent, or `null`, means "leave it". */
  controls: Partial<Camera["controls"]>;
  /** What the device actually reported, from the same probe the page reads (R-CAM-14). */
  capabilities: CameraCapabilities;
  runner?: CommandRunner;
}

export interface RefusedControl {
  readonly control: string;
  /** An operator can act on this; it never carries an assumption of its own — see rules 2 and 3 above. */
  readonly reason: string;
}

/**
 * A control that was applied, but not at the value asked for.
 *
 * Kept apart from `refused` because it is not a failure — the value took
 * effect — and apart from a message buried in `applied` because `applied`
 * holds the device's own read-back (rule 4) and has no room to also say
 * *why* it differs from what was requested. Rule 1 asks for exactly this to
 * be said rather than left for a caller to notice by comparing numbers.
 */
export interface ClampedControl {
  readonly control: string;
  readonly requested: number;
  /** What was sent instead, after clamping to `capabilities[control]`'s own range. */
  readonly sent: number;
}

export interface ApplyControlsResult {
  /**
   * One entry per control that was written, keyed by the same names
   * `controls` used. The value is what the device reported *after* the
   * write (R-CTL-10) — never the requested number and never the clamped
   * number this function sent, even though both usually agree with it.
   */
  readonly applied: Record<string, number>;
  readonly refused: readonly RefusedControl[];
  readonly clamped: readonly ClampedControl[];
  /**
   * Capability keys re-read because a control just written gates them
   * (rule 8 above) — never the control that was written itself, and never
   * every gate-eligible key on the camera, only the ones this write actually
   * touched. Empty when nothing written this call gates anything, which is
   * the ordinary case for most controls.
   */
  readonly reprobed: readonly string[];
}

/** `v4l2-ctl --get-ctrl=<name>` prints exactly one line: `<name>: <value>`. */
function parseGetCtrl(stdout: string, name: string): number | null {
  const m = new RegExp(`^${name}:\\s*(-?\\d+)`, "m").exec(stdout);
  return m ? Number(m[1]) : null;
}

/** Clamp `value` into `range`, reporting whether that changed anything. */
function clampToRange(
  value: number,
  range: ControlRange,
): { sent: number; wasClamped: boolean } {
  const sent = Math.min(Math.max(value, range.min), range.max);
  return { sent, wasClamped: sent !== value };
}

/**
 * Applies the requested image controls to one camera's device node, and
 * reads each one back. Never throws — see rule 3 above.
 */
export async function applyControls(opts: ApplyControlsOptions): Promise<ApplyControlsResult> {
  const runner = opts.runner ?? systemRunner;
  const applied: Record<string, number> = {};
  const refused: RefusedControl[] = [];
  const clamped: ClampedControl[] = [];
  // Capability keys actually written this call — the seed for the re-probe
  // below (rule 8). Tracked as they succeed, not derived from `opts.controls`
  // afterwards, so a control that was refused never causes its own gates to
  // be re-read: nothing on the device changed for it.
  const gatesWritten = new Set<string>();

  for (const control of Object.keys(opts.controls) as (keyof typeof CONTROL_NAMES)[]) {
    const requested = opts.controls[control];
    // `null` is the schema's own "leave it" for every nullable control;
    // `undefined` is a key `Partial` allows to be simply absent. Neither is a
    // request to do anything, so neither is worth a round trip to refuse.
    if (requested === null || requested === undefined) continue;

    // Rule 7: `autoWhiteBalance` and `autoFocus` are booleans in the schema
    // (R-CTL-11 … R-CTL-14); V4L2 takes an integer, so a switch travels the
    // rest of this function as the same `1`/`0` any other control's number
    // would be.
    const requestedNumber = typeof requested === "boolean" ? (requested ? 1 : 0) : requested;

    // `capabilityKeyFor` is the identity for seventeen of these nineteen
    // keys, and only ever returns one of the keys `CameraCapabilities`
    // types as `Capability<ControlRange>` — `formats`, `aim`, `recording`
    // and `stills` have no schema control and never reach this function,
    // which is what makes this cast safe rather than merely convenient.
    const capabilityKey = capabilityKeyFor(control) as keyof CameraCapabilities;
    const capability = opts.capabilities[capabilityKey] as Capability<ControlRange>;

    // Rule 2: the capability model already knows whether this device offers
    // the control. `not-offered` and `advertised` both mean "do not run
    // v4l2-ctl to find out" — the second carries its own reason, recorded by
    // whatever probed it, and reusing it here keeps one vocabulary for one
    // fault rather than inventing a second sentence for the same thing.
    if (capability.state === "not-offered") {
      refused.push({ control, reason: `this camera does not offer ${control}` });
      continue;
    }
    if (capability.state === "advertised") {
      refused.push({ control, reason: capability.reason });
      continue;
    }
    // Rule 5: real and working, and not this operator's to move right now —
    // named the way an operator reads it, never the V4L2 name and never the
    // heading form (R-UI-21).
    if (capability.state === "gated") {
      refused.push({ control, reason: `${capability.by.label} has this control right now` });
      continue;
    }

    // Rule 6: a menu control's ids are a subset of its own min..max, and a
    // requested id inside that range can still be one the device never
    // listed. Checked against the raw request, before clamping, so an
    // invalid id is refused rather than silently moved onto whichever valid
    // one happens to be nearest.
    if (capability.value.menu && !capability.value.menu.some((entry) => entry.id === requestedNumber)) {
      refused.push({
        control,
        reason: `${requestedNumber} is not one of the values this camera lists for ${control}`,
      });
      continue;
    }

    // Rule 1: clamp to what this device reported, never to the schema's
    // bound, and say so when it changes the number.
    const { sent, wasClamped } = clampToRange(requestedNumber, capability.value);
    if (wasClamped) clamped.push({ control, requested: requestedNumber, sent });

    const v4l2Name = CONTROL_NAMES[control];
    // Set and read in the same invocation, so the reading is of this write
    // and not of whatever a concurrent request left behind a moment later.
    const result = await runner([
      "v4l2-ctl", "-d", opts.node,
      `--set-ctrl=${v4l2Name}=${sent}`,
      `--get-ctrl=${v4l2Name}`,
    ]);
    if (result.code !== 0) {
      refused.push({
        control,
        reason: `v4l2-ctl refused ${v4l2Name}=${sent}: ${result.stderr.trim() || `exit ${result.code}`}`,
      });
      continue;
    }

    // Rule 4: the read-back is what gets kept, not `sent`. A device that
    // answers a write with something unparsable has not confirmed anything,
    // so that is a refusal too rather than a guess dressed as a reading.
    const readBack = parseGetCtrl(result.stdout, v4l2Name);
    if (readBack === null) {
      refused.push({
        control,
        reason: `the device accepted ${v4l2Name}=${sent} but did not report a value back`,
      });
      continue;
    }
    applied[control] = readBack;
    gatesWritten.add(capabilityKey);
  }

  const reprobed = await reprobeGatedControls(opts.node, runner, gatesWritten);

  return { applied, refused, clamped, reprobed };
}

/**
 * Rule 8. Every capability key gated by a control this call actually wrote,
 * re-read in one further `--list-ctrls-menus` call — the same command
 * `probe/camera.ts` uses to probe a camera in the first place, so a device
 * that cannot answer it here could not have been probed originally either.
 *
 * **Named, not returned in full.** What a caller does with a changed gate —
 * redraw it, ask for a fuller re-probe, ignore it — is a page's job, not
 * this file's; this only says which keys changed enough to be worth asking
 * about again, never the whole device and never the control that was
 * written itself.
 *
 * Nothing is re-read, and the device is never asked, when nothing written
 * this call gates anything — the ordinary case for most controls, and the
 * reason this is a second call rather than folded into the loop above: one
 * `--list-ctrls-menus` answers every gated key at once, however many gate
 * controls were written in the same request.
 */
async function reprobeGatedControls(
  node: string,
  runner: CommandRunner,
  gatesWritten: ReadonlySet<string>,
): Promise<string[]> {
  const candidates = new Set<string>();
  for (const gate of gatesWritten) {
    for (const key of GATED_BY.get(gate) ?? []) candidates.add(key);
  }
  if (candidates.size === 0) return [];

  const result = await runner(["v4l2-ctl", "-d", node, "--list-ctrls-menus"]);
  // Rule 3: a failed re-probe is not re-thrown — it is simply nothing
  // reprobed, exactly as a device that vanished mid-request answers no
  // capabilities rather than crashing the page that asks.
  if (result.code !== 0) return [];
  const ranges = parseControls(result.stdout);

  const reprobed: string[] = [];
  for (const key of candidates) {
    const v4l2Name = V4L2_NAME_BY_CAPABILITY.get(key);
    if (v4l2Name && ranges.has(v4l2Name)) reprobed.push(key);
  }
  return reprobed;
}
