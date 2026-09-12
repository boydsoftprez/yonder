// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-29: the camera fills the attitude scene. Four things are under test
// here, each traced to one of Task 1's produced interfaces: `YonderPicture`'s
// `scene` presentation and `stale` emit, `TerrainVision`'s `draw` prop, the
// flight display's own `cameraBackground`/`horizonLine` handling, and the
// host (`YonderCockpit`) keeping terrain mounted under a camera instead of
// unmounting it — K-68's actual regression.
import { mount, flushPromises } from '@vue/test-utils'
import { markRaw } from 'vue'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import YonderPicture from '../YonderPicture.vue'
import YonderCockpit from '../YonderCockpit.vue'
import TerrainVision from './TerrainVision.vue'
import PrimaryFlightDisplay from './PrimaryFlightDisplay.vue'
import { validatePfdPreferences } from './pfd-controls.mjs'
import { fixtureCamera } from '../../../cockpit/fixture.mjs'

const mocks = vi.hoisted(() => ({ pack: vi.fn(), build: vi.fn() }))
vi.mock('./terrain-pack-client.mjs', () => ({ loadTerrainPack: mocks.pack }))
vi.mock('./terrain-state.mjs', async original => ({ ...await original(), buildTerrainMesh: mocks.build }))

// ---------------------------------------------------------------------------
// YonderPicture: the scene presentation (acceptance 1, 2, 3, 10)
// ---------------------------------------------------------------------------

/** Enough of the browser's own WebRTC surface that `connect()` does not
 * throw in jsdom. The connection itself is not under test in this describe
 * block — the scene presentation, the fill rules and the stale emit are —
 * so the fetch it eventually makes is left hanging rather than answered. */
class InertPeerConnection {
  addTransceiver () {}
  createOffer () { return Promise.resolve({ sdp: 'offer' }) }
  setLocalDescription () { return Promise.resolve() }
  close () {}
}

function mountScenePicture (props: Record<string, unknown> = {}) {
  const emit = vi.fn()
  const wrapper = mount(YonderPicture, {
    props: {
      id: 'scene-1',
      props: { path: 'cam0', label: 'Nose' },
      ...props
    },
    global: {
      provide: { $socket: { emit, on: vi.fn(), off: vi.fn() }, $dataTracker: () => {} },
      mocks: { $store: undefined }
    }
  })
  return { wrapper, emit }
}

