<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script>
import { h } from 'vue'
import YonderPlacard from './YonderPlacard.vue'
import YonderColumn from './YonderColumn.vue'
import YonderPicker from './YonderPicker.vue'
import YonderSegmented from './YonderSegmented.vue'
import YonderSetBar from './YonderSetBar.vue'
import YonderTextField from './YonderTextField.vue'
import YonderShutter from './YonderShutter.vue'
import YonderAimPad from './YonderAimPad.vue'
import { AimTransport } from './aim-transport.ts'
import { createDraftStore } from './draft.ts'
import { LABELS, captureDestination, captureRefusal, captureSizes, deckDraft, draftPathFor, endedWords, interruption } from 'yonder-core/presentation'

/**
 * `ui-yonder-deck` — a camera's whole control surface, composed from what it
 * answered (R-UI-08, R-UI-20, R-UI-21, R-CFG-03). This is the task the whole
 * plan was written for.
 *
 * **The shipped console applies a typed value the moment focus leaves the
 * field.** No confirmation, no way back, on a page an operator reaches for
 * while an aircraft is flying. This component draws the fix: an *image*
 * control — brightness, gain, white balance, every key `CAPABILITY_LAYOUT`
 * below maps to `kind: 'bar' | 'pick' | 'seg'` — is a live command and posts
 * on press, through `setControl()`. A *stream or preview policy* edit —
 * everything `buildStream`/`buildPreview` draw, plus the camera's own name —
 * never touches the socket: it lands in `draftStore` (Task 21's
 * `createDraftStore`, `./draft.js`) via `stage()`, and only leaves this
 * component when Setup's Apply is pressed. Confusing those two is the defect
 * this whole plan exists to fix, so nothing below shares one code path
 * between them.
 *
 * **The deck decides nothing about the camera — it draws what the report
 * says.** `CAPABILITY_LAYOUT` is `capability.ts`'s own `CAPABILITY_KEYS`
 * technique applied a second time: a plain object literal typed (informally —
 * this file is JavaScript, not TypeScript, like every other `.vue` in this
 * package) against all 23 real keys, so a capability with nowhere to go is a
 * fact this file has to state rather than a control silently missing.
 * `drawCapability()` reads a key's `state` straight off `capabilities[key]` —
 * `present` draws the control, `not-offered` draws a fact and nothing else,
 * `advertised`/`gated` draw the same control disabled, carrying the reason —
 * and never re-derives gating the way the blueprint's own mock `stateOf()`
 * does, because the real probe (`probe/camera.ts`'s `gateIfInactive`) has
 * already decided it by the time a report reaches this page.
 *
 * **The Orientation group is the one exception, and it is a deliberate one**
 * (R-CTL-15). Mirror, Flip and Rotation are drawn from `orientation`, never
 * from `capabilities`, because a camera whose sensor turns nothing is still a
 * camera whose picture Yonder turns — on the board, after decoding. Read the
 * capability state there and the group prints three sentences saying the
 * camera cannot, over three controls that work. See `buildOrientation()`.
 *
 * **Units and menu options are never restated.** `descriptors[key]` is
 * `video/descriptors.ts`'s own `describe()` output — raw 156 already reads
 * 15600 µs by the time it reaches `values.exposure` — and a `pick` control's
 * `options` come from `capabilities[key].value.menu`, the probe's own list,
 * never expanded to fill `min…max`.
 *
 * **Columns hold their slot.** `SLOTS` is a fixed assignment, not a CSS flow:
 * the operator found, in person, that toggling Stream between Fixed and
 * Adaptive repacked every group into a different column when this ran on
 * CSS multi-column layout, on a page used while an aircraft is flying. Each
 * group here can grow or shrink its own height freely — the housekeeping
 * group in particular appears only on Setup — and nothing else ever moves
 * for it.
 *
 * **The payload this component reads**, one whole `msg.payload` object,
 * documented here because nothing upstream of this file has ever needed the
 * shape before:
 *
 * ```
 * { camera: { id, name, spec },
 *   capabilities: CameraCapabilities,           // yonder-core/presentation
 *   descriptors: Record<key, DescriptorView>,   // present/advertised/gated keys only
 *   values: Record<key, number|boolean|null>,   // display units; null when unreported
 *   commanded: Record<key, number|null>,
 *   policy: { capture: { width, height, framerate, codec },
 *             stream: { mode, floor_kbps, ceiling_kbps, bitrate_kbps },
 *             preview: { mode, size, ladder_bottom, ladder_top, floor_kbps,
 *                        ceiling_kbps, bitrate_kbps, framerate } },
 *   applied: { capture: <same shape as policy.capture>,
 *              stream: <same shape as policy.stream>,
 *              preview: <same shape as policy.preview> },
 *   outputs: { kind, label, enabled, costKbps, reach: OutputReach }[],
 *   captures: { count },
 *   recorder: { recording, since, destination, remainingSeconds,
 *               remainingPhotos, bytes, ended } | null,
 *   orientation: { says, turns: { key, by: "sensor"|"board",
 *                                 says: string|null, value }[] },
 *   problems: { path, message }[],    // only after a refused apply
 *   problemsFor: string }             // the camera those problems are about
 * ```
 *
 * `policy` and `applied` share one schema-shaped sub-shape (schema field
 * names and casing — `floor_kbps`, `mode: "fixed"|"adaptive"` — never the
 * blueprint's own `previewFloor`/`"Adaptive"` UI names) because that is what
 * the config schema itself stores (`schema/config.ts`'s `Stream`/`Preview`).
 * `policy` is what this deck renders a control's *current* value from;
 * `applied` is what `appliedForDraft()` below flattens for the draft's own
 * pending comparison — in practice the same numbers most of the time, kept
 * as two names because a respawn in flight is exactly the moment they can
 * disagree, and only one of them is this page's business to draw from.
 *
 * **The adapter the draft needs, and why it is a named function.** The
 * draft's paths are the blueprint's own UI-facing names — `streamMode:
 * "Adaptive"`, `previewFloor` — because `draft.ts`'s `pending(camera,
 * applied)` was written once, spanning both the image-control domain
 * (`values`, already keyed by capability name) and this schema-shaped one,
 * and a loose `path: string` is what let it. `appliedForDraft()` is the seam
 * between the two naming conventions, on its own rather than folded into a
 * computed or a render-path lambda, because a seam between two conventions
 * is exactly where they drift — and it has its own test
 * (`deck.component.test.ts`) rather than only being exercised indirectly.
 */

/**
 * Capability key -> where it is drawn and how (Coordinator resolution 5, and
 * `CAPABILITY_KEYS`'s own reason, applied a second time). Written down
 * rather than derived, so a capability `capability.ts` adds later has
 * nowhere to render until a person decides where — the same failure mode
 * `CAPABILITY_KEYS` itself exists to turn into something loud.
 *
 * `kind`: `bar` (a bounded value, `YonderSetBar`), `pick` (the device's own
 * menu, `YonderPicker`), `seg` (a plain on/off, `YonderSegmented`), or one of
 * the ones that are not an image control at all and draw through a branch of
 * their own: `shutter` — both of `recording` and `stills`, drawn as **one**
 * key by `buildCapture()` — `turn` in `buildOrientation()`, and `capture`,
 * the format list, drawn as the Stream column's Resolution and Frame rate
 * pickers by `buildCaptureShape()`.
 *
 * `setupOnly` marks the four housekeeping controls this deck draws only on
 * Setup — mains frequency, backlight compensation, gain and sharpness: real
 * settings, rarely touched, that do not need to compete for space with
 * Exposure and Colour on the page an operator watches while flying.
 *
 * `group: 'aim'` is deliberately not one of `SLOTS`' four columns — the aim
 * panel sits beside the picture on Live only, the same placement the
 * blueprint gives it, and never appears on Setup.
 */
