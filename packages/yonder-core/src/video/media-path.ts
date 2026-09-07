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

/**
 * Where a capture's bytes arrive for a browser (R-CAM-18, R-SEC-13).
 *
 * The captures panel draws a thumbnail, a View and a Download, and all three
 * are the same file: a URL the browser can fetch. The daemon serves it on a
 * Unix socket no browser can reach, so the console proxies it — see
 * `console/capture.ts` — and this is the one place the shape of that address
 * is written down.
 *
 * **Here rather than in the component that draws the link**, for this file's
 * own reason: `console/middleware.ts` matches the path and `YonderCaptures.vue`
 * builds it, and a second, hand-written template string in either one is the
 * copy that drifts the day the prefix changes — silently, because a stale
 * copy still returns a 404 rather than an error anybody reads.
 *
 * Under `/video`, deliberately: that prefix is already the console's own
 * media family (`whep.ts`'s `WHEP_PREFIX`), it is already behind the session
 * check, and a capture is the same camera's picture one moment later. Both
 * segments are encoded — the name reaches a file path at the far end, and the
 * daemon matches it against `SAFE_CAPTURE_NAME` after decoding it, which is a
 * guard that only works on something that was encoded on the way in.
 */
export function captureUrl(camera: string, name: string): string {
  return `/video/${encodeURIComponent(camera)}/captures/${encodeURIComponent(name)}`;
}