describe('YonderPicture scene presentation (R-FLT-29)', () => {
  beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', InertPeerConnection)
    vi.stubGlobal('fetch', () => new Promise(() => {}))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders only the frame and its video with scene:true; without it, the DOM is unchanged from today', () => {
    const { wrapper: scene, emit } = mountScenePicture({ scene: true })
    expect(scene.find('.y-pic__toolbar').exists()).toBe(false)
    expect(scene.find('.y-pic__capture-host').exists()).toBe(false)
    expect(scene.find('.y-pic__notices').exists()).toBe(false)
    expect(scene.find('.y-pic__thumbnails').exists()).toBe(false)
    expect(scene.find('.y-pic__fit').exists()).toBe(true)
    expect(scene.find('.y-pic__frame').exists()).toBe(true)
    expect(scene.find('video').exists()).toBe(true)

    const { wrapper: today } = mountScenePicture()
    expect(today.find('.y-pic__toolbar').exists()).toBe(true)
    expect(today.find('.y-pic__capture-host').exists()).toBe(true)
    expect(today.find('.y-pic__notices').exists()).toBe(true)
    expect(today.find('.y-pic__thumbnails').exists()).toBe(true)
    expect(today.find('.y-pic__fit').exists()).toBe(true)
    expect(today.find('.y-pic__frame').exists()).toBe(true)

    // R-CMD-04/case 10: none of this asked the aircraft or the device for
    // anything — mounting and reading the DOM sent no command.
    expect(emit).not.toHaveBeenCalled()
  })

  it('never renders the stream-start control in the scene, while the Camera page keeps it (C1, R-FLT-29, R-CMD-04)', async () => {
    // `running:false` reaches `cameraRunState` through the report tier
    // `fromPayload` falls back to, exactly as the cockpit host supplies it.
    const stopped = { path: 'cam0', label: 'Nose', report: { path: 'cam0', running: false } }
    const { wrapper: scene, emit } = mountScenePicture({ scene: true, props: stopped })
    await scene.vm.$nextTick()
    expect(scene.get('.y-pic__stopped-l').text()).toContain('Video is stopped')
    expect(scene.find('.y-pic__start').exists()).toBe(false)
    expect(emit).not.toHaveBeenCalled()

    // The same component on the Camera page keeps it, and pressing it is
    // exactly the stream-start path — which is what makes its presence in
    // the flight display the defect, rather than a cosmetic one.
    const { wrapper: page, emit: pageEmit } = mountScenePicture({ props: stopped })
    await page.vm.$nextTick()
    const start = page.get('.y-pic__start')
    expect(start.text()).toContain('Start video')
    await start.trigger('click')
    expect(pageEmit).toHaveBeenCalledWith('widget-action', 'scene-1', expect.objectContaining({ payload: 'start' }))
    scene.unmount(); page.unmount()
  })

  it('shows one line of reason in the scene when there is one, and nothing when the picture is fine (I6, R-UI-20)', async () => {
    const { wrapper, emit } = mountScenePicture({ scene: true, reasonLine: true })
    await wrapper.vm.$nextTick()
    // A picture that has never had a frame is never stale, so with nothing
    // wrong there is nothing to say and the scene says nothing.
    expect(wrapper.find('.y-pic__scene-notice').exists()).toBe(false)
    expect(wrapper.find('.y-pic__reason').exists()).toBe(false)
    expect(wrapper.find('.y-pic__resume').exists()).toBe(false)

    // A delivery failure: the reason, and only the reason.
    wrapper.vm.reason = 'The video service is unavailable. Reconnecting automatically.'
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.y-pic__scene-notice .y-pic__reason').text())
      .toBe('The video service is unavailable. Reconnecting automatically.')
    expect(wrapper.findAll('.y-pic__reason')).toHaveLength(1)
    expect(wrapper.find('.y-pic__resume').exists()).toBe(false)

    // An expired session says so in its own words, ahead of any other reason.
    wrapper.vm.signInRequired = true
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.y-pic__reason').text()).toContain('Your session expired')

    // And the browser's own autoplay block is recoverable from here: the
    // resume control is the operator's browser, not the aircraft.
    wrapper.vm.signInRequired = false
    wrapper.vm.reason = ''
    wrapper.vm.playbackBlocked = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.y-pic__reason').exists()).toBe(false)
    expect(wrapper.get('.y-pic__resume').text()).toBe('Resume live video')

    // Nothing in any of that went to the device or the aircraft.
    expect(emit).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('without reasonLine — the window\'s box, too small for a sentence — keeps the resume control and drops the line', async () => {
    // The sentence is 68px of text in the window's ~40px of usable height,
    // which the page gate measures and refuses as hidden content. The host
    // sets `reasonLine` only on the box that can show it whole; the window
    // keeps the short stopped message and the button, which both fit.
    const { wrapper, emit } = mountScenePicture({ scene: true })
    wrapper.vm.reason = 'The video service is unavailable. Reconnecting automatically.'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.y-pic__reason').exists()).toBe(false)
    expect(wrapper.find('.y-pic__scene-notice').exists()).toBe(false)

    wrapper.vm.playbackBlocked = true
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.y-pic__resume').text()).toBe('Resume live video')
    expect(wrapper.find('.y-pic__reason').exists()).toBe(false)
    expect(emit).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps the scene free of everything else the notices row carries (design decision 2)', async () => {
    const { wrapper } = mountScenePicture({ scene: true, reasonLine: true })
    wrapper.vm.reason = 'something'
    wrapper.vm.flashing = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.y-pic__notices').exists()).toBe(false)
    expect(wrapper.find('.y-pic__saved').exists()).toBe(false)
    expect(wrapper.find('.y-pic__toolbar').exists()).toBe(false)
    expect(wrapper.find('.y-pic__thumbnails').exists()).toBe(false)
    wrapper.unmount()
  })

  it('fills its parent edge to edge: the fit and frame are absolute with zero insets and no aspect ratio, the video covers, and .y-pic is a single grid row', () => {
    const { wrapper } = mountScenePicture({ scene: true })
    const root = getComputedStyle(wrapper.get('.y-pic').element)
    const fit = getComputedStyle(wrapper.get('.y-pic__fit').element)
    const frame = getComputedStyle(wrapper.get('.y-pic__frame').element)
    const video = getComputedStyle(wrapper.get('video').element)

    for (const style of [fit, frame]) {
      expect(style.position).toBe('absolute')
      expect(style.top).toBe('0px')
      expect(style.right).toBe('0px')
      expect(style.bottom).toBe('0px')
      expect(style.left).toBe('0px')
    }
    // "No aspect ratio": nothing here declares one — not the inline style
    // (omitted for `scene`) and not a CSS rule — so the computed value is
    // the property's own initial keyword, never a number.
    expect(frame.aspectRatio.trim()).toMatch(/^(auto)?$/)
    expect(video.objectFit).toBe('cover')
    expect(root.gridTemplateRows.trim()).toBe('1fr')
  })

  it('still hatches and desaturates when stale in scene mode, and emits stale carrying staleFor/ageText: positive when stale, 0 while live', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
    try {
      const { wrapper, emit } = mountScenePicture({ scene: true })

      // Live, right after mount: no hatch, and the immediate emit carries 0
      // — `staleFor` never fires a *change* for a picture that stays live
      // its whole life, so a host still needs one true reading of "not
      // stale" to draw from.
      expect(wrapper.find('.y-pic__hatch').exists()).toBe(false)
      const live = wrapper.emitted('stale')?.at(-1)?.[0] as { seconds: number; text: string }
      expect(live).toEqual({ seconds: 0, text: wrapper.vm.ageText })
      expect(live.seconds).toBe(0)

      // A frame arrives, then contact is lost for long enough to be stale.
      ;(wrapper.vm as unknown as { onFrame: () => void }).onFrame()
      await wrapper.vm.$nextTick()
      await vi.advanceTimersByTimeAsync(70000)
      await wrapper.vm.$nextTick()

      expect((wrapper.vm as unknown as { staleFor: number }).staleFor).toBeGreaterThan(0)
      expect(wrapper.find('.y-pic__hatch').exists()).toBe(true)
      expect((wrapper.vm as unknown as { degradeFilter: string }).degradeFilter).not.toBe('none')

      const stale = wrapper.emitted('stale')?.at(-1)?.[0] as { seconds: number; text: string }
      expect(stale.seconds).toBeGreaterThan(0)
      expect(stale.text).toBe((wrapper.vm as unknown as { ageText: string }).ageText)

      expect(emit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// TerrainVision: evaluation without drawing (acceptance 4, 5)
// ---------------------------------------------------------------------------

const terrainMesh = { positions: new Float32Array(9), normals: new Float32Array(9), uv: new Float32Array(6), indices: new Uint16Array([0, 1, 2]), chunks: [], x: 0, y: 0 }
const terrainTelemetry = { ready: true, fixType: 3, latitude: 35.9611, longitude: -83.366, altitudeDatum: 'EGM96', gpsAltitudeM: 400, trackDeg: 0 }
const terrainFlight = { live: true, attitudeValid: true, heading: 0, pitch: 0, roll: 0, vsi: 0, groundspeed: 40 }
const terrainPack = {
  meshes: [terrainMesh],
  origin: { lat: 35.96, lon: -83.36 },
  groundSampler: () => 300,
  sampleBoth: () => ({ groundM: 300, surfaceM: 300, covered: true, datum: 'EGM96' }),
  manifest: { verticalDatum: 'EGM96', verticalTransform: { verified: true }, sources: [] },
  spacingM: 1,
  farSpacingM: 4
}

/** Copied from `terrain-performance.component.test.ts`'s own `setup()`
 * rather than invented fresh: fake timers, a stubbed `requestAnimationFrame`
 * stepper, a Proxy fake WebGL context installed over
 * `HTMLCanvasElement.prototype.getContext`, and a mocked `loadTerrainPack`. */
function setup () {
  vi.useFakeTimers()
  let id = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id })
  vi.stubGlobal('cancelAnimationFrame', (n: number) => frames.delete(n))
  const clear = vi.fn(), upload = vi.fn(), deleteTexture = vi.fn()
  const gl = new Proxy({ clear, deleteTexture, bufferData: upload, isContextLost: () => false, getShaderParameter: () => true, getProgramParameter: () => true, getExtension: () => ({}), getAttribLocation: () => 0 }, { get: (target, key) => key in target ? (target as any)[key] : typeof key === 'string' && key === key.toUpperCase() ? 1 : vi.fn(() => ({})) })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) => kind === 'webgl' ? gl : { drawImage () {}, getImageData: () => ({ data: new Uint8Array(256 * 256 * 4) }) }) as any)
  vi.stubGlobal('createImageBitmap', async () => ({ width: 256, height: 256, close () {} }))
  const step = async (time: number) => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(time)); await flushPromises(); await vi.advanceTimersByTimeAsync(1); await flushPromises() }
  return { clear, upload, step, deleteTexture }
}

