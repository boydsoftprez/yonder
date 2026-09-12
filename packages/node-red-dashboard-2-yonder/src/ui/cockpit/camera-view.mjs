// The camera's two presentations in the flight display (R-FLT-29, K-68):
// full-scene, or a movable, resizable window over synthetic terrain. Pure
// geometry and validation only — nothing here starts, stops or reaches a
// stream, and nothing here touches the aircraft (R-CMD-04).
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * The window's home position and default width, as fractions of
 * the PFD camera scene — the measured geometry of the approved render
 * `instrument-library/flight.camera.window.night.png`, clear of the
 * airspeed tape and the forecast notice at laptop size (design decision 6).
 *
 * No `h`: the window's height is never stored. It is always derived from
 * `w` and the picture's own aspect ratio — CSS `aspect-ratio` on
 * `CameraWindow.vue`'s picture body — plus the fixed window header. The
 * scene presentation
 * (`YonderPicture.vue`'s `scene` prop) leaves height to the box rather than
 * to a stored number.
 */
export const cameraWindowHome = Object.freeze({ x: 0.13, y: 0.12, w: 0.17 })

/** Width bounds, as fractions of the PFD camera scene's width (design decision
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
 * window inside the box from `w` alone. `CameraWindow.vue` computes it from
 * a `getBoundingClientRect()` of its own containing box and its own
 * `aspect` prop; kept out of this function so every case here is a plain
 * number in, plain object out, with no DOM anywhere in the tested path.
 *
 * **With no `aspect` this function does not invent one** (I4 of the
 * whole-branch review): the load-time validator runs before anything has
 * rendered, and a guessed ratio of `1` is wrong in both directions. On a
 * portrait box the real combined ratio is about a half, so guessing `1`
 * bounded `y` at `1 - w` and put the lower quarter of the scene out of
 * reach; on a box wider than the picture's shape it guessed low and let a
 * stored `y` leave the window's bottom outside the scene. So without an
 * aspect only the horizontal extent is bounded and `y` is merely held in
 * `[0, 1]`. A positive width narrower than the normal minimum is preserved:
 * it may be the safe result of a portrait source's earlier measured clamp,
 * and re-expanding it before the next measurement would put pixels back
 * outside the scene. `CameraWindow.vue` re-clamps against the box it actually
 * measures, on mount and whenever that box is resized. That also makes this
 * function idempotent on geometry a gesture already clamped — the value
 * `YonderCockpit`'s `setOption` hands straight back through here — instead
 * of shrinking it a second time against a ratio nobody measured.
 */
export function clampCameraWindow (input, aspect, header = 0) {
  if (!input || typeof input !== 'object' ||
    !Number.isFinite(input.x) || !Number.isFinite(input.y) || !Number.isFinite(input.w)) {
    return { ...cameraWindowHome }
  }
  const measured = Number.isFinite(aspect) && aspect > 0
  const headerFraction = Number.isFinite(header) && header >= 0 ? header : 0
  // A portrait source can be taller than the PFD at the normal minimum
  // width. Containment wins in that exceptional case: shrink below the
  // normal minimum rather than leave any part of the picture or header off
  // scene. For usual sources this is simply MAX_WIDTH.
  const heightLimitedWidth = measured ? Math.max(0, (1 - headerFraction) / aspect) : MAX_WIDTH
  const maxWidth = Math.min(MAX_WIDTH, heightLimitedWidth)
  const minWidth = measured || input.w <= 0 ? MIN_WIDTH : 0
  const w = Math.min(maxWidth, Math.max(minWidth, input.w))
  const h = measured ? w * aspect + headerFraction : 0
  const x = Math.max(0, Math.min(input.x, Math.max(0, 1 - w)))
  const y = Math.max(0, Math.min(input.y, Math.max(0, 1 - h)))
  return { x, y, w }
}

/**
 * The PFD's background choice, validated for anything a browser's
 * `localStorage` might hand back. Three values, exactly the ones the
 * Display panel's own Background chooser offers; anything else — absence,
 * an older or newer value, junk from a hand-edited store — is synthetic
 * terrain, which is what the Flight page has always defaulted to and what
 * keeps the default capture showing nothing new.
 */
export function cockpitBackgroundSettings (input) {
  return ['camera', 'camera-overlay'].includes(input) ? input : 'terrain'
}

/**
 * `full` or `window` (design decision 7), **derived from the background
 * choice and never stored beside it** (C2 of the whole-branch review). The
 * design's own Behaviour section makes these one state, not two: "choosing
 * Camera there is the same as going to `full`, and choosing Synthetic
 * terrain there with a camera selected is the same as going to `window`",
 * and "There is no third state with a camera selected and no picture
 * anywhere". Two independent values could reach that third state — and did,
 * as the default, because the stored background was `terrain` while the
 * stored view said `full`: terrain in the scene, no window, no picture, and
 * a control reading "Full · tap for window" over a scene with no camera in
 * it. One value cannot.
 *
 * Whether a window actually appears is a separate question this does not
 * answer: it also needs a camera to be configured (`cameraPath`), which is
 * the design's third row — no camera selected, nothing shown, the control
 * disabled and reading *unavailable*.
 */
export function cameraViewFor (background) {
  return background === 'terrain' ? 'window' : 'full'
}
