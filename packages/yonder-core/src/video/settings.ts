// SPDX-License-Identifier: GPL-3.0-or-later
import type { Camera, Config } from "../schema/config.js";

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

/**
 * Which schema leaf each setting key actually writes.
 *
 * **A setting key and the schema leaf it touches are two vocabularies, and
 * only one of the seven keys above has to say so out loud.** Six of the
 * seven happen to share their name with the `Camera` leaf they write —
 * `width` writes `width`, `enabled` writes `enabled` — which makes it easy to
 * assume that correspondence is automatic. `preview_bitrate_kbps` is the
 * exception: it is the Setup deck's name for a value that actually lives at
 * `preview.bitrate_kbps`, so the leaf it is load-bearing or exempt *as* is
 * `preview` — a name `CameraSettingKey` itself does not contain, and a plain
 * `CAMERA_EXEMPT_LEAVES.has(key)` string comparison can never match.
 *
 * That gap is exactly what let `settings.test.ts` drift: it once checked
 * exemption by that same direct string comparison, which meant
 * `preview_bitrate_kbps`'s classification never actually depended on whether
 * `"preview"` was in `CAMERA_EXEMPT_LEAVES` at all, and the test kept passing
 * regardless. Exporting the mapping, and routing both the writer below and
 * `settings.test.ts` through it, means there is one place this
 * correspondence is stated rather than two chances for it to disagree.
 */
export const SETTING_LEAF: Record<CameraSettingKey, keyof Camera> = {
  width: "width",
  height: "height",
  framerate: "framerate",
  bitrate_kbps: "bitrate_kbps",
  enabled: "enabled",
  autostart: "autostart",
  preview_bitrate_kbps: "preview",
};

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

  // Every write below goes by `leaf` — the schema field this key actually
  // touches, from `SETTING_LEAF` — rather than by `key` a second time, so the
  // one key whose name and leaf differ (`preview_bitrate_kbps` / `preview`)
  // cannot fall out of step with the mapping above.
  for (const [key, value] of given) {
    const leaf = SETTING_LEAF[key as CameraSettingKey];
    if (leaf === "enabled" || leaf === "autostart") {
      if (typeof value !== "boolean") return { ok: false, error: `${key} must be true or false` };
      camera[leaf] = value;
      continue;
    }
    const n = whole(value);
    if (n === null) return { ok: false, error: `${key} must be a whole number` };
    if (leaf === "preview") camera.preview.bitrate_kbps = n;
    else camera[leaf as "width" | "height" | "framerate" | "bitrate_kbps"] = n;
  }
  return { ok: true, config };
}