export const CAPABILITY_LAYOUT = {
  /* **`formats` is drawn by the Stream column's two pickers** (R-CAM-14,
   * R-VID-07, blueprint L-51/L-56). It was a `CAPTURE FORMATS 10` readout
   * here, which states a number where the requirement asks for the formats
   * themselves: ten is not a fact an operator can act on, and it sat beside
   * no control that offered any of them. The formats are now the Resolution
   * and Frame rate menus, so this key's home is `buildStream()` — its own
   * branch, like `turn`'s, because a size and its rates are two menus rather
   * than one `pick`. */
  formats: { group: 'stream', kind: 'capture' },
  zoom: { group: 'optics', kind: 'bar' },
  focus: { group: 'optics', kind: 'bar' },
  exposure: { group: 'exposure', kind: 'bar' },
  whiteBalance: { group: 'exposure', kind: 'bar' },
  brightness: { group: 'colour', kind: 'bar' },
  contrast: { group: 'colour', kind: 'bar' },
  rotation: { group: 'orientation', kind: 'turn' },
  aim: { group: 'aim', kind: 'aim' },
  /* **One key, not two** (blueprint L-43/L-44). Both capabilities land on the
   * same `shutter` kind and `buildCapture()` draws *one* control from
   * whichever of them the MODE control has selected — the camera cannot
   * record and photograph at once, so two keys drawn side by side is a lie
   * about that, and it is the lie this deck shipped. `drawCapability()` is
   * never called for either: the capture group owns the pair, the way
   * `buildOrientation()` owns its three and `buildCaptureShape()` owns
   * `formats`, because what is drawn depends on a fact outside any one key. */
  recording: { group: 'capture', kind: 'shutter' },
  stills: { group: 'capture', kind: 'shutter' },
  saturation: { group: 'colour', kind: 'bar' },
  hue: { group: 'colour', kind: 'bar' },
  autoWhiteBalance: { group: 'exposure', kind: 'seg' },
  gamma: { group: 'rendering', kind: 'bar' },
  gain: { group: 'housekeeping', kind: 'bar', setupOnly: true },
  powerLineFrequency: { group: 'housekeeping', kind: 'pick', setupOnly: true },
  sharpness: { group: 'housekeeping', kind: 'bar', setupOnly: true },
  backlightCompensation: { group: 'housekeeping', kind: 'bar', setupOnly: true },
  autoExposure: { group: 'exposure', kind: 'pick' },
  autoFocus: { group: 'optics', kind: 'seg' },
  /* R-CTL-05's two switches, beside `rotation` in the same group — a flip is
   * not a rotation, so each is its own on/off rather than more degrees on
   * that bar.
   *
   * **`turn` is the fourth kind that draws through its own branch**, beside
   * `formats` and the two shutters, and it is the only one whose reason is
   * not the shape of the control. All three of these draw from
   * `report.orientation` and never from `capabilities[key].state`, because
   * that state answers a question about the *device* and this group is about
   * *Yonder*: where the sensor will not turn the picture the board does,
   * after decoding, so `not-offered` — the bench camera's answer to all
   * three — must never reach `drawCapability()` here and become "this camera
   * has none" over a control that works. `buildOrientation()` below is the
   * branch, and `video/present.ts`'s own `deckOrientation()` is where that
   * reasoning is written down. */
  horizontalFlip: { group: 'orientation', kind: 'turn' },
  verticalFlip: { group: 'orientation', kind: 'turn' },
}

/** Every key `CAPABILITY_LAYOUT` assigns to a group, in the order it draws —
 * gate before the control it gates, matching the blueprint's own order. */
const GROUP_KEYS = {
  exposure: ['autoExposure', 'exposure', 'autoWhiteBalance', 'whiteBalance'],
  colour: ['brightness', 'contrast', 'saturation', 'hue'],
  optics: ['autoFocus', 'focus', 'zoom'],
  rendering: ['gamma'],
  // No `orientation` entry, deliberately: that group is built by
  // `buildOrientation()` from `report.orientation.turns`, in the order
  // `video/orientation.ts`'s own `FLIP_KEYS` gives, not from a second list of
  // the same three keys here that could quietly disagree with it about order
  // or membership. `buildGroup()` is never called for it.
  housekeeping: ['gain', 'backlightCompensation', 'sharpness', 'powerLineFrequency'],
}

const GROUP_LEGEND = {
  capture: 'Capture',
  stream: 'Stream',
  preview: 'Preview',
  exposure: 'Exposure',
  colour: 'Colour',
  optics: 'Optics',
  rendering: 'Rendering',
  orientation: 'Orientation',
  housekeeping: 'Housekeeping',
  outputs: 'Outputs',
}

/**
 * Fixed column assignment (the operator's own correction, carried from the
 * blueprint's `deck.js` round 2): each group always lands in the same visual
 * slot, so a group's own fields changing — Stream's Floor/Ceiling with its
 * link mode, Preview's ladder with Auto — changes that group's height only
 * and never moves another group between columns. Preview sits alone because
 * it is the tallest and most variable group.
 */
const SLOTS = [
  ['capture', 'stream'],
  ['preview'],
  ['exposure', 'colour'],
  ['optics', 'rendering', 'orientation', 'housekeeping'],
]

const PREVIEW_SIZE_OPTIONS = [
  { value: 'auto', label: 'Auto — steps with the link' },
  { value: '1280x720', label: '1280×720 — hold' },
  { value: '854x480', label: '854×480 — hold' },
  { value: '640x360', label: '640×360 — hold' },
]
const PREVIEW_RUNG_OPTIONS = [
  { value: '640x360', label: '640×360' },
  { value: '854x480', label: '854×480' },
  { value: '1280x720', label: '1280×720' },
]

/**
 * The four quarter-turns, and only those (R-CTL-05).
 *
 * The eight orientations a mount can need are these four and the two flips
 * that reach the other four — which is why this list is not eight entries
 * long and why a mirror is a switch of its own rather than more degrees
 * here. Degrees are written with the sign an operator reads, not `rotate`'s
 * bare integer: `video/descriptors.ts` gives `rotation` no unit because a
 * picker's own options carry it.
 */
const ROTATION_OPTIONS = [
  { value: '0', label: '0°' },
  { value: '90', label: '90°' },
  { value: '180', label: '180°' },
  { value: '270', label: '270°' },
]

const PREVIEW_RATE_OPTIONS = [
  { value: '30', label: '30 fps' },
  { value: '15', label: '15 fps' },
  { value: '10', label: '10 fps' },
]

/** `schema/config.ts`'s own `"fixed" | "adaptive"` <-> the blueprint's own
 * `"Fixed" | "Adaptive"` — the one conversion `appliedForDraft()` and the
 * two render methods that read a mode share, so it is written once. */
function toUiMode (schemaMode) {
  return schemaMode === 'adaptive' ? 'Adaptive' : 'Fixed'
}

/**
 * A bar's displayed precision, from its own step — never a value this file
 * invents. `15600`'s own step is `100` (an integer), so `stepPrecision`
 * reads `0` and the bar shows `15600`, not `15600.00`.
 */
function stepPrecision (step) {
  if (!Number.isFinite(step) || step <= 0 || Number.isInteger(step)) return 0
  const s = String(step)
  const i = s.indexOf('.')
  return i === -1 ? 0 : s.length - i - 1
}

/**
 * The seam between the draft's UI-facing paths and the two shapes this
 * report actually carries (Coordinator note, arrived mid-task): `values`,
 * flat and already keyed by capability name, and `applied.stream`/
 * `applied.preview`, nested and schema-cased. `draft.pending(camera,
 * applied)` wants one flat object; this builds it fresh from `payload`,
 * every time it is called — the caller (`pendingEdits` below) does the same,
 * asking at the moment it is rendering from the payload rather than caching
 * an answer from whenever the edit was staged, which is the whole point of
 * `pending`'s own read-time filtering (Task 21).
 *
 * **A `null` in `values` is dropped, not carried through as `null`.** A
 * control the camera did not report has nothing for a staged edit to be
 * equal to — keeping the key would only ever produce a `pending` comparison
 * against a value that means "unknown," never a real withdrawal the way a
 * matching number does. Dropping it is silent in the one case that matters:
 * a control the operator cannot see a reading for is not, today, one this
 * deck lets them draft either (every draftable path here is `stream*` /
 * `preview*` / `name`, never a capability key), so this never actually
 * discards a live edit — it is a property of the whole payload, and its own
 * test is here for when a caller is added that makes it matter.
 */
export function appliedForDraft (payload) {
  const flat = {}
  const values = (payload && payload.values) || {}
  for (const key of Object.keys(values)) {
    const v = values[key]
    if (v === null || v === undefined) continue
    flat[key] = v
  }
  /**
   * **The capture, under the three names the draft already uses for it.**
   * `DRAFT_PATHS` has carried `width`, `height` and `framerate` since it was
   * written and both conventions spell them the same, so no translation is
   * needed here — only the values, which this payload did not carry at all
   * until the Resolution and Frame rate pickers needed them. Without them
   * every staged size stayed pending for ever (nothing to compare against)
   * and `interruption()` warned "restarts the picture" even for the size
   * already running. `codec` travels for the same reason though nothing
   * stages it today: the schema allows one value, and a comparison that
   * silently lacked its side would be the same defect waiting for the second.
   */
  const capture = payload && payload.applied && payload.applied.capture
  if (capture) {
    flat.width = capture.width
    flat.height = capture.height
    flat.framerate = capture.framerate
    flat.codec = capture.codec
  }
  const stream = payload && payload.applied && payload.applied.stream
  if (stream) {
    flat.streamMode = toUiMode(stream.mode)
    flat.streamFloor = stream.floor_kbps
    flat.streamCeiling = stream.ceiling_kbps
    flat.streamBitrate = stream.bitrate_kbps
  }
  const preview = payload && payload.applied && payload.applied.preview
  if (preview) {
    flat.previewMode = toUiMode(preview.mode)
    flat.previewSize = preview.size
    flat.previewLadderBottom = preview.ladder_bottom
    flat.previewLadderTop = preview.ladder_top
    flat.previewFloor = preview.floor_kbps
    flat.previewCeiling = preview.ceiling_kbps
    flat.previewBitrate = preview.bitrate_kbps
    flat.previewRate = preview.framerate
  }
  if (payload && payload.camera && typeof payload.camera.name === 'string') {
    flat.name = payload.camera.name
  }
  return flat
}

