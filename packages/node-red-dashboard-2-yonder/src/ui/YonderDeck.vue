<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<script>
import { h } from 'vue'
import YonderPlacard from './YonderPlacard.vue'
import YonderColumn from './YonderColumn.vue'
import YonderPicker from './YonderPicker.vue'
import YonderSegmented from './YonderSegmented.vue'
import YonderSetBar from './YonderSetBar.vue'
import YonderReadout from './YonderReadout.vue'
import YonderTextField from './YonderTextField.vue'
import YonderShutter from './YonderShutter.vue'
import YonderAimPad from './YonderAimPad.vue'
import { createDraftStore } from './draft.ts'
import { LABELS, deckDraft, draftPathFor, interruption } from 'yonder-core/presentation'

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
 * package) against all 21 real keys, so a capability with nowhere to go is a
 * fact this file has to state rather than a control silently missing.
 * `drawCapability()` reads a key's `state` straight off `capabilities[key]` —
 * `present` draws the control, `not-offered` draws a fact and nothing else,
 * `advertised`/`gated` draw the same control disabled, carrying the reason —
 * and never re-derives gating the way the blueprint's own mock `stateOf()`
 * does, because the real probe (`probe/camera.ts`'s `gateIfInactive`) has
 * already decided it by the time a report reaches this page.
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
 *   policy: { stream: { mode, floor_kbps, ceiling_kbps, bitrate_kbps },
 *             preview: { mode, size, ladder_bottom, ladder_top, floor_kbps,
 *                        ceiling_kbps, bitrate_kbps, framerate } },
 *   applied: { stream: <same shape as policy.stream>,
 *              preview: <same shape as policy.preview> },
 *   outputs: { kind, label, enabled, costKbps, reach: OutputReach }[],
 *   captures: { count },
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
 * the three that are not an image control at all and draw through their own
 * branch in `drawCapability()`: `formats`, `shutter-video`, `shutter-photo`.
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
  formats: { group: 'capture', kind: 'formats' },
  zoom: { group: 'optics', kind: 'bar' },
  focus: { group: 'optics', kind: 'bar' },
  exposure: { group: 'exposure', kind: 'bar' },
  whiteBalance: { group: 'exposure', kind: 'bar' },
  brightness: { group: 'colour', kind: 'bar' },
  contrast: { group: 'colour', kind: 'bar' },
  rotation: { group: 'orientation', kind: 'bar' },
  aim: { group: 'aim', kind: 'aim' },
  recording: { group: 'capture', kind: 'shutter-video' },
  stills: { group: 'capture', kind: 'shutter-photo' },
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
}

/** Every key `CAPABILITY_LAYOUT` assigns to a group, in the order it draws —
 * gate before the control it gates, matching the blueprint's own order. */