describe('TerrainVision draw prop (R-FLT-29)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('never paints across 120 stepped frames with draw:false, while status keeps reporting a finite estimatedAglM and a non-null forecast', async () => {
    const { clear, step } = setup()
    mocks.pack.mockResolvedValue(terrainPack)
    const provider = { revision: 1, subscribe: () => () => {} }
    const w = mount(TerrainVision, { props: { flight: terrainFlight, telemetry: terrainTelemetry, enabled: true, dataProvider: provider, imageryEnabled: false, draw: false } })
    await step(0)
    clear.mockClear()
    for (let i = 1; i <= 120; i++) await step(i * 1000 / 120)
    expect(clear).not.toHaveBeenCalled()
    expect(w.attributes('data-terrain-ready')).toBe('true')
    const statuses = w.emitted('status') as Array<[{ estimatedAglM: number; forecast: unknown }]>
    const last = statuses[statuses.length - 1][0]
    expect(Number.isFinite(last.estimatedAglM)).toBe(true)
    expect(last.forecast).not.toBeNull()
    w.unmount()
  })

  it('paints at the existing cadence with draw:true, still reporting a finite estimatedAglM and a non-null forecast', async () => {
    const { clear, step } = setup()
    mocks.pack.mockResolvedValue(terrainPack)
    const provider = { revision: 1, subscribe: () => () => {} }
    const w = mount(TerrainVision, { props: { flight: terrainFlight, telemetry: terrainTelemetry, enabled: true, dataProvider: provider, imageryEnabled: false, draw: true } })
    await step(0)
    clear.mockClear()
    for (let i = 1; i <= 120; i++) await step(i * 1000 / 120)
    // The same cadence bounds `terrain-performance.component.test.ts` itself
    // asserts for the undecorated (no `draw` passed) case.
    expect(clear.mock.calls.length).toBeGreaterThanOrEqual(58)
    expect(clear.mock.calls.length).toBeLessThanOrEqual(61)
    expect(w.attributes('data-terrain-ready')).toBe('true')
    const statuses = w.emitted('status') as Array<[{ estimatedAglM: number; forecast: unknown }]>
    const last = statuses[statuses.length - 1][0]
    expect(Number.isFinite(last.estimatedAglM)).toBe(true)
    expect(last.forecast).not.toBeNull()
    w.unmount()
  })

  it('leaves no fossil when draw turns off after painting: the canvas hides, data-terrain-ready stays true, and it paints again once draw returns', async () => {
    const { clear, step } = setup()
    mocks.pack.mockResolvedValue(terrainPack)
    const provider = { revision: 1, subscribe: () => () => {} }
    const w = mount(TerrainVision, { props: { flight: terrainFlight, telemetry: terrainTelemetry, enabled: true, dataProvider: provider, imageryEnabled: false, draw: true } })
    for (let i = 0; i < 12; i++) await step(i * 17)
    expect(w.attributes('data-terrain-ready')).toBe('true')
    expect(clear.mock.calls.length).toBeGreaterThan(0)
    expect(w.get('canvas').attributes('style')).toContain('visibility: visible')

    const paintedSoFar = clear.mock.calls.length
    await w.setProps({ draw: false })
    for (let i = 12; i < 24; i++) await step(i * 17)
    expect(clear.mock.calls.length).toBe(paintedSoFar)
    expect(w.get('canvas').attributes('style')).toContain('visibility: hidden')
    expect(w.attributes('data-terrain-ready')).toBe('true')

    await w.setProps({ draw: true })
    for (let i = 24; i < 36; i++) await step(i * 17)
    expect(clear.mock.calls.length).toBeGreaterThan(paintedSoFar)
    expect(w.get('canvas').attributes('style')).toContain('visibility: visible')
    w.unmount()
  })
})