export default {
  name: 'YonderDeck',
  inject: ['$socket', '$dataTracker'],
  props: {
    id: { type: String, required: true },
    props: { type: Object, default: () => ({}) },
    state: { type: Object, default: () => ({}) },
  },
  data () {
    return {
      draftStore: createDraftStore(),
      /** Bumped on every staged edit, applied or discarded — the reactive
       * dependency that tells Vue the plain `Map`s inside `draftStore` (never
       * reactive on their own) have changed. See `stage()`. */
      draftVersion: 0,
      /**
       * **Video or Photo — the browser's, not the device's** (blueprint
       * L-43).
       *
       * Which of the two the one shutter key is currently for. It is a state
       * of this page, exactly like which deck is showing: it changes nothing
       * on the aircraft, it is not configuration, it must not go through an
       * apply, and it does not survive a reload. A remount — a camera switch,
       * a Live/Setup flip — puts it back to Video, which is the mode an
       * operator watching a picture is in.
       *
       * The operator settled this. It is written here because the obvious
       * alternative — staging it on the draft beside the stream policy —
       * would have put a browser preference behind a confirmation window.
       */
      workMode: 'video',
      /**
       * A shutter press is in flight, awaiting the device's own answer
       * (`YonderShutter`'s own `pending`, §8.3).
       *
       * **This deck no longer guesses whether it is recording.** It held an
       * optimistic `recordingSince` — a local timestamp set by the press —
       * which lit the key whether or not anything started, and counted from
       * when the browser pressed rather than from when the board began.
       * R-UI-05 is that a control shows when it has *taken effect*: the key
       * now lights from `report.recorder.since`, the recorder's own answer,
       * and this flag covers only the round trip in between so a second press
       * cannot start a competing capture.
       */
      shutterPending: false,
      aimTransport: null,
      aimError: null,
    }
  },
  created () {
    this.$dataTracker(this.id)
    this.aimTransport = new AimTransport(() => this.report?.aim, (_rate, reason) => { this.aimError = reason })
    this.$socket.on?.('disconnect', this.aimDisconnect)
  },
  mounted () {
    // Task 21's own round trip: `yonder.draft` is Dashboard's client store,
    // which this component's own remounts do not clear — restoring into a
    // fresh `draftStore` here is what makes a draft survive the Live<->Setup
    // flip and the camera switch that remounts this component every time.
    const saved = this.$store && this.$store.state && this.$store.state.yonder
      ? this.$store.state.yonder.draft
      : null
    if (saved) this.draftStore.restore(saved)
  },
  beforeUnmount () { this.aimTransport?.close(); this.$socket.off?.('disconnect', this.aimDisconnect) },
  computed: {
    mode () {
      return this.props.mode === 'setup' ? 'setup' : 'live'
    },
    /**
     * The whole report, live in preference to configured — the same rule
     * every other widget in this package states for its own narrower slice
     * (`YonderFacts`'s own comment on `facts` says it first). There is no
     * sensible static fallback for a camera's whole capability report, so
     * `props.report` is a convenience for the gallery and a test, not a
     * promise that a real page shows anything before the first message.
     */
    report () {
      const live = this.$store && this.$store.state && this.$store.state.data
        ? this.$store.state.data.messages && this.$store.state.data.messages[this.id]
          ? this.$store.state.data.messages[this.id].payload
          : undefined
        : undefined
      if (live && typeof live === 'object') return live
      const fallback = this.props.report
      return fallback && typeof fallback === 'object' ? fallback : null
    },
    camera () {
      return (this.report && this.report.camera && this.report.camera.id) || ''
    },
    /**
     * What the recorder answered, or null (R-CAM-17, R-STO-06).
     *
     * `null` is a daemon with no video layer and is drawn as *nothing here
     * knows* rather than as *not recording*: the two are different facts and
     * an operator acts differently on each.
     */
    recorder () {
      const r = this.report && this.report.recorder
      return r && typeof r === 'object' ? r : null
    },
    /**
     * Which of the two the shutter is for, once the camera has been consulted
     * (blueprint L-43/L-44).
     *
     * `workMode` is what the operator chose; this is what the camera can
     * actually do about it. A camera that offers stills and no recorder is in
     * Photo whatever the control says — drawing a Record key over a
     * capability the report calls `not-offered` is the class of lie R-UI-20
     * exists to stop.
     */
    shutterMode () {
      if (this.report?.accessory) return this.report.accessory.state?.status?.mode ?? null
      const caps = this.report ? (this.report.capabilities || {}) : {}
      const has = (key) => Boolean(caps[key]) && caps[key].state !== 'not-offered'
      if (!has('recording')) return has('stills') ? 'photo' : null
      if (!has('stills')) return 'video'
      return this.workMode === 'photo' ? 'photo' : 'video'
    },
    /** The raw draft, unfiltered — `void this.draftVersion` is the line that
     * makes this recompute after `stage()`/`apply()`/`discard()`, since
     * `draftStore` itself holds plain `Map`s Vue cannot see into. */
    draft () {
      void this.draftVersion
      return this.report ? this.draftStore.get(this.camera) : {}
    },
    /** Built fresh from `report`, every time — never cached from when an
     * edit was staged. See `appliedForDraft()`'s own doc comment. */
    appliedFlat () {
      return this.report ? appliedForDraft(this.report) : {}
    },
    pendingEdits () {
      void this.draftVersion
      return this.report ? this.draftStore.pending(this.camera, this.appliedFlat) : []
    },
  },
  watch: {
    /**
     * A fresh report is the device's own answer, whatever it says.
     *
     * `shutterPending` is "a press is in flight" and nothing else, so the
     * next read of this camera ends it — a refused press and a successful one
     * both arrive as a report, and a flag cleared only on success would leave
     * the key dead for ever after a refusal.
     */
    report (now, before) {
      if (now?.aim?.generation !== before?.aim?.generation || now?.aim?.url !== before?.aim?.url) this.$refs.aimPad?.onEnd()
      this.shutterPending = false
      this.aimTransport?.refresh()
    },
  },
  methods: {
    aimDisconnect () { this.aimTransport?.stop(); this.$refs.aimPad?.onEnd() },
    nativeControl (command) { this.post({ nativeControl: command }) },
    hasDraft (path) {
      return Object.prototype.hasOwnProperty.call(this.draft, path)
    },
    /**
     * **The sentence that says a control is holding an edit.**
     *
     * `pendingEdits` and not `hasDraft`: the draft keeps a recorded value
     * whether or not it still differs from the applied one, and a control
     * whose staged value has since been applied is not pending — that is the
     * whole reason `pending` filters at read time.
     *
     * The blueprint carries this on every staged control
     * (`gallery/deck.js`: `reason: pending ? "Pending · apply on Setup" :
     * st.reason`). Without it the deck shows the staged value and nothing
     * says it is staged, so the only way to learn which controls are holding
     * an edit is to leave Live and read the list on Setup — which is exactly
     * the complaint that sent this back.
     */
    /**
     * The staged value, but only while it is still an edit.
     *
     * `hasDraft` is the raw draft and answers "was this recorded", which stays
     * true after the value has been applied — the store deliberately keeps the
     * entry and filters at read time. Driving a set bar's second mark from it
     * left the mark, and `YonderSetBar`'s own "Pending · apply on Setup" note
     * under it, on screen for ever after an apply: the operator applied a
     * change and the console went on saying it was waiting.
     */
    stagedValue (path) {
      return this.pendingEdits.some((e) => e.path === path)
        ? Number(this.draft[path])
        : null
    },
    stagedReason (path, fallback) {
      return this.pendingEdits.some((e) => e.path === path)
        ? 'Pending · apply on Setup'
        : (fallback || '')
    },
    draftValue (path, fallback) {
      return this.hasDraft(path) ? this.draft[path] : fallback
    },
    /**
     * A stream or preview policy edit — the confirmation-window half of the
     * defect fix. Recorded in `draftStore` only; nothing below this line
     * reaches `$socket`, by construction, the same guarantee `draft.ts`'s
     * own module comment states for `set()` itself.
     */
    stage (path, value) {
      this.draftStore.set(this.camera, path, value)
      this.persistDraft()
    },
    persistDraft () {
      this.draftVersion += 1
      if (!this.$store || !this.$store.state) return
      if (!this.$store.state.yonder) this.$store.state.yonder = {}
      this.$store.state.yonder.draft = this.draftStore.snapshot()
    },
    /** Every message this deck actually posts leaves through here — one
     * seam, so `deck.component.test.ts` can spy on exactly one thing. */
    post (payload) {
      this.$socket.emit('widget-action', this.id, { payload })
    },
    /**
     * An image control — the live-command half of the defect fix. Posts
     * immediately, through the socket, never the draft: this changes the
     * picture, not what leaves the aircraft.
     */
    setControl (key, value) {
      this.post({ control: key, value })
    },
    /**
     * **A turn goes where the turning happens** (R-CTL-05, R-CTL-15).
     *
     * The sensor's own flip is a live control: it goes to the device and
     * changes the picture, exactly like brightness. The board's is not — it
     * is a `videoflip` in the launch line, so it is a configuration change,
     * it restarts the picture, and it belongs on the staged draft behind an
     * Apply that can say so first.
     *
     * Shipped once with both going to `/controls`, and the operator found it
     * in minutes: on a camera whose sensor cannot turn its own picture — the
     * bench ELP answers no flip control at all — every press came back
     * *"this camera does not offer horizontalFlip"*. A refusal for something
     * Yonder can do, which is the worst answer of the three available.
     */
    turn (t, value) {
      if (t && t.by === 'sensor') { this.setControl(t.key, value); return }
      this.stage(t.key, value)
    },
    setMode (mode) {
      this.post({ mode })
    },
    /**
     * **The draft is not cleared here, and that is the fix.**
     *
     * It used to be — posted, then cleared, before the daemon had answered.
     * A refused apply (`POST /cameras/:id/apply` answers 400 with a
     * `problems` list, by design, so the page can mark the field) therefore
     * arrived at a browser that had already thrown away every staged edit:
     * nothing left to mark, and the operator retypes the lot.
     *
     * Nothing has to clear it. `draftStore.pending(camera, applied)` filters
     * at read time — an edit whose staged value now equals the applied one is
     * not pending — so a *successful* apply empties the pending block on its
     * own the moment the re-read lands, and a refused one leaves every edit
     * exactly where the operator left it. `discard()` is the only thing that
     * throws a draft away, which is the only thing that should.
     */
    apply () {
      this.post({ apply: this.draftStore.get(this.camera) })
    },
    discard () {
      this.draftStore.clear(this.camera)
      this.persistDraft()
      this.post({ discard: true })
    },
    toggleOutput (kind, enabled) {
      this.post({ output: kind, enabled })
    },
    /**
     * **The one key, pressed** (blueprint L-44).
     *
     * Three messages from one control, and which one it is comes from the
     * mode and from what the recorder says it is doing — never from a guess
     * this component is keeping. A press while recording is a stop; a press
     * in Photo is a still; anything else starts one.
     *
     * `shutterPending` is set here and cleared by the next report, so a
     * second press during the round trip sends nothing: §8.3 is explicit
     * that repeated presses must not launch competing captures, and the
     * device's own one-at-a-time guard answering `busy` is a refusal the
     * operator should never have had to see.
     */
    pressShutter () {
      if (this.shutterPending) return
      const mode = this.shutterMode
      if (mode === null) return
      this.shutterPending = true
      if (mode === 'photo') { this.post({ shutter: 'photo' }); return }
      this.post({ shutter: this.isRecording() ? 'stop' : 'record' })
    },
    /** What the *device* says, never what this page did last (R-UI-05). */
    isRecording () {
      return Boolean(this.recorder && this.recorder.recording
        && Number.isFinite(this.recorder.since))
    },
    /** The captures link beside the key (blueprint L-47) — a request for the
     * listing, which is what the panel draws. It reads nothing and changes
     * nothing on the aircraft; it asks the daemon what it is holding. */
    openCaptures () {
      this.post({ captures: 'read' })
    },
    setWorkMode (v) {
      if (this.report?.accessory) { this.nativeControl({ kind: 'mode', value: v === 'Photo' ? 0 : 1 }); return }
      this.workMode = v === 'Photo' ? 'photo' : 'video'
    },
    /** `advertised`/`gated`, in the one sentence every disabled control on
     * this page carries — `gated`'s own wording matches `capability.ts`'s
     * `summarise()` exactly (`"${by.label} has it"`), never a V4L2 name. */
    stateAndReason (cap) {
      if (cap.state === 'advertised') return { state: 'advertised', reason: cap.reason || '' }
      if (cap.state === 'gated') return { state: 'gated', reason: `${cap.by.label} has it` }
      return { state: cap.state, reason: '' }
    },
    /**
     * A key's heading. `descriptors[key].label` wins when there is one — it
     * is what `video/descriptors.ts` calls the control (`"Shutter"` for
     * `exposure`, `"Temperature"` for `whiteBalance`, two of the 21 that
     * differ from `LABELS`' own generic word) — and `LABELS` (also
     * `yonder-core`'s own, never a second copy) covers the rest: a
     * not-offered key, and the four capabilities that carry no
     * `ControlRange` and so never get a descriptor at all.
     */
    label (key) {
      const d = this.report.descriptors && this.report.descriptors[key]
      if (d && d.label) return d.label
      return LABELS[key] || key
    },
    /** R-UI-20: a capability the camera does not have (or does not draw a
     * control for on this page) is a fact where the control would have
     * been — never a control that cannot be used, never simply absent. */
    fact (key, label, reason) {
      return h('div', { class: 'y-deck__fact', key }, [
        h('span', { class: 'y-deck__fact-l' }, label),
        h('span', { class: 'y-deck__fact-v' }, reason || 'this camera has none'),
      ])
    },
    /**
     * One capability, drawn from `capabilities[key]` and nothing this file
     * assumes about the camera (R-CAM-14). `not-offered` is a fact and
     * nothing else; the two shutter kinds draw through their own branch
     * below rather than a `bar`/`pick`/`seg`, because neither is a bounded
     * value, a menu or a plain on/off. `capture` and `turn` never reach
     * here at all — `buildCaptureShape()` and `buildOrientation()` own
     * them, for reasons each states.
     */
    drawCapability (key) {
      const layout = CAPABILITY_LAYOUT[key]
      const r = this.report
      const cap = r.capabilities ? r.capabilities[key] : undefined
      const label = this.label(key)
      if (!cap || cap.state === 'not-offered') return this.fact(key, label, 'this camera has none')

      // `shutter` never reaches here: `buildCapture()` draws one key from
      // whichever of `recording`/`stills` the mode selects, because what is
      // drawn depends on a fact outside either key. The same reason `turn`
      // and `capture` have branches of their own.
      const { state, reason } = this.stateAndReason(cap)
      const descriptor = r.descriptors ? r.descriptors[key] : undefined
      const values = r.values || {}
      const commanded = r.commanded || {}
      const rawValue = values[key]

      if (layout.kind === 'bar') {
        const unit = (descriptor && descriptor.unit) || ''
        const min = descriptor ? descriptor.min : 0
        const max = descriptor ? descriptor.max : 100
        const step = descriptor ? descriptor.step : 1
        const actual = typeof rawValue === 'number' ? rawValue : (descriptor ? descriptor.current : 0)
        const cmd = commanded[key]
        return h(YonderSetBar, {
          key,
          label,
          unit,
          min,
          max,
          step,
          precision: stepPrecision(step),
          actual,
          commanded: typeof cmd === 'number' ? cmd : null,
          state,
          reason,
          onSet: (v) => this.setControl(key, v),
        })
      }
      if (layout.kind === 'pick') {
        // R-CAM-14: exactly the ids the probe listed, on `capabilities[key]`
        // itself — `descriptors` carries no `menu`, only the converted
        // numeric bounds, because a menu id is never a unit conversion.
        const menu = (cap.value && cap.value.menu) || []
        const options = menu.map((m) => ({ value: String(m.id), label: m.label }))
        const current = typeof rawValue === 'number' ? rawValue : (cap.value ? cap.value.current : '')
        return h(YonderPicker, {
          key,
          label,
          value: String(current),
          options,
          state,
          reason,
          onChange: (v) => this.setControl(key, Number(v)),
        })
      }
      if (layout.kind === 'seg') {
        const on = rawValue === true || rawValue === 1
        return h(YonderSegmented, {
          key,
          label,
          value: on ? 'On' : 'Off',
          options: ['Off', 'On'],
          state,
          reason,
          onChange: (v) => this.setControl(key, v === 'On'),
        })
      }
      return null
    },
    /**
     * **One shutter key, following the mode** (blueprint L-44, R-CAM-17,
     * R-CAM-18).
     *
     * It was two, always both drawn — a Record circle and a Photo circle
     * stacked — because `drawCapability()` was called once per capability and
     * each drew its own. The camera cannot do both at once, so two keys were
     * a lie about that; `YonderShutter` has taken a `mode` prop since it was
     * built and this is the caller finally composing it against the
     * blueprint rather than against the capability list.
     *
     * **The line under it is `yonder-core`'s sentence, not one composed
     * here** (L-45, L-46). `captureDestination()` states where a capture
     * lands and what the medium has left, in minutes in Video and in
     * photographs in Photo — the two differ in a unit and in nothing else,
     * which is exactly why they are one function. It falls back to the
     * capability's own medium where there is no recorder to ask, so a camera
     * page still says where a capture would go before a daemon with a video
     * layer has ever answered.
     *
     * `inhibited` is the reason the key will not act, or null — the key is
     * drawn either way (spec §4, R-UI-21): a camera that lists a recorder and
     * cannot use one keeps its key, marked, carrying the reason, because an
     * operator who cannot find Record at all has to work out whether the page
     * is broken or the camera cannot do it.
     */
    drawShutter (mode, cap) {
      const { state, reason } = this.stateAndReason(cap)
      const fallback = mode === 'video'
        ? ((cap.value && cap.value.medium === 'board') ? 'to this board' : "to the camera's card")
        : ((cap.value && cap.value.source === 'pipeline') ? 'to this board' : "to the camera's card")
      const destination = this.recorder === null
        ? fallback
        : captureDestination(this.recorder, mode)
      return h(YonderShutter, {
        key: 'shutter',
        mode,
        // From the recorder's own answer, so the elapsed time counts from
        // when the board began rather than from when this browser pressed —
        // and so a page opened after the recording started shows it running.
        recording: (mode === 'video' && this.isRecording())
          ? { since: this.recorder.since }
          : null,
        destination,
        pending: this.shutterPending,
        inhibited: state === 'present' ? null : reason,
        onRecord: () => this.pressShutter(),
        onPhoto: () => this.pressShutter(),
      })
    },
    /** Whether every key `CAPABILITY_LAYOUT` assigns to `groupId` reads
     * `not-offered` (or is filtered out entirely by `setupOnly` on Live) —
     * the "omit the whole group" half of R-UI-20, not merely drawing an
     * empty one (an empty box and an absent one say different things,
     * `YonderColumn`'s own reasoning). */
    nativeControls (group) {
      return (this.report.accessory?.controls || []).filter(d => d.group === group && d.key !== 'mode').map(d => {
        if (d.state === 'not-offered') return this.fact(d.key, d.label, d.reason)
        return h(YonderPicker, { key: d.key, label: d.label, value: d.value, options: d.options,
          state: d.state, reason: d.reason || '', onChange: value => {
            const selected = d.options.find(option => String(option.value) === String(value))
            if (selected && d.state === 'present') this.nativeControl(selected.command)
          } })
      })
    },
    buildNativeGroup (group) {
      const controls = this.nativeControls(group)
      return controls.length ? h(YonderColumn, { legend: GROUP_LEGEND[group], key: group }, () => controls) : null
    },
    buildNativeShape () {
      const native = this.report.accessory?.input?.native
      if (!native) return [this.fact('native', 'Native input', 'Waiting for SPS dimensions and camera frame clock')]
      const capture = this.report.policy.capture
      const sizes = ['1280x720', '854x480', '640x360'].filter(size => { const [w,h] = size.split('x').map(Number); return w <= native.width && h <= native.height })
      const rates = [30,25,24,20,15,10,5,1].filter(rate => rate <= Math.ceil(native.fps))
      return [this.fact('native', 'Native input', `${native.width}×${native.height} · ${native.fps.toFixed(2)} fps · fixed USB feed`),
        h(YonderPicker, { key: 'captureSize', label: 'Output resolution', value: `${this.draftValue('width', capture.width)}x${this.draftValue('height', capture.height)}`,
          options: sizes.map(value => ({ value, label: value.replace('x', '×') })), onChange: value => { const [w,h] = value.split('x').map(Number); this.stage('width', w); this.stage('height', h) } }),
        h(YonderPicker, { key: 'captureRate', label: 'Output frame rate', value: this.draftValue('framerate', capture.framerate), options: rates.map(value => ({ value: String(value), label: `${value} fps` })), onChange: value => this.stage('framerate', Number(value)) })]
    },
    buildGroup (groupId) {
      if (this.report?.accessory) return this.buildNativeGroup(groupId)
      const r = this.report
      const setup = this.mode === 'setup'
      const keys = (GROUP_KEYS[groupId] || []).filter((key) => {
        const layout = CAPABILITY_LAYOUT[key]
        return !(layout.setupOnly && !setup)
      })
      const anyPresent = keys.some((key) => {
        const cap = r.capabilities && r.capabilities[key]
        return cap && cap.state !== 'not-offered'
      })
      if (!anyPresent) return null
      return h(YonderColumn, { legend: GROUP_LEGEND[groupId], key: groupId }, () => keys.map((key) => this.drawCapability(key)))
    },
    /**
     * The Orientation group — **always drawn, on every camera** (R-CTL-05,
     * R-CTL-15).
     *
     * This is the one group that does not ask `capabilities[key].state` what
     * to draw, and the reason is the whole of `R-CTL-15`. The bench camera
     * answers `not-offered` to all three of `horizontal_flip`,
     * `vertical_flip` and `rotate`; that is true of the *device* and false of
     * *Yonder*, because `video/pipeline.ts` composes a `videoflip` for
     * exactly that camera. Read through `drawCapability()` the group would
     * print three sentences saying the camera cannot, over three controls
     * that work — so it is read through `report.orientation` instead, which
     * `video/present.ts` composed from `video/orientation.ts`'s own answer.
     *
     * **One line, beneath all three** — `orientation.says`, which names which
     * of the two would carry a turn asked for here and carries the
     * quarter-turn cost when the board is actually making one. It shipped
     * once as a sentence beside every control *and* a line under the group,
     * which put the same words on the page four times over; the capture is
     * what said so. `turn.says` is drawn only where the payload sets it,
     * which is only where the three controls genuinely disagree about who
     * carries them — the one case a single line cannot say.
     *
     * **The value is `turn.value`, whichever of the two holds it** — the
     * payload already decided that (see `DeckTurn.value`), so this method
     * never picks between `values` and `commanded` and cannot pick
     * differently from the sentence beside it.
     *
     * A report with no `orientation` block draws no group at all rather than
     * falling back to the capability states: falling back is what would put
     * the three "this camera has none" rows on the page again, quietly, the
     * day this field went missing.
     */
    buildOrientation () {
      const o = this.report.orientation
      if (!o || !Array.isArray(o.turns) || o.turns.length === 0) return null
      const children = o.turns.map((turn) => {
        const label = this.label(turn.key)
        if (turn.key === 'rotation') {
          return h(YonderPicker, {
            key: turn.key,
            label,
            // `null` is the schema's own "leave the camera alone", which is a
            // picture that is not rotated — the same reading `orientation()`
            // gives it — so it draws as 0°, never as an unmarked picker.
            value: String(turn.value === null || turn.value === undefined ? 0 : turn.value),
            options: ROTATION_OPTIONS,
            reason: turn.says || '',
            onChange: (v) => this.turn(turn, Number(v)),
          })
        }
        return h(YonderSegmented, {
          key: turn.key,
          label,
          value: turn.value === 1 ? 'On' : 'Off',
          options: ['Off', 'On'],
          reason: turn.says || '',
          onChange: (v) => this.turn(turn, v === 'On'),
        })
      })
      children.push(h('div', { class: 'y-deck__turnnote', key: 'note' }, o.says || ''))
      return h(YonderColumn, { legend: GROUP_LEGEND.orientation, key: 'orientation' }, () => children)
    },
    /**
     * Record, Photo and the captures count — **and no formats row**
     * (blueprint L-51).
     *
     * `CAPTURE FORMATS 10` drew here and the blueprint never drew it: a bare
     * count states a number where R-CAM-14 asks for the formats offered, and
     * leaving it beside a Stream column that now offers those same formats in
     * two pickers would say the same fact twice, once uselessly. See
     * `CAPABILITY_LAYOUT.formats`, which is where that key went.
     */
    buildCapture () {
      const r = this.report
      const recording = r.capabilities && r.capabilities.recording
      const stills = r.capabilities && r.capabilities.stills
      const has = (c) => Boolean(c) && c.state !== 'not-offered'
      if (!has(recording) && !has(stills)) return null
      const mode = this.shutterMode
      const children = []

      /**
       * **MODE, at the head of the column** (blueprint L-43).
       *
       * `YonderSegmented`, which is already this deck's control for a
       * two-way choice — not a second segmented control written for this one
       * page. Drawn only where there is a choice to make: a camera that
       * offers one of the two has no mode to be in, and a control whose
       * options are one is a control that cannot be used (R-UI-20).
       */
      if (has(recording) && has(stills)) {
        children.push(h(YonderSegmented, {
          key: 'workMode',
          // Tighter than the same control is elsewhere, and only here. Spec §5
          // puts the shutter key above the fold at 1440x900, and adding Mode at
          // the head of this column (L-43) put it seven pixels below one. The
          // room is taken from this control rather than from the key, which is
          // the thing that has to be reachable, and by a class rather than by
          // changing `YonderSegmented` — the image controls on the Setup deck
          // use the same component and are not short of room.
          class: 'y-deck__mode',
          label: 'Mode',
          options: ['Video', 'Photo'],
          state: r.accessory ? (r.accessory.controls?.find(d => d.key === 'mode')?.state || 'gated') : 'present',
          reason: r.accessory?.controls?.find(d => d.key === 'mode')?.reason || '',
          value: mode === 'photo' ? 'Photo' : 'Video',
          onChange: (v) => this.setWorkMode(v),
        }))
      }

      children.push(this.drawShutter(mode, mode === 'photo' ? stills : recording))

      /**
       * **Why a recording ended, when it ended by itself** (R-STO-06).
       *
       * Under the key rather than in a notification, because it is a fact
       * about this camera's medium and the operator's next press is right
       * here. Empty after a stop somebody pressed — see `endedWords()`.
       */
      const ended = endedWords(this.recorder)
      if (ended !== '') {
        children.push(h('div', { class: 'y-deck__ended', key: 'ended' }, ended))
      }

      /**
       * **`Captures (3) ›` — a link beside the key** (blueprint L-47).
       *
       * It was a `Captures · 0` readout lower in the column, which stated a
       * number and offered nothing to do about it. The count is the deck
       * payload's, composed by the daemon from the one listing the panel
       * itself draws, so the number beside the link and the number in the
       * panel cannot disagree.
       */
      if (r.accessory) {
        children.push(h('div', { class: 'y-deck__ended' }, this.recorder?.mediumReason || 'Camera card status unknown'))
        children.push(...this.nativeControls('capture'))
      } else {
      const count = (r.captures && typeof r.captures.count === 'number') ? r.captures.count : 0
      children.push(h('button', {
        type: 'button',
        class: 'y-deck__captures',
        key: 'captures',
        onClick: () => this.openCaptures(),
      }, `Captures (${count}) \u203a`))
      }

      return h(YonderColumn, { legend: GROUP_LEGEND.capture, key: 'capture' }, () => children)
    },
    /**
     * Stream and preview policy edits go to the draft, never the socket —
     * the other half of the defect fix. Every value drawn here comes from
     * `policy` (the deck's own current-value source, see this file's module
     * comment); every value staged goes through `stage()`, never
     * `setControl()`.
     */
    buildStream () {
      const r = this.report
      const policy = (r.policy && r.policy.stream) || {}
      const applied = r.applied && r.applied.stream
      const uiMode = this.draftValue('streamMode', toUiMode(policy.mode))
      const adaptive = uiMode === 'Adaptive'
      const setup = this.mode === 'setup'
      const children = []
      if (setup) {
        children.push(h(YonderTextField, {
          key: 'name',
          label: 'Name',
          value: this.draftValue('name', (r.camera && r.camera.name) || ''),
          placeholder: 'Cam 1',
          max: 24,
          hint: 'shown on this page, in the camera list and on the stream address',
          'onUpdate:value': (v) => this.stage('name', v),
        }))
      }
      children.push(h(YonderSegmented, {
        key: 'streamMode',
        reason: this.stagedReason('streamMode'),
        label: 'Bitrate',
        options: ['Fixed', 'Adaptive'],
        value: uiMode,
        onChange: (v) => this.stage('streamMode', v),
      }))
      if (adaptive) {
        children.push(h(YonderSetBar, {
          key: 'streamFloor',
          label: 'Floor',
          unit: 'kb/s',
          min: 100,
          max: 20000,
          step: 100,
          precision: 0,
          actual: policy.floor_kbps ?? 100,
          requested: this.stagedValue('streamFloor'),
          onSet: (v) => this.stage('streamFloor', v),
        }))
        children.push(h(YonderSetBar, {
          key: 'streamCeiling',
          label: 'Ceiling',
          unit: 'kb/s',
          min: 100,
          max: 20000,
          step: 100,
          precision: 0,
          actual: policy.ceiling_kbps ?? 20000,
          requested: this.stagedValue('streamCeiling'),
          onSet: (v) => this.stage('streamCeiling', v),
        }))
      }
      children.push(h(YonderSetBar, {
        key: 'streamBitrate',
        label: adaptive ? 'Going out' : 'Bitrate',
        unit: 'kb/s',
        min: 100,
        max: 20000,
        step: 100,
        precision: 0,
        actual: (applied && typeof applied.bitrate_kbps === 'number') ? applied.bitrate_kbps : (policy.bitrate_kbps ?? 0),
        readonly: adaptive,
        requested: adaptive ? null : this.stagedValue('streamBitrate'),
        onSet: adaptive ? undefined : (v) => this.stage('streamBitrate', v),
      }))
      // Beneath the bitrate bar, which is where spec §7 lists Resolution and
      // where the blueprint draws it — in this column and not in Capture,
      // because it is what leaves for the ground station.
      for (const child of this.buildCaptureShape()) children.push(child)
      return h(YonderColumn, { legend: GROUP_LEGEND.stream, qualifier: 'to the ground station', key: 'stream' }, () => children)
    },
    /**
     * **Resolution and Frame rate — two pickers, not one** (R-CAM-14,
     * R-VID-07, R-CTL-05; blueprint L-56 and its recorded divergence in
     * `docs/console/design/blueprint-manifest.md`).
     *
     * The blueprint draws a single combined picker reading `1280×720 · 30
     * fps`, and that works in the mock because its camera offers one rate per
     * size. The bench camera offers eight, at ten sizes: eighty rows, of
     * which eight in every ten differ only in a trailing number, read on a
     * page an operator reaches for while an aircraft is flying. Two pickers
     * is ten rows and eight, and mirrors the Size + Rate pair the Preview
     * column already has. **This is a deliberate departure from an approved
     * render, decided by the operator under CLAUDE.md rule 8** — written down
     * here and in the manifest, because a departure nobody wrote down is how
     * this console drifted from the blueprint in the first place.
     *
     * **Both menus are the device's own** (R-CAM-14). `captureSizes()` is
     * `yonder-core`'s, not a list composed here: it takes the first format
     * entry for each size, which is the entry `video/pipeline.ts` will
     * actually run, so this never offers a rate the pipeline would refuse.
     * The rate menu carries only the rates *that size* reported, which is the
     * whole reason the pair is two controls.
     *
     * **A staged pair this camera cannot make is said here, before Apply.**
     * `captureRefusal()` is the same function the apply route refuses with
     * and `refuse()` returns at compose time — one comparison, three callers.
     * A hand-edited `config.yaml` is the only way to reach the size branch,
     * since the picker offers nothing else; the rate branch is reachable by
     * choosing a size that does not make the rate now held.
     *
     * Drawn in both modes, as the blueprint draws it: `live.elp.night.png`
     * and `setup.elp.night.png` both carry it. Staging still changes nothing
     * until Apply — `stage()`, never `setControl()`, like everything else in
     * this column.
     */
    buildCaptureShape () {
      if (this.report?.accessory) return this.buildNativeShape()
      const r = this.report
      const cap = r.capabilities && r.capabilities.formats
      // The one state that draws no control: a camera that answered no format
      // has no menu to offer, and a picker over an empty list is a control
      // that cannot be used. The fact says so, in `fact()`'s own words.
      if (!cap || cap.state === 'not-offered') {
        return [this.fact('formats', 'Resolution', 'this camera has answered no capture format')]
      }
      const { state, reason } = this.stateAndReason(cap)
      const formats = cap.value || []
      const sizes = captureSizes(formats)
      const capture = (r.policy && r.policy.capture) || {}
      // **A report with no `capture` block draws a fact, not two pickers.**
      // `cameraDeck()` always composes one, so this is the older-daemon case —
      // and without it the pickers compose `NaNxNaN`, offer a menu nothing in
      // it is selected from, and say "this camera does not offer NaNxNaN". A
      // control that draws over a value it does not have is the failure this
      // whole deck was rewritten to remove.
      if (typeof capture.width !== 'number' || typeof capture.height !== 'number'
        || typeof capture.framerate !== 'number') {
        return [this.fact('formats', 'Resolution', 'this device has not said what it is capturing')]
      }
      const width = Number(this.draftValue('width', capture.width))
      const height = Number(this.draftValue('height', capture.height))
      const framerate = Number(this.draftValue('framerate', capture.framerate))
      const size = `${width}x${height}`
      const held = sizes.find((s) => s.size === size)
      const refusal = captureRefusal(formats, { width, height, framerate })
      // Which control the refusal belongs under, decided from the menus and
      // never by reading the sentence back — the same split the apply route
      // makes when it names the path a problem is about.
      const sizeWrong = held === undefined
      return [
        h(YonderPicker, {
          key: 'captureSize',
          label: 'Resolution',
          value: size,
          options: sizes.map((s) => ({ value: s.size, label: `${s.width}×${s.height}` })),
          state,
          reason: state !== 'present'
            ? reason
            : (sizeWrong ? refusal : this.stagedReason('width', this.stagedReason('height'))),
          // Two paths from one press, because a size is two schema leaves and
          // `DRAFT_PATHS` keeps them apart — the config has no `size` field to
          // stage, and inventing one here would be a fourteenth name for the
          // apply route to learn.
          onChange: (v) => {
            const [w, hgt] = String(v).split('x').map(Number)
            this.stage('width', w)
            this.stage('height', hgt)
          },
        }),
        h(YonderPicker, {
          key: 'captureRate',
          label: 'Frame rate',
          value: String(framerate),
          // Only the rates this size reported. Empty when the held size is one
          // the camera does not offer at all — there is no size to read rates
          // from, and the picker above is where that is said.
          options: (held ? held.rates : []).map((v) => ({ value: String(v), label: `${v} fps` })),
          state,
          reason: state !== 'present'
            ? reason
            : (sizeWrong ? '' : (refusal || this.stagedReason('framerate'))),
          onChange: (v) => this.stage('framerate', Number(v)),
        }),
      ]
    },
    buildPreview () {
      const r = this.report
      const policy = (r.policy && r.policy.preview) || {}
      const applied = r.applied && r.applied.preview
      const uiMode = this.draftValue('previewMode', toUiMode(policy.mode))
      const adaptive = uiMode === 'Adaptive'
      const size = this.draftValue('previewSize', policy.size || 'auto')
      const auto = size === 'auto'
      const children = []
      children.push(h(YonderSegmented, {
        key: 'previewMode',
        reason: this.stagedReason('previewMode'),
        label: 'Bitrate',
        options: ['Adaptive', 'Fixed'],
        value: uiMode,
        onChange: (v) => this.stage('previewMode', v),
      }))
      children.push(h(YonderPicker, {
        key: 'previewSize',
        reason: this.stagedReason('previewSize'),
        label: 'Size',
        value: size,
        options: PREVIEW_SIZE_OPTIONS,
        onChange: (v) => this.stage('previewSize', v),
      }))
      if (auto) {
        children.push(h(YonderPicker, {
          key: 'previewLadderBottom',
          label: 'Smallest automatic size',
          value: this.draftValue('previewLadderBottom', policy.ladder_bottom || '640x360'),
          options: PREVIEW_RUNG_OPTIONS,
          onChange: (v) => this.stage('previewLadderBottom', v),
        }))
        children.push(h(YonderPicker, {
          key: 'previewLadderTop',
          label: 'Largest automatic size',
          value: this.draftValue('previewLadderTop', policy.ladder_top || '1280x720'),
          options: PREVIEW_RUNG_OPTIONS,
          onChange: (v) => this.stage('previewLadderTop', v),
        }))
      }
      children.push(h(YonderPicker, {
        key: 'previewRate',
        reason: this.stagedReason('previewRate'),
        label: 'Rate',
        value: String(this.draftValue('previewRate', policy.framerate ?? 15)),
        options: PREVIEW_RATE_OPTIONS,
        onChange: (v) => this.stage('previewRate', Number(v)),
      }))
      if (adaptive) {
        children.push(h(YonderSetBar, {
          key: 'previewFloor',
          label: 'Floor',
          unit: 'kb/s',
          min: 100,
          max: 4000,
          step: 50,
          precision: 0,
          actual: policy.floor_kbps ?? 300,
          requested: this.stagedValue('previewFloor'),
          onSet: (v) => this.stage('previewFloor', v),
        }))
        children.push(h(YonderSetBar, {
          key: 'previewCeiling',
          label: 'Ceiling',
          unit: 'kb/s',
          min: 100,
          max: 4000,
          step: 50,
          precision: 0,
          actual: policy.ceiling_kbps ?? 2000,
          requested: this.stagedValue('previewCeiling'),
          onSet: (v) => this.stage('previewCeiling', v),
        }))
      }
      children.push(h(YonderSetBar, {
        key: 'previewBitrate',
        label: adaptive ? 'Going out' : 'Bitrate',
        unit: 'kb/s',
        min: 100,
        max: 4000,
        step: 50,
        precision: 0,
        actual: (applied && typeof applied.bitrate_kbps === 'number') ? applied.bitrate_kbps : (policy.bitrate_kbps ?? 0),
        readonly: adaptive,
        requested: adaptive ? null : this.stagedValue('previewBitrate'),
        onSet: adaptive ? undefined : (v) => this.stage('previewBitrate', v),
      }))
      return h(YonderColumn, { legend: GROUP_LEGEND.preview, qualifier: 'to this browser', key: 'preview' }, () => children)
    },
    buildOutputs () {
      const outputs = this.report.outputs
      if (!Array.isArray(outputs) || outputs.length === 0) return null
      const rows = outputs.map((o) => h('div', { class: 'y-deck__out', key: o.kind }, [
        h('span', { class: 'y-deck__out-l' }, o.label || o.kind),
        h(YonderSegmented, {
          options: ['Off', 'On'],
          value: o.enabled ? 'On' : 'Off',
          onChange: (v) => this.toggleOutput(o.kind, v === 'On'),
        }),
        h('span', { class: 'y-deck__out-cost' }, typeof o.costKbps === 'number' ? `${o.costKbps} kb/s` : ''),
        h('span', {
          class: ['y-deck__out-reach', { 'y-deck__out-reach--warn': o.reach && !o.reach.reachable }],
        }, (o.reach && o.reach.note) || ''),
      ]))
      return h(YonderColumn, { legend: GROUP_LEGEND.outputs, key: 'outputs' }, () => rows)
    },
    /**
     * The gimbal pad — Live only, beside the picture, never one of `SLOTS`
     * (the blueprint's own placement). `inhibited` is derived straight from
     * `capabilities.aim` — `present` is live, `advertised`/`gated` disable
     * the whole pad with the reason, and `not-offered` omits it entirely,
     * the same three-way split every other capability on this page draws.
     * Every `slew`/`stop` is relayed to the socket exactly as `YonderAimPad`
     * computed it (R-CMD-04: this deck relays, it never originates one).
     */
    buildAim () {
      if (this.mode !== 'live') return null
      const aim = this.report.capabilities && this.report.capabilities.aim
      if (!aim || aim.state === 'not-offered') return null
      const inhibited = aim.state === 'advertised'
        ? (aim.reason || 'not answering')
        : aim.state === 'gated'
          ? `${aim.by.label} has it`
          : (this.report.aim?.inhibited || null)
      return h('div', { class: 'y-deck__aim' }, [
        h('div', { class: 'y-deck__aim-h' }, 'Aim'),
        this.aimError ? h('div', { class: 'y-deck__ended' }, this.aimError) : null,
        !inhibited && this.report.aim?.directionalRefusals?.length ? h('div', { class: 'y-deck__ended' }, this.report.aim.directionalRefusals.join(' · ')) : null,
        this.report.aim?.admitted ? h('div', { class: 'y-deck__ended' }, `Admitted rate ${Math.hypot(this.report.aim.admitted.pan, this.report.aim.admitted.tilt).toFixed(1)} °/s`) : null,
        h(YonderAimPad, {
          ref: 'aimPad',
          axes: { pan: 'present', tilt: 'present', roll: 'advertised' },
          maxRate: this.report.aim?.maxRate ?? 30,
          inhibited,
          atLimit: this.report.aim?.atLimit || {},
          onSlew: (e) => this.report.aim?.url ? this.aimTransport.update(e) : this.post({ aim: { pan: e.pan, tilt: e.tilt, seq: e.seq, gesture: e.gesture } }),
          onStop: (e) => this.report.aim?.url ? this.aimTransport.stop() : this.post({ aim: { gesture: e.gesture, pan: 0, tilt: 0 } }),
        }),
      ])
    },
    /**
     * What is staged, what it would interrupt, and what the device refused.
     *
     * **The interruption is computed here, from this deck's own draft**
     * (`interruption()` in `yonder-core`, the same function the apply's own
     * answer carries). It used to be read off `report.interruption`, which
     * the daemon composes as `[]` and can only ever compose as `[]` — the
     * interruption a draft would cause is a fact about a draft that has not
     * been sent, and the daemon has never seen it. So the warning spec §8.1
     * asks for *before* Apply is pressed could not appear, while two doc
     * comments said it did. Translating the flat draft and the flat applied
     * values through `deckDraft()` is what lets one function serve both
     * sides, rather than a second copy of §8.1's table living here.
     *
     * **A refusal's problems are shown beside the field each names.**
     * `POST /cameras/:id/apply` answers them keyed by schema path;
     * `draftPathFor()` is the reverse of the seam above, so
     * `preview.floor_kbps` finds the `previewFloor` row it belongs to. One
     * the deck cannot place is still drawn, on its own row with its path, so
     * a problem is never silently dropped.
     *
     * **Two conditions before any of them is drawn, and both are about what
     * a refusal actually is.** A refusal is a fact about *one camera's* draft:
     *
     * - `problemsFor` must name the camera on screen. The stash the flow
     *   keeps is per device, not per camera, and without this a problem left
     *   by camera A landed on camera B's matching staged path —
     *   `previewFloor` reading "the floor is above the ceiling" beside a
     *   perfectly valid value.
     * - something must still be staged. With the draft discarded there is
     *   nothing left for a problem to be about, and the block was drawing a
     *   red sentence under a `Pending changes · 0` header. This is the rule
     *   rather than a flag some other path has to remember to clear: the
     *   draft going away *is* the refusal ceasing to apply.
     */
    buildPending () {
      if (this.mode !== 'setup') return null
      const pending = this.pendingEdits
      const mine = this.report.problemsFor === this.camera
      const problems = (mine && pending.length > 0 && Array.isArray(this.report.problems))
        ? this.report.problems
        : []
      const stops = interruption(
        deckDraft(this.draft).draft,
        deckDraft(this.appliedFlat).draft,
      )
      if (pending.length === 0 && stops.length === 0) return null
      const placed = new Set()
      const problemFor = (path) => {
        const found = problems.find((p) => draftPathFor(String(p && p.path)) === path)
        if (found) placed.add(found)
        return found
      }
      const rows = pending.map((p) => {
        const problem = problemFor(p.path)
        return h('div', { class: 'y-deck__pending-row', key: p.path }, [
          h('span', { class: 'y-deck__pending-path' }, p.path),
          h('span', { class: 'y-deck__pending-val' }, String(p.requested)),
          ...(problem ? [h('span', { class: 'y-deck__pending-why' }, problem.message)] : []),
        ])
      })
      const loose = problems.filter((p) => !placed.has(p))
      return h('div', { class: 'y-deck__pending' }, [
        h('div', { class: 'y-deck__pending-h' }, `Pending changes · ${pending.length}`),
        ...rows,
        ...loose.map((p, i) => h('div', { class: 'y-deck__pending-row', key: 'why' + i }, [
          h('span', { class: 'y-deck__pending-path' }, String(p.path)),
          h('span', { class: 'y-deck__pending-why' }, String(p.message)),
        ])),
        ...stops.map((s, i) => h('div', { class: 'y-deck__interrupt', key: 'int' + i }, s)),
      ])
    },
    buildRail () {
      const setup = this.mode === 'setup'
      const pendingCount = this.pendingEdits.length
      const keys = [
        h('button', {
          type: 'button',
          class: ['y-deck__key', { on: !setup }],
          onClick: () => this.setMode('live'),
        }, 'Live'),
        h('button', {
          type: 'button',
          class: ['y-deck__key', { on: setup }],
          onClick: () => this.setMode('setup'),
        }, (!setup && pendingCount) ? `Setup · ${pendingCount}` : 'Setup'),
      ]
      if (setup) {
        // Not disabled at zero pending — the blueprint's own rail never
        // gated these two either, and either one is a harmless no-op
        // against an empty draft rather than a state worth guarding.
        keys.push(h('button', {
          type: 'button',
          class: 'y-deck__key',
          onClick: () => this.discard(),
        }, 'Discard'))
        keys.push(h('button', {
          type: 'button',
          class: ['y-deck__key', 'y-deck__key--warn'],
          onClick: () => this.apply(),
        }, 'Apply'))
      }
      return h('div', { class: 'y-deck__rail' }, keys)
    },
  },
  render () {
    const r = this.report
    if (!r) {
      return h('div', { class: 'y-deck y-deck--empty' }, "Waiting for this camera's report.")
    }
    const cam = r.camera || {}
    const slots = SLOTS
      .map((ids) => ids.map((id) => {
        if (id === 'capture') return this.buildCapture()
        if (id === 'stream') return this.buildStream()
        if (id === 'preview') return this.buildPreview()
        if (id === 'orientation') return this.buildOrientation()
        return this.buildGroup(id)
      }).filter(Boolean))
      .filter((slot) => slot.length > 0)

    return h('div', { class: ['y-deck', 'y-deck--' + this.mode] }, [
      h(YonderPlacard, { kind: 'Camera', name: cam.name || '', unit: cam.spec || '' }),
      this.buildPending(),
      this.buildAim(),
      h('div', { class: 'y-deck__cols' }, slots.map((slot, i) => h('div', { class: 'y-deck__slot', key: i }, slot))),
      this.buildOutputs(),
      this.buildRail(),
    ])
  },
}
</script>