const GROUP_KEYS = {
  exposure: ['autoExposure', 'exposure', 'autoWhiteBalance', 'whiteBalance'],
  colour: ['brightness', 'contrast', 'saturation', 'hue'],
  optics: ['autoFocus', 'focus', 'zoom'],
  rendering: ['gamma'],
  orientation: ['rotation'],
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
      /** This deck's own optimistic guess at "is the shutter lit", toggled
       * by each press (§8.3's own model — the blueprint's `this.recording`
       * is exactly this, a local ref no report field drives). Reset by a
       * remount, which is what a camera switch or a Live<->Setup flip
       * already does to this whole component. */
      recordingSince: null,
    }
  },
  created () {
    this.$dataTracker(this.id)
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
  methods: {
    hasDraft (path) {
      return Object.prototype.hasOwnProperty.call(this.draft, path)
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
    pressShutter (kind) {
      if (kind === 'photo') {
        this.post({ shutter: 'photo' })
        return
      }
      if (this.recordingSince === null) {
        this.recordingSince = Date.now()
        this.post({ shutter: 'record' })
      } else {
        this.recordingSince = null
        this.post({ shutter: 'stop' })
      }
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
     * nothing else; `formats`/the two shutter kinds draw through their own
     * branch below rather than a `bar`/`pick`/`seg`, because none of the
     * three is a bounded value, a menu or a plain on/off.
     */
    drawCapability (key) {
      const layout = CAPABILITY_LAYOUT[key]
      const r = this.report
      const cap = r.capabilities ? r.capabilities[key] : undefined
      const label = this.label(key)
      if (!cap || cap.state === 'not-offered') return this.fact(key, label, 'this camera has none')

      if (layout.kind === 'formats') {
        if (cap.state !== 'present') return this.fact(key, label, this.stateAndReason(cap).reason)
        return h(YonderReadout, { key, rows: [{ label, value: (cap.value || []).length }] })
      }
      /**
       * **The key stays, whatever state the capability is in** — spec §4,
       * which every other kind on this deck already follows and this branch
       * did not: it fell back to a fact for anything but `present`, so a
       * camera that lists a recorder and cannot use one drew no Record key
       * at all. Only `not-offered` draws a fact (handled above, with every
       * other kind); `advertised` and `gated` draw the key inoperative,
       * carrying the reason. R-UI-26: the key is here, under the picture it
       * records, and not on a rail.
       */
      if (layout.kind === 'shutter-video' || layout.kind === 'shutter-photo') {
        const { state, reason } = this.stateAndReason(cap)
        return this.drawShutter(
          layout.kind === 'shutter-photo' ? 'photo' : 'video',
          cap,
          state === 'present' ? null : reason,
        )
      }

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
    /** `inhibited` is the reason the key will not act, or null. See
     * `drawCapability`'s own shutter branch, and `YonderShutter`'s own
     * `inhibited` prop for why the key is drawn either way. */
    drawShutter (kind, cap, inhibited = null) {
      const destination = kind === 'video'
        ? ((cap.value && cap.value.medium === 'board') ? 'this board' : "the camera's card")
        : ((cap.value && cap.value.source === 'pipeline') ? 'this board' : "the camera's card")
      const recording = (kind === 'video' && this.recordingSince !== null)
        ? { since: this.recordingSince }
        : null
      return h(YonderShutter, {
        key: 'shutter-' + kind,
        mode: kind === 'photo' ? 'photo' : 'video',
        recording,
        destination,
        inhibited,
        onRecord: () => this.pressShutter('video'),
        onPhoto: () => this.pressShutter('photo'),
      })
    },
    /** Whether every key `CAPABILITY_LAYOUT` assigns to `groupId` reads
     * `not-offered` (or is filtered out entirely by `setupOnly` on Live) —
     * the "omit the whole group" half of R-UI-20, not merely drawing an
     * empty one (an empty box and an absent one say different things,
     * `YonderColumn`'s own reasoning). */
    buildGroup (groupId) {
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
    buildCapture () {
      const r = this.report
      const recording = r.capabilities && r.capabilities.recording
      const stills = r.capabilities && r.capabilities.stills
      const formats = r.capabilities && r.capabilities.formats
      const anyPresent = [recording, stills, formats].some((c) => c && c.state !== 'not-offered')
      if (!anyPresent) return null
      const children = []
      if (formats) children.push(this.drawCapability('formats'))
      if (recording) children.push(this.drawCapability('recording'))
      if (stills) children.push(this.drawCapability('stills'))
      if (r.captures && typeof r.captures.count === 'number') {
        children.push(h('div', { class: 'y-deck__captures', key: 'captures' }, `Captures · ${r.captures.count}`))
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
          requested: this.hasDraft('streamFloor') ? Number(this.draft.streamFloor) : null,
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
          requested: this.hasDraft('streamCeiling') ? Number(this.draft.streamCeiling) : null,
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
        requested: (!adaptive && this.hasDraft('streamBitrate')) ? Number(this.draft.streamBitrate) : null,
        onSet: adaptive ? undefined : (v) => this.stage('streamBitrate', v),
      }))
      return h(YonderColumn, { legend: GROUP_LEGEND.stream, qualifier: 'to the ground station', key: 'stream' }, () => children)
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
        label: 'Bitrate',
        options: ['Adaptive', 'Fixed'],
        value: uiMode,
        onChange: (v) => this.stage('previewMode', v),
      }))
      children.push(h(YonderPicker, {
        key: 'previewSize',
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
          requested: this.hasDraft('previewFloor') ? Number(this.draft.previewFloor) : null,
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
          requested: this.hasDraft('previewCeiling') ? Number(this.draft.previewCeiling) : null,
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
        requested: (!adaptive && this.hasDraft('previewBitrate')) ? Number(this.draft.previewBitrate) : null,
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
          : null
      return h('div', { class: 'y-deck__aim' }, [
        h('div', { class: 'y-deck__aim-h' }, 'Aim'),
        h(YonderAimPad, {
          axes: { pan: 'present', tilt: 'present', roll: 'advertised' },
          inhibited,
          onSlew: (e) => this.post({ aim: { pan: e.pan, tilt: e.tilt, seq: e.seq, gesture: e.gesture } }),
          onStop: (e) => this.post({ aim: { gesture: e.gesture, pan: 0, tilt: 0 } }),
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
.y-deck__captures {
    font-size: 11px;
    color: var(--yonder-label, #7f8a95);
    padding: 4px 0;
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
    min-width: 252px;
    flex: 1 1 252px;
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
