// The camera's two presentations in the flight display (R-FLT-29, K-68):
// full-scene, or a movable, resizable window over synthetic terrain. Pure
// geometry and validation only — nothing here starts, stops or reaches a
// stream, and nothing here touches the aircraft (R-CMD-04).
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The window's home position and default width, as fractions of
 * `.cockpit-body` — the measured geometry of the approved render
 * `instrument-library/flight.camera.window.night.png`, clear of the
 * airspeed tape and the forecast notice at laptop size (design decision 6).
 *
 * No `h`: the window's height is never stored. It is always derived from
 * `w` and the picture's own aspect ratio — CSS `aspect-ratio` in
 * `CameraWindow.vue` — the same way the scene presentation
 * (`YonderPicture.vue`'s `scene` prop) leaves height to the box rather than
 * to a stored number.
 */
export const cameraWindowHome = Object.freeze({ x: 0.13, y: 0.12, w: 0.17 })

/** Width bounds, as fractions of `.cockpit-body`'s width (design decision
 * 6: "between one eighth and one half of the scene's width"). */
const MIN_WIDTH = 1 / 8
const MAX_WIDTH = 1 / 2

/**
 * Keeps a candidate window geometry inside the box and its width within
 * bounds, for anything a browser's `localStorage` might hand back — an
 * edited value, an older or newer shape, `null`. Returns `cameraWindowHome`
 * for anything that is not a plain `{x,y,w}` of finite numbers.
 *
 * `aspect` is the single combined ratio needed to bound the window
 * vertically without this function ever touching the DOM: how many
 * box-*height* fractions one box-*width* fraction of this window is tall,
 * given both the box's own pixel shape and the picture's own aspect ratio
 * — that is, `(boxWidthPx / boxHeightPx) / pictureAspectRatio`. `x`/`w` are
 * fractions of the box's width and `y` a fraction of its height (the same
 * split CSS `left`/`width` vs. `top` percentages use), so converting a
 * width extent into a height bound inherently needs the box's own pixel
 * aspect ratio folded in with the picture's — there is no way to keep the
 * window inside the box from `w` alone. `CameraWindow.vue` is the only
 * caller and computes this from a `getBoundingClientRect()` of its own
 * containing box and its own `aspect` prop; kept out of this function so
 * every case here is a plain number in, plain object out, with no DOM
 * anywhere in the tested path. A missing or non-positive `aspect` (the
 * validator at load time, before any box has ever been measured) falls
 * back to `1` — a harmless, roughly-typical approximation that the next
 * real drag or resize gesture immediately supersedes.
 */
export function clampCameraWindow (input, aspect) {
  if (!input || typeof input !== 'object' ||
    !Number.isFinite(input.x) || !Number.isFinite(input.y) || !Number.isFinite(input.w)) {
    return { ...cameraWindowHome }
  }
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, input.w))
  const h = w * ratio
  const x = Math.max(0, Math.min(input.x, Math.max(0, 1 - w)))
  const y = Math.max(0, Math.min(input.y, Math.max(0, 1 - h)))
  return { x, y, w }
}

/**
 * `full` or `window` (design decision 7) — `window` only for the literal
 * stored value `'window'`, `full` for anything else: absence, an older or
 * newer value, junk from a hand-edited `localStorage`. Defaulting to full
 * matters beyond the label: it is what keeps the Flight page's default
 * capture — no camera selected, background already `terrain` — showing
 * nothing new (see `YonderCockpit.vue`'s own background-slot gate).
 */
export function cameraViewSettings (input) {
  return input === 'window' ? 'window' : 'full'
}
