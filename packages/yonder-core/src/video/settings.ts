// SPDX-License-Identifier: GPL-3.0-or-later
import type { Config } from "../schema/config.js";

/**
 * Turning "make it 25 fps" into a configuration (R-CTL-02, R-CTL-03).
 *
 * The same shape, and the same reason, as `setTheme` and `joinNetwork`: what
 * the apply engine takes is a whole configuration document, and the step that
 * turns one field from a browser into one is a decision that does not belong
 * in wiring. A `change` node merging a camera field into the configuration
 * would be editing the document that decides whether the device is reachable,
 * in JSONata, beside a wire coordinate — and the last time this project did
 * that with a cached configuration, the cache and the message were one object
 * and a revert left the cache lying (see `ui/theme.ts`).
 *
 * **`structuredClone`, always.** For the reason that file records: Node-RED's
 * change node stores and reads context by reference, and the rule that stops
 * an apply mutating what it read cannot be enforced by reviewing wire
 * coordinates.
 *
 * **Nothing here decides whether a change needs confirming.**
 * `apply/reachability.ts` does, from `CAMERA_EXEMPT_LEAVES`, and it does it to
 * the document this produces — so a page cannot promise a confirmation window
 * that never arms, or omit one that does, whatever this file is asked for.
 * That is the whole point of routing an edit back through the engine rather
 * than writing the file here.
 */

/**
 * The fields a camera's Setup deck can change, and the two kinds they fall
 * into.
 *
 * Written out rather than "anything in the schema", because the two kinds are
 * the thing an operator is being told about: `width`, `height` and
 * `framerate` are `CAMERA_EXEMPT_LEAVES`, so they restart the picture and are
 * kept without a countdown; `bitrate_kbps`, `enabled`, `autostart` and — since
 * this task — `preview_bitrate_kbps` change what leaves the aircraft, so they
 * arm the confirmation window. `preview` lost its exemption here too
 * (R-NET-07): a preview ceiling that can now reach 4000 kb/s is egress on the
 * same path the console is reached over, so a change to it is held exactly
 * like a change to the main bitrate is.
 *
 * `id`, `name`, `device` and `outputs` are deliberately absent. Each is a
 * different camera or a different consumer rather than a setting of this one,
 * and none of them is something to change from a slider on a page while an
 * aircraft is flying.
 */
export const CAMERA_SETTING_KEYS = [
  "width", "height", "framerate", "bitrate_kbps", "enabled", "autostart", "preview_bitrate_kbps",
] as const;

export type CameraSettingKey = (typeof CAMERA_SETTING_KEYS)[number];

export type CameraSettings = Partial<Record<CameraSettingKey, unknown>>;

export type SettingsResult =
  | { ok: true; config: Config }
  | { ok: false; error: string };

/** Whole numbers only. A framerate of 24.5 is a value no encoder is given. */
function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * The configuration this device should have with those settings on that
 * camera.
 *
 * The whole document, with the named fields set on the one camera and nothing
 * else touched. Bounds are **not** checked here: the schema owns them, the
 * engine runs the schema, and a second copy of `min(160).max(3840)` in this
 * file is a copy to keep in step for no benefit. What is checked is the shape
 * — a framerate that is a string, or a key nobody offers — because those
 * produce a Zod issue an operator cannot read.
 */
export function setCameraSettings(
  current: Config,
  id: string,
  request: CameraSettings | undefined,
): SettingsResult {
  const index = current.cameras.findIndex((c) => c.id === id);
  if (index === -1) return { ok: false, error: `no camera is configured with the id "${id}"` };

  const given = Object.entries(request ?? {}).filter(([, v]) => v !== undefined && v !== null);
  if (given.length === 0) {
    return { ok: false, error: `name at least one of: ${CAMERA_SETTING_KEYS.join(", ")}` };
  }
  for (const [key] of given) {
    if (!(CAMERA_SETTING_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `"${key}" is not a setting; name one of: ${CAMERA_SETTING_KEYS.join(", ")}` };
    }
  }

  const config = structuredClone(current);
  const camera = config.cameras[index];
  if (camera === undefined) return { ok: false, error: `no camera is configured with the id "${id}"` };

  for (const [key, value] of given) {
    if (key === "enabled" || key === "autostart") {
      if (typeof value !== "boolean") return { ok: false, error: `${key} must be true or false` };
      camera[key] = value;
      continue;
    }
    const n = whole(value);
    if (n === null) return { ok: false, error: `${key} must be a whole number` };
    if (key === "preview_bitrate_kbps") camera.preview.bitrate_kbps = n;
    else camera[key as "width" | "height" | "framerate" | "bitrate_kbps"] = n;
  }
  return { ok: true, config };
}
