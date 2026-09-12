// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-29/K-68: the camera window's pure geometry and state helpers
// (acceptance cases 1-3). No DOM anywhere here — see camera-view.mjs's own
// doc comment on why `aspect` is a plain number, not a measurement.
import { it, expect } from 'vitest'
import { cameraWindowHome, clampCameraWindow, cockpitBackgroundSettings, cameraViewFor } from './camera-view.mjs'
import { validatePfdPreferences } from './pfd-controls.mjs'

it('cameraWindowHome is the approved render\'s measured geometry, with no stored height', () => {
  expect(cameraWindowHome).toEqual({ x: 0.13, y: 0.12, w: 0.17 })
  expect('h' in cameraWindowHome).toBe(false)
})

it('clampCameraWindow keeps a valid candidate as-is when already inside the box', () => {
  expect(clampCameraWindow({ x: 0.2, y: 0.2, w: 0.2 }, 1)).toEqual({ x: 0.2, y: 0.2, w: 0.2 })
})

it('clampCameraWindow clamps the width to one eighth and one half of the box', () => {
  expect(clampCameraWindow({ x: 0, y: 0, w: 0.01 }, 1).w).toBe(0.125)
  expect(clampCameraWindow({ x: 0, y: 0, w: 0.9 }, 1).w).toBe(0.5)
})

it('clampCameraWindow keeps the whole window inside the box on every edge', () => {
  // Pushed past the right/bottom edges: x/y pull back so x+w<=1 and y+h<=1
  // (aspect 1, so height equals width in the same box-fraction units).
  const pushed = clampCameraWindow({ x: 0.99, y: 0.99, w: 0.3 }, 1)
  expect(pushed.x + pushed.w).toBeLessThanOrEqual(1)
  expect(pushed.y + pushed.w).toBeLessThanOrEqual(1)
  expect(pushed.x).toBeCloseTo(0.7)
  expect(pushed.y).toBeCloseTo(0.7)
  // Pushed past the left/top edges: never negative.
  const negative = clampCameraWindow({ x: -0.5, y: -0.5, w: 0.2 }, 1)
  expect(negative.x).toBe(0)
  expect(negative.y).toBe(0)
  // A taller-than-wide combined aspect still respects the vertical bound.
  const tall = clampCameraWindow({ x: 0, y: 0.9, w: 0.4 }, 2)
  expect(tall.y + tall.w * 2).toBeLessThanOrEqual(1)
})

it('clampCameraWindow returns home for null, non-numeric or malformed input', () => {
  for (const input of [null, undefined, {}, 'window', 42, { x: 0.2, y: 0.2 }, { x: 'a', y: 0.2, w: 0.2 }, { x: NaN, y: 0.2, w: 0.2 }, { x: 0.2, y: 0.2, w: Infinity }]) {
    expect(clampCameraWindow(input, 1)).toEqual(cameraWindowHome)
  }
})

it('clampCameraWindow bounds only the horizontal extent when it is given no measured aspect (I4)', () => {
  // No aspect means nothing has rendered yet, so there is no shape to
  // bound `y` against and this must not guess one. It still bounds `w`
  // and `x`, and still holds `y` in range.
  for (const aspect of [undefined, 0, -1, NaN]) {
    expect(clampCameraWindow({ x: 0.2, y: 0.2, w: 0.2 }, aspect)).toEqual({ x: 0.2, y: 0.2, w: 0.2 })
    // A portrait box's real combined ratio is about a half, so y = 0.8 is
    // legitimate there; guessing 1 used to cut it to 1 - w = 0.8... below.
    expect(clampCameraWindow({ x: 0.1, y: 0.88, w: 0.2 }, aspect).y).toBe(0.88)
    expect(clampCameraWindow({ x: 0.9, y: 0.5, w: 0.2 }, aspect).x).toBeCloseTo(0.8)
    expect(clampCameraWindow({ x: 0.1, y: -2, w: 0.2 }, aspect).y).toBe(0)
    expect(clampCameraWindow({ x: 0.1, y: 4, w: 0.2 }, aspect).y).toBe(1)
  }
})

it('clampCameraWindow applied twice with the same measured aspect changes nothing the second time (I4)', () => {
  // The host runs a gesture's already-clamped value back through
  // `validatePfdPreferences`; that round trip must not shrink it.
  const once = clampCameraWindow({ x: 0.6, y: 0.9, w: 0.4 }, 0.5)
  expect(clampCameraWindow(once, 0.5)).toEqual(once)
  expect(clampCameraWindow(once)).toEqual(once)
})

it('cockpitBackgroundSettings keeps the three offered values and treats everything else as terrain', () => {
  for (const input of ['camera', 'camera-overlay', 'terrain']) {
    expect(cockpitBackgroundSettings(input)).toBe(input)
  }
  for (const input of [undefined, null, '', 'Camera', 'window', 'full', 0, true, {}]) {
    expect(cockpitBackgroundSettings(input)).toBe('terrain')
  }
})

it('cameraViewFor makes the view a function of the background, with no third state (C2)', () => {
  expect(cameraViewFor('terrain')).toBe('window')
  expect(cameraViewFor('camera')).toBe('full')
  expect(cameraViewFor('camera-overlay')).toBe('full')
})

it('validatePfdPreferences round-trips the background and the window geometry, defaulting both', () => {
  const defaults = validatePfdPreferences()
  expect(defaults.display.background).toBe('terrain')
  expect(defaults.display.cameraWindow).toEqual(cameraWindowHome)
  expect('cameraView' in defaults.display).toBe(false) // one stored value, not two

  const stored = validatePfdPreferences({ display: { background: 'camera', cameraWindow: { x: 0.3, y: 0.3, w: 0.25 } } })
  expect(stored.display.background).toBe('camera')
  expect(stored.display.cameraWindow).toEqual({ x: 0.3, y: 0.3, w: 0.25 })
  expect(validatePfdPreferences({ display: { background: 'camera-overlay' } }).display.background).toBe('camera-overlay')
})

it('validatePfdPreferences clamps a stored geometry and replaces an impossible one with home', () => {
  const clamped = validatePfdPreferences({ display: { cameraWindow: { x: 0.99, y: 0.99, w: 5 } } })
  expect(clamped.display.cameraWindow.w).toBe(0.5)
  expect(clamped.display.cameraWindow.x).toBeLessThanOrEqual(0.5)

  for (const cameraWindow of [null, 'nonsense', 42, { x: 0.2 }, { x: 'a', y: 0.2, w: 0.2 }]) {
    expect(validatePfdPreferences({ display: { cameraWindow } }).display.cameraWindow).toEqual(cameraWindowHome)
  }

  expect(validatePfdPreferences({ display: { background: 'nonsense' } }).display.background).toBe('terrain')
  expect(validatePfdPreferences({ display: { background: 42 } }).display.background).toBe('terrain')
})