// ---------------------------------------------------------------------------
// YonderCockpit: terrain stays mounted under a camera (acceptance 6, 10)
// ---------------------------------------------------------------------------

describe('YonderCockpit keeps terrain mounted under a camera (R-FLT-29, K-68)', () => {
  /**
   * `YonderCockpit` reaches the terrain component only through its own
   * `terrainComponent` prop (`default: () => TerrainVision`) — `<component
   * :is="terrainComponent">`, never a name registered in `components:{}` —
   * so `global.stubs` (which matches registered components) cannot reach
   * it; this is the seam the prop exists for. It stands in for
   * `TerrainVision` and records only the one prop this case is about,
   * exactly as `terrain-performance.component.test.ts`'s own fakes record
   * only the calls their case is about.
   */
  const RecordingTerrain = markRaw({
    name: 'RecordingTerrain',
    props: ['flight', 'telemetry', 'enabled', 'displayPose', 'imageryEnabled', 'lookaheadSeconds', 'dataProvider', 'viewport', 'draw', 'snapshot'],
    template: '<div class="recording-terrain" :data-draw="draw"></div>'
  })

  function host (report = fixtureCamera()) {
    return mount(YonderCockpit, {
      props: { id: 'camera-scene-host', report, api: { command: vi.fn(async () => ({ accepted: true, operationId: 'one' })) }, terrainComponent: RecordingTerrain },
      global: { stubs: { YonderCockpitMap: true, YonderPicture: true } }
    })
  }

  it('mounts TerrainVision with draw:false behind a camera and draw:true over terrain, sending no command', async () => {
    const w = host()
    // Today's default background is synthetic terrain.
    expect(w.findComponent(RecordingTerrain).exists()).toBe(true)
    expect(w.findComponent(RecordingTerrain).props('draw')).toBe(true)

    // The regression this task fixes: choosing a camera used to unmount
    // TerrainVision outright, silently dropping height above ground and the
    // clearance forecast (design decision 9).
    w.vm.background = 'camera'
    await w.vm.$nextTick()
    expect(w.findComponent(RecordingTerrain).exists()).toBe(true)
    expect(w.findComponent(RecordingTerrain).props('draw')).toBe(false)

    w.vm.background = 'terrain'
    await w.vm.$nextTick()
    expect(w.findComponent(RecordingTerrain).props('draw')).toBe(true)

    expect(w.props('api').command).not.toHaveBeenCalled()
    w.unmount()
  })

  it('gives the picture the scene presentation and replaces the fixed gradient with the dark ground colour once a camera is chosen (K-68)', async () => {
    const w = host()
    w.vm.background = 'camera'
    await w.vm.$nextTick()
    expect(w.findComponent({ name: 'YonderPicture' }).props('scene')).toBe(true)
    const style = getComputedStyle(w.get('.cockpit-background').element)
    expect(style.backgroundImage).not.toMatch(/gradient/)
    w.unmount()
  })
})

