// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-29/K-68: the camera window and the top-row Camera control
// (acceptance cases 4-9). Case 6's drag/resize gestures follow
// `CameraWindow.vue`'s own doc comment on mirroring `YonderPicture.vue`'s
// pointer-capture shape; `.cockpit-body`'s bounding box is stubbed the way
// `picture.component.test.ts`/`aimpad.component.test.ts` already stub
// geometry, since jsdom performs no layout.
import { mount } from '@vue/test-utils'
import { markRaw } from 'vue'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import YonderCockpit from '../YonderCockpit.vue'
import PfdControlPanel from './PfdControlPanel.vue'
import { validatePfdPreferences } from './pfd-controls.mjs'
import { cameraWindowHome } from './camera-view.mjs'
import { fixture, fixtureCamera } from '../../../cockpit/fixture.mjs'

/** Enough of the browser's own WebRTC surface that a real `YonderPicture`
 * does not throw in jsdom — identical to `camera-scene.component.test.ts`'s
 * own `InertPeerConnection`. The connection itself is not under test here:
 * these cases are about the window and the control around the picture. */
class InertPeerConnection {
  addTransceiver () {}
  createOffer () { return Promise.resolve({ sdp: 'offer' }) }
  setLocalDescription () { return Promise.resolve() }
  close () {}
}

/** Stands in for `TerrainVision` through the `terrainComponent` seam
 * (`YonderCockpit`'s own `<component :is="terrainComponent">`, never a
 * registered name `global.stubs` could reach) — see
 * `camera-scene.component.test.ts`'s own top-of-file account of why
 * `global.stubs` does not intercept this path. */
const RecordingTerrain = markRaw({
  name: 'RecordingTerrain',
  props: ['flight', 'telemetry', 'enabled', 'displayPose', 'imageryEnabled', 'lookaheadSeconds', 'dataProvider', 'viewport', 'draw', 'snapshot'],
  template: '<div class="recording-terrain" :data-draw="draw"></div>'
})

/** A camera with a real path but no active stream, so `YonderPicture`'s own
 * `cameraRunState` reads `stopped` (`running:false` reaches it through
 * `cameraProps.report`, the lowest-priority tier `fromPayload` already
 * falls back to when no message/store is present) — R-FLT-29 acceptance
 * case 7's "camera selected but not streaming". */
function stoppedCameraReport () {
  const report = fixtureCamera()
  const camera = { ...report.camera, running: false }
  return { ...report, camera, cameras: [camera] }
}

function host (report = fixtureCamera(), extraProps = {}, slots: Record<string, unknown> = {}) {
  const command = vi.fn(async () => ({ accepted: true, operationId: 'one' }))
  const wrapper = mount(YonderCockpit, {
    slots,
    props: {
      id: 'camera-window-host',
      report,
      api: { command },
      terrainComponent: RecordingTerrain,
      ...extraProps
    },
    global: {
      // A real YonderPicture mounts under both the scene and the window in
      // these cases (case 7 needs its own genuine stopped-state rendering),
      // so it needs the same injects `camera-scene.component.test.ts`'s own
      // `mountScenePicture` provides when mounting it directly.
      provide: { $socket: { emit: vi.fn(), on: vi.fn(), off: vi.fn() }, $dataTracker: () => {} },
      // The registered-terrain overlay is a seam with nothing behind it
      // (the design's decision 10) and draws on a canvas jsdom has not
      // implemented; this file is about the window and the control around
      // the picture, so it is stubbed rather than left to log.
      stubs: { YonderCockpitMap: true, CameraTerrainOverlay: true }
    }
  })
  return { wrapper, command }
}

function pointerEvent (type, { pointerId = 1, clientX = 0, clientY = 0, button = 0 } = {}) {
  return new PointerEvent(type, { pointerId, clientX, clientY, button, bubbles: true })
}

