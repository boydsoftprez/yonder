// SPDX-License-Identifier: GPL-3.0-or-later
import { systemRunner, type CommandRunner } from "../net/runner.js";
import type { CameraCapabilities, ControlRange } from "./capability.js";
import type { Camera } from "../schema/config.js";

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
 */

/**
 * The V4L2 control names these three settings map to. One place.
 *
 * **Must agree with `probe/camera.ts`'s `CONTROL_MAP`.** That file maps the
 * same V4L2 names onto the same capability keys in the other direction —
 * device to capability, rather than capability to device — and the two are
 * maintained by hand rather than one deriving the other. `controls.test.ts`
 * cross-checks them, because a control probed under one name and applied
 * under another would not fail loudly: it would just be a control whose
 * value never moves, which is the exact fault this whole task exists to
 * remove.
 *
 * `satisfies Record<keyof Camera["controls"], string>` ties the *keys* here
 * to the schema's own `CameraControls` fields at compile time, so a fourth
 * image control added to the schema and forgotten here is a type error
 * rather than a control nobody can move.
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
} as const satisfies Record<keyof Camera["controls"], string>;

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

  for (const control of Object.keys(opts.controls) as (keyof typeof CONTROL_NAMES)[]) {
    const requested = opts.controls[control];
    // `null` is the schema's own "leave it" for brightness and contrast;
    // `undefined` is a key `Partial` allows to be simply absent. Neither is a
    // request to do anything, so neither is worth a round trip to refuse.
    if (requested === null || requested === undefined) continue;

    const capability = opts.capabilities[control];
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

    // Rule 1: clamp to what this device reported, never to the schema's
    // bound, and say so when it changes the number.
    const { sent, wasClamped } = clampToRange(requested, capability.value);
    if (wasClamped) clamped.push({ control, requested, sent });

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
  }

  return { applied, refused, clamped };
}