// ---------------------------------------------------------------------------
// PrimaryFlightDisplay: the horizon line over a camera (acceptance 7, 8)
// ---------------------------------------------------------------------------

describe('PrimaryFlightDisplay horizon line over a camera background (R-FLT-29)', () => {
  const flight = { live: true, attitudeValid: true, roll: 0, pitch: 0, heading: 0, airspeed: 60, altitude: 1000, groundspeed: 62, vsi: 0, navPitch: null, navRoll: null, fdValid: false }
  const telemetry = { mode: 'MANUAL', armed: false }
  const guidance = { valid: false, reason: 'No active mission leg' }
  const references = { airspeed: null, altitude: null, heading: null, vsi: null }

  function mountPfd (props: Record<string, unknown> = {}) {
    return mount(PrimaryFlightDisplay, {
      props: {
        flight,
        guidance,
        telemetry,
        cdiScale: 250,
        references,
        options: validatePfdPreferences().display,
        mission: { items: [] },
        backgroundReady: false,
        backgroundLabel: '',
        terrainReport: { state: 'unavailable', message: 'Terrain unavailable' },
        snapshot: null,
        cameraBackground: false,
        ...props
      }
    })
  }

  function opacity (w: ReturnType<typeof mountPfd>, selector: string): string {
    return w.get(selector).attributes('opacity') as string
  }

  it('hides the sky and earth fills and follows the horizonLine switch over a ready camera', () => {
    const camera = mountPfd({ cameraBackground: true, backgroundReady: true })
    expect(opacity(camera, '.pfd-horizon')).toBe('0')
    expect(opacity(camera, '.pfd-horizon-line')).toBe('1')
    camera.unmount()

    const cameraLineOff = mountPfd({ cameraBackground: true, backgroundReady: true, options: { ...validatePfdPreferences().display, horizonLine: false } })
    expect(opacity(cameraLineOff, '.pfd-horizon')).toBe('0')
    expect(opacity(cameraLineOff, '.pfd-horizon-line')).toBe('0')
    cameraLineOff.unmount()
  })

  it('leaves terrain unchanged: the line stays tied to terrainReady exactly as the fills are, ignoring horizonLine', () => {
    const notReady = mountPfd({ cameraBackground: false, backgroundReady: false, options: { ...validatePfdPreferences().display, horizonLine: false } })
    expect(opacity(notReady, '.pfd-horizon')).toBe('1')
    expect(opacity(notReady, '.pfd-horizon-line')).toBe('1')
    notReady.unmount()

    const ready = mountPfd({ cameraBackground: false, backgroundReady: true, options: { ...validatePfdPreferences().display, horizonLine: true } })
    expect(opacity(ready, '.pfd-horizon')).toBe('0')
    expect(opacity(ready, '.pfd-horizon-line')).toBe('0')
    ready.unmount()
  })
})

describe('horizonLine preference validation (R-FLT-29)', () => {
  it('validates as a boolean and defaults to true for junk or absence', () => {
    expect(validatePfdPreferences().display.horizonLine).toBe(true)
    expect(validatePfdPreferences({ display: {} }).display.horizonLine).toBe(true)
    expect(validatePfdPreferences({ display: { horizonLine: 'nonsense' } }).display.horizonLine).toBe(true)
    expect(validatePfdPreferences({ display: { horizonLine: 0 } }).display.horizonLine).toBe(true)
    expect(validatePfdPreferences({ display: { horizonLine: false } }).display.horizonLine).toBe(false)
    expect(validatePfdPreferences({ display: { horizonLine: true } }).display.horizonLine).toBe(true)
  })
})