/** `.cockpit-body`'s bounding box, stubbed exactly the way
 * `aimpad.component.test.ts`/`picture.component.test.ts` stub a specific
 * element's own `getBoundingClientRect` — jsdom performs no layout, so
 * these fractions have no other way to get a known box to clamp against. */
function stubBody (wrapper, rect = { left: 0, top: 0, width: 1000, height: 600 }) {
  wrapper.get('.cockpit-body').element.getBoundingClientRect = () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height } as DOMRect)
}

describe('the Camera window and control (R-FLT-29, K-68)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('RTCPeerConnection', InertPeerConnection)
    vi.stubGlobal('fetch', () => new Promise(() => {}))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ---------------------------------------------------------------------
  // Case 4
  // ---------------------------------------------------------------------
  it('full has no window and fills the scene; the Camera control opens exactly one window at home with terrain behind it, and maximize or the control again both return to full', async () => {
    const { wrapper: w, command } = host()
    w.vm.background = 'camera'
    await w.vm.$nextTick()

    expect(w.find('.camera-window').exists()).toBe(false)
    expect(w.findComponent({ name: 'YonderPicture' }).props('scene')).toBe(true)
    expect(w.findComponent({ name: 'YonderPicture' }).props('reasonLine')).toBe(true)
    expect(w.findComponent({ name: 'YonderPicture' }).props('unavailableMark')).toBe(false)
    expect(w.find('.cockpit-camera').exists()).toBe(true)

    const cameraButton = w.get('button[aria-label="Camera view"]')
    expect(cameraButton.attributes('aria-pressed')).toBe('false')
    await cameraButton.trigger('click')

    expect(w.findAll('.camera-window')).toHaveLength(1)
    expect(w.vm.preferences.display.cameraWindow).toEqual(cameraWindowHome)
    // The window's picture is not asked for the reason line: its box is too
    // small to show a sentence whole (YonderPicture's `reasonLine` comment).
    // It is asked for the cockpit's unavailable mark instead.
    expect(w.findComponent({ name: 'YonderPicture' }).props('reasonLine')).toBe(false)
    expect(w.findComponent({ name: 'YonderPicture' }).props('unavailableMark')).toBe(true)
    expect(w.find('.cockpit-camera').exists()).toBe(false)
    expect(w.findComponent(RecordingTerrain).props('draw')).toBe(true)
    expect(cameraButton.attributes('aria-pressed')).toBe('true')

    await w.get('.camera-window__maximize').trigger('click')
    expect(w.find('.camera-window').exists()).toBe(false)
    expect(w.find('.cockpit-camera').exists()).toBe(true)
    expect(w.findComponent(RecordingTerrain).props('draw')).toBe(false)

    await cameraButton.trigger('click')
    expect(w.find('.camera-window').exists()).toBe(true)
    await cameraButton.trigger('click')
    expect(w.find('.camera-window').exists()).toBe(false)
    expect(w.find('.cockpit-camera').exists()).toBe(true)

    expect(command).not.toHaveBeenCalled()
    w.unmount()
  })

  // ---------------------------------------------------------------------
  // Case 5
  // ---------------------------------------------------------------------
  it('the Camera control sits beside full screen, reports its state, and is disabled/unavailable with no camera selected, doing nothing when pressed', async () => {
    const { wrapper: w, command } = host(fixture()) // no camera at all
    const cameraButton = w.get('button[aria-label="Camera view"]')
    const fullscreenButton = w.get('.cockpit-fullscreen')
    expect(cameraButton.element.nextElementSibling).toBe(fullscreenButton.element)
    expect(cameraButton.attributes('disabled')).toBeDefined()
    expect(cameraButton.text()).toContain('unavailable')

    // Pressing it changes nothing at all: no window, and the background it
    // would otherwise move stays where it was (the design's third row —
    // "no camera selected, or none configured: unchanged from today").
    await cameraButton.trigger('click')
    expect(w.find('.camera-window').exists()).toBe(false)
    expect(w.vm.background).toBe('terrain')

    w.vm.toggleCameraView() // direct call bypasses the DOM's own disabled guard
    await w.vm.$nextTick()
    expect(w.find('.camera-window').exists()).toBe(false)
    expect(w.vm.background).toBe('terrain')

    expect(command).not.toHaveBeenCalled()
    w.unmount()
  })

  it('the Camera control is available and reports window/full once a camera is selected', async () => {
    const { wrapper: w } = host()
    w.vm.background = 'camera'
    await w.vm.$nextTick()
    const cameraButton = w.get('button[aria-label="Camera view"]')
    expect(cameraButton.attributes('disabled')).toBeUndefined()
    expect(cameraButton.text()).toContain('Full · tap for window')
    await cameraButton.trigger('click')
    expect(cameraButton.text()).toContain('Window · tap for full')
    w.unmount()
  })

  // ---------------------------------------------------------------------
  // Case 6
  // ---------------------------------------------------------------------
  it('dragging the header moves the window, dragging the grip resizes its width only, both persist across a remount, and the settings reset returns to home without touching cameraView', async () => {
    const report = fixtureCamera()
    const { wrapper: w, command } = host(report)
    w.vm.background = 'camera'
    w.vm.toggleCameraView() // full -> window
    await w.vm.$nextTick()
    stubBody(w)

    const header = w.get('.camera-window__header')
    const grip = w.get('.camera-window__grip')

    // Drag the header: x/y move together, w is untouched.
    await header.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 }))
    await header.element.dispatchEvent(pointerEvent('pointermove', { pointerId: 1, clientX: 150, clientY: 130 }))
    await header.element.dispatchEvent(pointerEvent('pointerup', { pointerId: 1, clientX: 150, clientY: 130 }))
    await w.vm.$nextTick()
    expect(w.vm.preferences.display.cameraWindow.x).toBeCloseTo(0.18)
    expect(w.vm.preferences.display.cameraWindow.y).toBeCloseTo(0.17)
    expect(w.vm.preferences.display.cameraWindow.w).toBeCloseTo(0.17)

    // Drag the grip: w changes, x/y are exactly what the header drag left.
    const beforeResize = { ...w.vm.preferences.display.cameraWindow }
    const aspectBefore = w.get('.camera-window').attributes('style')
    await grip.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2, clientX: 100, clientY: 100 }))
    await grip.element.dispatchEvent(pointerEvent('pointermove', { pointerId: 2, clientX: 150, clientY: 100 }))
    await grip.element.dispatchEvent(pointerEvent('pointerup', { pointerId: 2, clientX: 150, clientY: 100 }))
    await w.vm.$nextTick()
    expect(w.vm.preferences.display.cameraWindow.x).toBeCloseTo(beforeResize.x)
    expect(w.vm.preferences.display.cameraWindow.y).toBeCloseTo(beforeResize.y)
    expect(w.vm.preferences.display.cameraWindow.w).toBeGreaterThan(beforeResize.w)
    expect(w.get('.camera-window').attributes('style')).toContain('aspect-ratio')
    expect(w.get('.camera-window').attributes('style')?.match(/aspect-ratio:\s*([^;]+)/)?.[1])
      .toBe(aspectBefore?.match(/aspect-ratio:\s*([^;]+)/)?.[1])

    // A drag far past the box's own edge stays inside it.
    await header.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 3, clientX: 0, clientY: 0 }))
    await header.element.dispatchEvent(pointerEvent('pointermove', { pointerId: 3, clientX: 5000, clientY: 5000 }))
    await header.element.dispatchEvent(pointerEvent('pointerup', { pointerId: 3, clientX: 5000, clientY: 5000 }))
    await w.vm.$nextTick()
    const pushed = w.vm.preferences.display.cameraWindow
    expect(pushed.x + pushed.w).toBeLessThanOrEqual(1)
    expect(pushed.x).toBeGreaterThanOrEqual(0)
    expect(pushed.y).toBeGreaterThanOrEqual(0)

    const dragged = { ...w.vm.preferences.display.cameraWindow }
    w.unmount()

    // Survives a remount: the same browser's localStorage, a fresh instance.
    const { wrapper: w2 } = host(report)
    expect(w2.vm.preferences.display.cameraWindow).toEqual(dragged)
    expect(w2.vm.cameraView).toBe('window') // cameraView itself round-trips too

    // The settings reset: home geometry, cameraView untouched.
    w2.vm.setOption('cameraWindow', { ...cameraWindowHome })
    await w2.vm.$nextTick()
    expect(w2.vm.preferences.display.cameraWindow).toEqual(cameraWindowHome)
    expect(w2.vm.cameraView).toBe('window')

    expect(command).not.toHaveBeenCalled()
    w2.unmount()
  })

  it('PfdControlPanel\'s reset control emits home geometry verbatim, without emitting cameraView', async () => {
    const panel = mount(PfdControlPanel, {
      props: { kind: 'attitude', flight: { live: false }, guidance: {}, telemetry: {}, references: {}, options: validatePfdPreferences().display, mission: { items: [] } }
    })
    const reset = panel.findAll('.pfd-wide-button').find(b => b.text() === 'Reset camera window position')
    expect(reset).toBeTruthy()
    await reset!.trigger('click')
    expect(panel.emitted('option')?.at(-1)).toEqual(['cameraWindow', cameraWindowHome])
    expect(panel.emitted('option')?.some(call => call[0] === 'cameraView')).toBe(false)
    panel.unmount()
  })

  // ---------------------------------------------------------------------
  // Case 7
  // ---------------------------------------------------------------------
  it('with a selected camera that is not streaming: full keeps today\'s unavailable banner and its terrain switch, and the control still flips; window shows the reason inside itself with no scene banner', async () => {
    const { wrapper: w, command } = host(stoppedCameraReport())
    w.vm.background = 'camera'
    await w.vm.$nextTick()

    // Full: cameraPath is truthy (a real path exists), so today's
    // "Selected camera unavailable" fallback does not apply; the picture
    // itself, still mounted, carries its own stopped-state message.
    expect(w.find('.cockpit-camera-fallback').exists()).toBe(false)
    expect(w.find('.cockpit-empty-background').exists()).toBe(false)
    expect(w.find('.cockpit-camera').exists()).toBe(true)
    expect(w.vm.cameraPath).toBeTruthy()

    // C1: the picture's own stopped *message* is the reason and stays; its
    // Start button emits `widget-action: start`, the same path the Camera
    // page starts the device's stream with, and must not exist anywhere in
    // the flight display (R-FLT-29's last sentence, R-CMD-04).
    expect(w.get('.y-pic__stopped-l').text()).toContain('Video is stopped')
    expect(w.find('.y-pic__start').exists()).toBe(false)

    const cameraButton = w.get('button[aria-label="Camera view"]')
    expect(cameraButton.attributes('disabled')).toBeUndefined()
    await cameraButton.trigger('click')
    expect(w.find('.camera-window').exists()).toBe(true)
    expect(w.find('.cockpit-camera-fallback').exists()).toBe(false)
    expect(w.find('.cockpit-empty-background').exists()).toBe(false)

    // And the window carries the cockpit's own unavailable mark instead of a
    // message it has no room for (the operator's ruling of 2026-09-12): the
    // red cross and one line, with no control of any kind under it.
    expect(w.find('.camera-window .y-pic__unavailable').exists()).toBe(true)
    expect(w.get('.camera-window .y-pic__missing-l').text()).toBe('VIDEO STOPPED')
    expect(w.find('.camera-window .y-pic__stopped').exists()).toBe(false)
    expect(w.find('.y-pic__start').exists()).toBe(false)

    expect(command).not.toHaveBeenCalled()
    w.unmount()
  })

  it('with no camera path at all, today\'s fallback and its synthetic-terrain switch are unaffected by cameraView', async () => {
    const { wrapper: w } = host(fixture()) // no camera fixture attached at all: cameraPath is falsy
    w.vm.background = 'camera'
    await w.vm.$nextTick()
    expect(w.find('.cockpit-camera-fallback').exists()).toBe(true)
    await w.get('.cockpit-camera-fallback button').trigger('click')
    expect(w.vm.background).toBe('terrain')
    w.unmount()
  })

  // ---------------------------------------------------------------------
  // Case 8
  // ---------------------------------------------------------------------
  it('shows the stale age in the footer label in full, in the window header in window, and in neither while live', async () => {
    const { wrapper: w } = host()
    w.vm.background = 'camera'
    await w.vm.$nextTick()

    const emitStale = (seconds, text) => w.findComponent({ name: 'YonderPicture' }).vm.$emit('stale', { seconds, text })

    emitStale(0, '')
    await w.vm.$nextTick()
    expect(w.get('.display-foot').text()).not.toMatch(/ago/)

    emitStale(42, '42 s ago')
    await w.vm.$nextTick()
    expect(w.get('.display-foot').text()).toContain('42 s ago')
    expect(w.find('.camera-window__age').exists()).toBe(false)

    await w.get('button[aria-label="Camera view"]').trigger('click')
    await w.vm.$nextTick()
    expect(w.get('.display-foot').text()).not.toContain('42 s ago')

    emitStale(7, '7 s ago')
    await w.vm.$nextTick()
    expect(w.get('.camera-window__age').text()).toBe('7 s ago')

    emitStale(0, '')
    await w.vm.$nextTick()
    expect(w.find('.camera-window__age').exists()).toBe(false)

    w.unmount()
  })

  // ---------------------------------------------------------------------
  // Case 9 is asserted inline (command not called) in every case above.
  // ---------------------------------------------------------------------
})

