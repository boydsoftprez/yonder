// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The camera a media path is about, stripped of the `-preview` suffix.
 *
 * `schema/config.ts` is the one place that suffix is appended — `<id>` for a
 * camera's full-rate stream, `<id>-preview` for its cheap copy — and this is
 * its exact inverse, with exactly one implementation for the same reason
 * `yonder-core/presentation`'s own doc comment gives for everything re-
 * exported through it: `YonderPicture.vue`'s own `streamPath` computed and
 * the console's viewer-report route (`console/middleware.ts`) both have to
 * answer "which camera is this path about", and a second, hand-rolled
 * `.slice(0, -8)` in either one is precisely the kind of copy that drifts the
 * day the suffix does — silently, because the two would still agree on every
 * camera whose id happens not to matter yet.
 *
 * A pure function of its argument, importing nothing — safe in a device
 * process and in a browser bundle without `yonder-core/presentation`'s own
 * boundary needing to think about it at all.
 */
export function cameraFor(streamPath: string): string {
  return streamPath.endsWith("-preview") ? streamPath.slice(0, -8) : streamPath;
}