<style scoped>
.y-deck {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-family: var(--yonder-font, system-ui, sans-serif);
    background: var(--yonder-pane, #090d12);
    color: var(--yonder-value, #ffffff);
}
.y-deck--empty {
    padding: 24px;
    color: var(--yonder-label, #7f8a95);
}
.y-deck__fact {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 4px 16px;
    font-size: 13px;
}
.y-deck__fact-l {
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    min-width: 90px;
}
.y-deck__fact-v { color: var(--yonder-neutral, #7d7869); }
/* The line under Mirror, Flip and Rotation saying what is being done to the
   picture (R-CTL-15) — the blueprint's own `.d-modenote`, to its own figures.
   The label tone, not the caution one: a real pipeline element with a real
   cost is a fact, not a warning. */
.y-deck__turnnote {
    font-size: 11px;
    color: var(--yonder-label, #7f8a95);
    margin-top: 2px;
}
/* A link, not a readout (blueprint L-47). The blueprint draws it beside the
   shutter key in the deck's own type, and it opens the panel that lists what
   the count is about. */
.y-deck__captures {
    /* Centred under the key it belongs to, which is itself centred. `margin:
       auto` rather than `align-self`, because the column this lands in is not
       a flex container and `align-self` there does nothing at all — which is
       what it did. */
    display: block;
    margin: 4px auto 0;
    padding: 6px 9px;
    border: 0;
    background: transparent;
    font: inherit;
    font-size: 11px;
    letter-spacing: 0.06em;
    color: var(--yonder-select, #2ad4f0);
    cursor: pointer;
}
.y-deck__captures:hover { text-decoration: underline; }

/* See the note beside `y-deck__mode` above: the shutter key has to clear the
   fold at 1440x900, and this is where the room comes from. */
/* The room the shutter needs to clear the fold comes from this control's own
   height — never from the gap beneath it. A negative margin here took the eight
   pixels back by pulling the key up over the `Video | Photo` buttons, which is
   not saving space, it is hiding a control behind another one. */
.y-deck__mode :deep(.y-seg__btn) { min-height: 26px; }
.y-deck__mode :deep(.y-seg__label) { margin-bottom: 3px; }
/* R-STO-06: a recording that ended by itself, said where the next press is.
   The caution tone, because it is a thing that happened to the operator
   rather than a thing they did. */
.y-deck__ended {
    font-size: 11px;
    line-height: 1.4;
    color: var(--yonder-waiting, #ffcf28);
    padding: 4px 0;
    text-align: center;
}
/* Fixed slots (SLOTS above), never a CSS-flow column: each holds whatever
   groups it was assigned, in a fixed vertical order, and nothing moves
   between slots when one group's own height changes. */
.y-deck__cols {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    flex-wrap: wrap;
}
.y-deck__slot {
    display: flex;
    flex-direction: column;
    /* 220, not 252: the blueprint's own figure (`gallery.css` `.d-cols__slot`).
       At 252 a fourth slot does not fit a 1280-wide page and wraps under the
       first, which is how this deck came to photograph as three columns and a
       stray — the four-column shape `SLOTS` declares only appeared at 1440. */
    min-width: 220px;
    flex: 1 1 252px;
    /* The rule between columns, which the blueprint draws and this did not.
       Not decoration: four unruled columns of label/value pairs read as one
       field of text, and the eye has nothing to tell it which qualifier —
       *to the ground station*, *to this browser* — governs which reading.

       Longhand, not the `border-left` shorthand: jsdom does not resolve custom
       properties, so a shorthand carrying `var(--yonder-divider)` fails to
       parse there and the width reads as something else entirely — which is
       how the first version of this rule passed a test asserting 1px while
       computing 16. Written this way the width and style are readable
       whatever the colour resolves to. */
    border-left-width: 1px;
    border-left-style: solid;
    border-left-color: var(--yonder-divider, #2b333c);
}
.y-deck__slot:first-child {
    border-left-width: 0;
}
.y-deck__aim {
    padding: 10px 16px 0;
}
.y-deck__aim-h {
    font-size: 10.5px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    margin-bottom: 8px;
}
.y-deck__out {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 0;
    font-size: 12px;
}
.y-deck__out + .y-deck__out { border-top: 1px solid var(--yonder-divider, #2b333c); }
.y-deck__out-l { min-width: 110px; color: var(--yonder-value, #ffffff); }
.y-deck__out-cost {
    font-variant-numeric: tabular-nums;
    text-transform: none;
    color: var(--yonder-label, #7f8a95);
}
.y-deck__out-reach { color: var(--yonder-label, #7f8a95); font-size: 11px; }
.y-deck__out-reach--warn { color: var(--yonder-waiting, #ffcf28); }
.y-deck__pending {
    margin: 0 16px;
    padding: 8px 10px;
    border: 1px solid var(--yonder-select, #2ad4f0);
    border-radius: 3px;
}
.y-deck__pending-h {
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--yonder-select, #2ad4f0);
    margin-bottom: 6px;
}
.y-deck__pending-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 10px;
    font-size: 12px;
    padding: 2px 0;
}
.y-deck__pending-why {
    flex-basis: 100%;
    color: var(--yonder-bad, #ff4034);
    font-size: 11px;
}
.y-deck__interrupt {
    font-size: 11px;
    color: var(--yonder-waiting, #ffcf28);
    padding-top: 4px;
}
.y-deck__rail {
    display: flex;
    flex-wrap: wrap;
    border-top: 1px solid var(--yonder-divider, #2b333c);
    background: var(--yonder-pane, #090d12);
}
.y-deck__key {
    flex: 0 0 auto;
    min-width: 8rem;
    min-height: 34px;
    padding: 7px 6px;
    border: 0;
    border-right: 1px solid var(--yonder-divider, #2b333c);
    background: transparent;
    font: inherit;
    font-family: var(--yonder-font-mono, ui-monospace, monospace);
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--yonder-label, #7f8a95);
    cursor: pointer;
}
.y-deck__key:disabled { cursor: not-allowed; opacity: 0.5; }
.y-deck__key.on {
    color: var(--yonder-value, #ffffff);
    background: var(--yonder-raised, rgba(255, 255, 255, 0.06));
    box-shadow: inset 0 2px 0 var(--yonder-select, #2ad4f0);
}
.y-deck__key--warn { color: var(--yonder-irreversible, #f03fce); }
</style>