// ---------------------------------------------------------------------------
// The whole-branch review's findings: one state, not two (C2), a live
// maximize control (I1), no ghost age (I3), a measured clamp (I4), and a
// route to the window at every width (I5).
// ---------------------------------------------------------------------------
describe('the camera presentation is one state with the background (R-FLT-29 C2)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('RTCPeerConnection', InertPeerConnection)
    vi.stubGlobal('fetch', () => new Promise(() => {}))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('the default state with a camera configured is the window, not a scene with no picture anywhere', async () => {
    // The design: "There is no third state with a camera selected and no
    // picture anywhere." Nothing is set here — this is a first load.
    const { wrapper: w, command } = host()
    await w.vm.$nextTick()

    expect(w.vm.background).toBe('terrain')
    expect(w.vm.cameraView).toBe('window')
    expect(w.findAll('.camera-window')).toHaveLength(1)
    expect(w.find('.cockpit-camera').exists()).toBe(false)
    expect(w.findComponent(RecordingTerrain).props('draw')).toBe(true)

    const cameraButton = w.get('button[aria-label="Camera view"]')
    expect(cameraButton.text()).toContain('Window · tap for full')
    expect(cameraButton.attributes('aria-pressed')).toBe('true')

    expect(command).not.toHaveBeenCalled()
    w.unmount()
  })

  it('the Background chooser and the Camera control move the same one value, in both directions', async () => {
    const { wrapper: w } = host()
    w.vm.panel = 'display' // Display -> Map, terrain & data, where the chooser lives
    await w.vm.$nextTick()
    const chooser = w.findAll('select').find(sel => sel.findAll('option').some(o => o.attributes('value') === 'camera-overlay'))
    expect(chooser).toBeTruthy()

    // Chooser: Camera is full.
    await chooser!.setValue('camera')
    expect(w.vm.cameraView).toBe('full')
    expect(w.find('.camera-window').exists()).toBe(false)
    expect(w.find('.cockpit-camera').exists()).toBe(true)

    // Chooser: Synthetic terrain with a camera selected is the window.
    await chooser!.setValue('terrain')
    expect(w.vm.cameraView).toBe('window')
    expect(w.find('.camera-window').exists()).toBe(true)

    // The control: one tap each way, moving the background itself.
    await w.get('button[aria-label="Camera view"]').trigger('click')
    expect(w.vm.background).toBe('camera')
    expect(chooser!.element.value).toBe('camera')
    await w.get('button[aria-label="Camera view"]').trigger('click')
    expect(w.vm.background).toBe('terrain')
    w.unmount()
  })

  it('the state survives a reload, and maximize returns to the camera background the operator chose', async () => {
    const report = fixtureCamera()
    const { wrapper: w } = host(report)
    w.vm.background = 'camera-overlay'
    await w.vm.$nextTick()
    expect(w.vm.cameraView).toBe('full')

    w.unmount()
    const { wrapper: w2 } = host(report)
    await w2.vm.$nextTick()
    expect(w2.vm.background).toBe('camera-overlay') // spec: "Reload: the state ... restored"
    expect(w2.vm.cameraView).toBe('full')
    expect(w2.find('.camera-window').exists()).toBe(false)

    // Down to the window and back up: the overlay choice is remembered.
    await w2.get('button[aria-label="Camera view"]').trigger('click')
    expect(w2.vm.background).toBe('terrain')
    await w2.get('.camera-window__maximize').trigger('click')
    expect(w2.vm.background).toBe('camera-overlay')
    w2.unmount()
  })

  it('the window state is the terrain scene, so it shows the traffic the identical scene shows (R-UI-20)', async () => {
    // Reached through the chooser and reached through the control are the
    // same scene; before C2 the window state silently omitted ADS-B.
    const seen: unknown[] = []
    const { wrapper: w } = host(fixtureCamera(), {}, {
      'traffic-vision': (slotProps: { enabled: boolean }) => { seen.push(slotProps.enabled); return null }
    })
    await w.vm.$nextTick()
    expect(w.vm.cameraView).toBe('window')
    expect(seen.at(-1)).toBe(true)

    w.vm.background = 'camera'
    await w.vm.$nextTick()
    expect(seen.at(-1)).toBe(false)
    w.unmount()
  })
})

