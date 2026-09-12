// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-29/K-68: the camera window's pure geometry and state helpers
// (acceptance cases 1-3). No DOM anywhere here — see camera-view.mjs's own
// doc comment on why `aspect` is a plain number, not a measurement.
import { it, expect } from 'vitest'
import { cameraWindowHome, clampCameraWindow, cameraViewSettings } from './camera-view.mjs'
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

it('clampCameraWindow falls back to a harmless combined ratio for a missing or invalid aspect', () => {
  expect(clampCameraWindow({ x: 0.2, y: 0.2, w: 0.2 })).toEqual({ x: 0.2, y: 0.2, w: 0.2 })
  expect(clampCameraWindow({ x: 0.2, y: 0.2, w: 0.2 }, 0)).toEqual({ x: 0.2, y: 0.2, w: 0.2 })
  expect(clampCameraWindow({ x: 0.2, y: 0.2, w: 0.2 }, -1)).toEqual({ x: 0.2, y: 0.2, w: 0.2 })
  expect(clampCameraWindow({ x: 0.2, y: 0.2, w: 0.2 }, NaN)).toEqual({ x: 0.2, y: 0.2, w: 0.2 })
})

it('cameraViewSettings returns window only for the literal value "window", full for everything else', () => {
  expect(cameraViewSettings('window')).toBe('window')
  for (const input of ['full', undefined, null, '', 'Window', 'full ', 0, true]) {
    expect(cameraViewSettings(input)).toBe('full')
  }
})

it('validatePfdPreferences round-trips cameraView and cameraWindow, defaulting both', () => {
  const defaults = validatePfdPreferences()
  expect(defaults.display.cameraView).toBe('full')
  expect(defaults.display.cameraWindow).toEqual(cameraWindowHome)

  const stored = validatePfdPreferences({ display: { cameraView: 'window', cameraWindow: { x: 0.3, y: 0.3, w: 0.25 } } })
  expect(stored.display.cameraView).toBe('window')
  expect(stored.display.cameraWindow).toEqual({ x: 0.3, y: 0.3, w: 0.25 })
})

it('validatePfdPreferences clamps a stored geometry and replaces an impossible one with home', () => {
  const clamped = validatePfdPreferences({ display: { cameraWindow: { x: 0.99, y: 0.99, w: 5 } } })
  expect(clamped.display.cameraWindow.w).toBe(0.5)
  expect(clamped.display.cameraWindow.x).toBeLessThanOrEqual(0.5)

  for (const cameraWindow of [null, 'nonsense', 42, { x: 0.2 }, { x: 'a', y: 0.2, w: 0.2 }]) {
    expect(validatePfdPreferences({ display: { cameraWindow } }).display.cameraWindow).toEqual(cameraWindowHome)
  }

  expect(validatePfdPreferences({ display: { cameraView: 'nonsense' } }).display.cameraView).toBe('full')
  expect(validatePfdPreferences({ display: { cameraView: 42 } }).display.cameraView).toBe('full')
})