describe('the window\'s own controls and geometry (R-FLT-29 I1, I3, I4, I5)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('RTCPeerConnection', InertPeerConnection)
    vi.stubGlobal('fetch', () => new Promise(() => {}))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('pressing the maximize control starts no header gesture, so its own click survives (I1)', async () => {
    const { wrapper: w } = host()
    await w.vm.$nextTick()
    stubBody(w)
    const windowComponent = w.findComponent({ name: 'CameraWindow' })
    const maximize = w.get('.camera-window__maximize')
    const before = { ...w.vm.preferences.display.cameraWindow }

    // The real browser's order: pointerdown on the button bubbles to the
    // header, which is where capture was being taken.
    maximize.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 9, clientX: 40, clientY: 12 }))
    await w.vm.$nextTick()
    expect(windowComponent.vm.gestureKind).toBe(null)

    // A move after that press must not drag the window either.
    w.get('.camera-window__header').element.dispatchEvent(pointerEvent('pointermove', { pointerId: 9, clientX: 300, clientY: 300 }))
    await w.vm.$nextTick()
    expect(w.vm.preferences.display.cameraWindow).toEqual(before)

    await maximize.trigger('click')
    expect(w.vm.cameraView).toBe('full')
    w.unmount()
  })

  it('a press on the header itself still drags, so the guard is about controls only (I1)', async () => {
    const { wrapper: w } = host()
    await w.vm.$nextTick()
    stubBody(w)
    const header = w.get('.camera-window__header')
    header.element.dispatchEvent(pointerEvent('pointerdown', { pointerId: 11, clientX: 100, clientY: 100 }))
    header.element.dispatchEvent(pointerEvent('pointermove', { pointerId: 11, clientX: 150, clientY: 100 }))
    header.element.dispatchEvent(pointerEvent('pointerup', { pointerId: 11, clientX: 150, clientY: 100 }))
    await w.vm.$nextTick()
    expect(w.vm.preferences.display.cameraWindow.x).toBeCloseTo(0.18)
    w.unmount()
  })

  it('a stale age from a picture that is gone is not read as the age of what replaced it (I3)', async () => {
    const report = fixtureCamera()
    const { wrapper: w } = host(report)
    w.vm.background = 'camera'
    await w.vm.$nextTick()
    w.findComponent({ name: 'YonderPicture' }).vm.$emit('stale', { seconds: 42, text: '42 s ago' })
    await w.vm.$nextTick()
    expect(w.get('.display-foot').text()).toContain('42 s ago')

    // The camera goes away entirely: no picture is mounted anywhere.
    await w.setProps({ report: { ...report, camera: null, cameras: [] } })
    await w.vm.$nextTick()
    expect(w.vm.picturePresent).toBe(false)
    expect(w.vm.pictureStale).toEqual({ seconds: 0, text: '' })
    expect(w.get('.display-foot').text()).not.toContain('42 s ago')
    w.unmount()
  })

  it('a stored position is validated on load without a guessed shape, then clamped against the box actually measured (I4)', async () => {
    // A position legitimate on a portrait scene, which the old load-time
    // guess of ratio 1 cut away before any box had been measured.
    localStorage.setItem('yonder-cockpit-v1', JSON.stringify({ display: { background: 'camera', cameraWindow: { x: 0.1, y: 0.88, w: 0.2 } } }))
    const { wrapper: w } = host()
    await w.vm.$nextTick()
    expect(w.vm.preferences.display.cameraWindow).toEqual({ x: 0.1, y: 0.88, w: 0.2 })

    // A portrait box: 0.88 is inside it, and the mount leaves it alone.
    stubBody(w, { left: 0, top: 0, width: 768, height: 1024 })
    await w.get('button[aria-label="Camera view"]').trigger('click')
    await w.vm.$nextTick()
    expect(w.vm.preferences.display.cameraWindow.y).toBeCloseTo(0.88)

    // A box wider than the picture's own shape: the same fraction now hangs
    // off the bottom, and the mount pulls it back in.
    await w.get('.camera-window__maximize').trigger('click')
    stubBody(w, { left: 0, top: 0, width: 2000, height: 600 })
    await w.get('button[aria-label="Camera view"]').trigger('click')
    await w.vm.$nextTick()
    const clamped = w.vm.preferences.display.cameraWindow
    expect(clamped.y).toBeCloseTo(0.625)
    expect(clamped.y + clamped.w * ((2000 / 600) / (16 / 9))).toBeLessThanOrEqual(1.0001)

    // And a later resize of that same box is honoured too.
    stubBody(w, { left: 0, top: 0, width: 600, height: 2000 })
    window.dispatchEvent(new Event('resize'))
    await w.vm.$nextTick()
    expect(w.vm.preferences.display.cameraWindow.y).toBeCloseTo(0.625)
    w.unmount()
  })

  it('the cockpit overflow menu carries the Camera control at the widths that hide the top row (I5, R-FLT-25)', async () => {
    const { wrapper: w, command } = host()
    w.vm.background = 'camera'
    await w.vm.$nextTick()
    w.vm.panel = 'cockpit-menu'
    await w.vm.$nextTick()

    const row = w.get('.cockpit-menu-camera')
    expect(row.attributes('disabled')).toBeUndefined()
    expect(row.text()).toContain('Full · tap for window')
    await row.trigger('click')
    await w.vm.$nextTick()
    expect(w.vm.panel).toBe(null)
    expect(w.vm.cameraView).toBe('window')
    expect(w.find('.camera-window').exists()).toBe(true)
    expect(command).not.toHaveBeenCalled()
    w.unmount()

    const { wrapper: none } = host(fixture()) // no camera configured
    none.vm.panel = 'cockpit-menu'
    await none.vm.$nextTick()
    const disabled = none.get('.cockpit-menu-camera')
    expect(disabled.attributes('disabled')).toBeDefined()
    expect(disabled.text()).toContain('unavailable')
    none.unmount()
  })
})
