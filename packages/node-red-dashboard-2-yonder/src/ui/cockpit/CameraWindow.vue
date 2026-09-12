<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<div class="camera-window" :style="windowStyle">
  <header
    class="camera-window__header"
    @pointerdown="beginGesture($event,'move')"
    @pointermove="moveGesture"
    @pointerup="endGesture"
    @pointercancel="endGesture"
    @lostpointercapture="endGesture"
  >
    <strong class="camera-window__label">{{ label }}</strong>
    <span v-if="stale&&stale.seconds>0" class="camera-window__age">{{ stale.text }}</span>
    <button
      type="button"
      class="camera-window__maximize"
      aria-label="Maximize camera window"
      title="Maximize"
      @click="$emit('maximize')"
    >⤢</button>
  </header>
  <div class="camera-window__body" :style="{ aspectRatio: String(aspect) }">
    <slot/>
  </div>
  <div
    class="camera-window__grip"
    role="button"
    tabindex="0"
    aria-label="Resize camera window"
    @pointerdown="beginGesture($event,'resize')"
    @pointermove="moveGesture"
    @pointerup="endGesture"
    @pointercancel="endGesture"
    @lostpointercapture="endGesture"
  ></div>
</div>
</template>
<script>
import { clampCameraWindow } from './camera-view.mjs'

export default {
  name: 'CameraWindow',
  /**
   * The camera's other form (R-FLT-29, K-68 — design decision 6): a small
   * window, draggable by its header and resizable from its corner grip,
   * holding the camera and only the camera — a plain default slot for the
   * picture (design decision 8: "There is no terrain thumbnail... The
   * window is the camera's, only"). This file never imports `YonderPicture`
   * or knows its props; the host composes it.
   *
   * **Holds no persisted state of its own.** `geometry` is owned by the host
   * (`YonderCockpit.vue`, persisted with the other display preferences,
   * R-FLT-25) and only ever changes through the `update:geometry` this
   * component emits — already clamped, so the host trusts it without
   * re-deriving the box/picture aspect a second time. The only reactive
   * data here is the gesture in progress, which does not outlive the drag.
   *
   * **One pointer-capture gesture at a time**, drag or resize, mirroring
   * `YonderPicture.vue`'s own `dragDown`/`dragMove`/`onDragEnd` shape (this
   * file's own sibling component in this directory): capture on
   * `pointerdown`, guard every later event on the captured pointer id, and
   * release defensively in `try/catch` since a browser can already have
   * dropped capture by the time a gesture ends. Move and resize share one
   * set of gesture fields rather than two, because only one can be active
   * at once — a second `pointerdown` before the first ends simply starts a
   * new gesture, the same "one active gesture" resolution `YonderPicture`'s
   * own doc comment gives for its identical guard.
   *
   * **The box is measured fresh at the start of every gesture**, not
   * cached across them: `getBoundingClientRect()` on `.pfd-camera-overlay`,
   * the PFD's dedicated scene layer, found via `closest()` rather than
   * assumed to be a direct parent. A `ResizeObserver` also re-clamps the
   * existing geometry when this scene changes because an MFD opens, closes,
   * stacks, or changes its split — events that do not necessarily resize the
   * browser window. The transient observer and gesture fields are local UI
   * state only; persisted geometry remains entirely host-owned.
   */
  props: {
    /** The picture's own aspect ratio (width/height) — the shape the
     * window keeps while it is resized. Not measured here: this component
     * never inspects its own slotted content, the same "holds no persisted
     * state"
     * boundary that keeps it ignorant of what the picture even is. */
    aspect: { type: Number, default: 16 / 9 },
    /** `{x,y,w}` as fractions of the containing box — see
     * `camera-view.mjs`'s own doc comment on `cameraWindowHome`. */
    geometry: { type: Object, required: true },
    label: { type: String, default: 'CAMERA' },
    /** `{seconds,text}` — `YonderPicture`'s own `stale` payload, verbatim.
     * Shown in the header only while `seconds>0` (R-VID-03), the same
     * boundary the footer label uses in full mode. */
    stale: { type: Object, default: () => ({ seconds: 0, text: '' }) }
  },
  emits: ['update:geometry', 'maximize'],
  data () {
    return {
      gestureKind: null,
      gesturePointerId: null,
      gestureStartX: 0,
      gestureStartY: 0,
      gestureStartGeometry: null,
      gestureBoxRect: null,
      gestureChromeFraction: 0,
      boxObserver: null
    }
  },
  computed: {
    windowStyle () {
      return {
        left: (this.geometry.x * 100) + '%',
        top: (this.geometry.y * 100) + '%',
        width: (this.geometry.w * 100) + '%'
      }
    }
  },
  watch: {
    // A stream can decode a different shape without changing the PFD's
    // dimensions. Re-clamp after Vue applies the new picture-body ratio, so
    // a window that was legal at the bottom in 16:9 remains wholly visible
    // when a 4:3 or portrait source arrives.
    aspect () {
      this.$nextTick(() => this.clampToBox())
    }
  },
  mounted () {
    this.clampToBox()
    window.addEventListener('resize', this.clampToBox)
    this.$nextTick(() => {
      const box = this.box()
      if (!box || typeof ResizeObserver === 'undefined') return
      this.boxObserver = new ResizeObserver(() => this.clampToBox())
      this.boxObserver.observe(box)
    })
  },
  beforeUnmount () {
    window.removeEventListener('resize', this.clampToBox)
    this.boxObserver?.disconnect()
  },
  methods: {
    box () {
      return this.$el.closest('.pfd-camera-overlay')
    },
    chromeFraction (rect) {
      const header = this.$el.querySelector('.camera-window__header')
      const body = this.$el.querySelector('.camera-window__body')
      const outerHeight = this.$el.getBoundingClientRect?.().height
      const bodyHeight = body?.getBoundingClientRect?.().height
      // Use the rendered outer-minus-body height where available: it counts
      // the fixed header *and* the window border, so containment means no
      // visible pixel is clipped. jsdom has no layout, where the header-only
      // fallback still gives focused geometry tests a useful measurement.
      const height = Number.isFinite(outerHeight) && Number.isFinite(bodyHeight) && outerHeight > bodyHeight
        ? outerHeight - bodyHeight
        : header?.getBoundingClientRect?.().height
      return Number.isFinite(height) && height > 0 ? height / rect.height : 0
    },
    /** The box the stored fractions actually have to fit, measured rather
     * than guessed (I4 of the whole-branch review). `clampCameraWindow` is
     * given no aspect at load time, because nothing has rendered and a
     * guessed shape is wrong in both directions — it bounded the window's
     * travel to the upper three quarters of a portrait scene, and let a
     * stored position hang off the bottom of a wide one. So the real bound
     * is applied here, on mount and whenever the box is resized, against
     * the same `getBoundingClientRect()` a gesture uses. Emits only when it
     * changes something, so a window already inside its box costs the host
     * nothing. */
    clampToBox () {
      const rect = this.box()?.getBoundingClientRect()
      if (!rect?.width || !rect?.height) return
      const clamped = clampCameraWindow(
        this.geometry,
        (rect.width / rect.height) / (this.aspect || 1),
        this.chromeFraction(rect)
      )
      if (clamped.x !== this.geometry.x || clamped.y !== this.geometry.y || clamped.w !== this.geometry.w) {
        this.$emit('update:geometry', clamped)
      }
    },
    beginGesture (event, kind) {
      // One active gesture at a time — see this file's own top-of-file doc
      // comment; a fresh press simply supersedes an unfinished one.
      if (event.button !== undefined && event.button !== 0) return
      // **A control inside the header is not a drag of the header.** The
      // header takes pointer capture on `pointerdown`, and a captured
      // pointer delivers its later `click` to the capturing element rather
      // than to the button under the finger — so the maximize control never
      // fired in a real browser, while a jsdom test that dispatches `click`
      // on the button directly could not see it (I1 of the whole-branch
      // review, reproduced in Chromium). Starting no gesture leaves capture
      // where it was and the button behaves like a button.
      if (event.target?.closest?.('button')) return
      const rect = this.box()?.getBoundingClientRect()
      if (!rect?.width || !rect?.height) return
      event.preventDefault()
      this.gestureKind = kind
      this.gesturePointerId = event.pointerId
      this.gestureStartX = event.clientX
      this.gestureStartY = event.clientY
      this.gestureStartGeometry = { ...this.geometry }
      this.gestureBoxRect = rect
      this.gestureChromeFraction = this.chromeFraction(rect)
      try { event.currentTarget?.setPointerCapture?.(event.pointerId) } catch { /* Leaving an uncaptured gesture stops. */ }
    },
    moveGesture (event) {
      if (this.gestureKind === null || event.pointerId !== this.gesturePointerId) return
      const rect = this.gestureBoxRect
      const dx = (event.clientX - this.gestureStartX) / rect.width
      const candidate = this.gestureKind === 'resize'
        ? { ...this.gestureStartGeometry, w: this.gestureStartGeometry.w + dx }
        : {
            ...this.gestureStartGeometry,
            x: this.gestureStartGeometry.x + dx,
            y: this.gestureStartGeometry.y + (event.clientY - this.gestureStartY) / rect.height
          }
      // The combined ratio clampCameraWindow needs — see camera-view.mjs's
      // own doc comment on `aspect` for why both the box's own pixel shape
      // and the picture's own aspect ratio are folded into one number here,
      // computed fresh from the gesture's own captured box rather than a
      // second DOM read.
      const combinedAspect = (rect.width / rect.height) / (this.aspect || 1)
      this.$emit('update:geometry', clampCameraWindow(candidate, combinedAspect, this.gestureChromeFraction))
    },
    endGesture (event) {
      if (event?.pointerId !== undefined && this.gesturePointerId !== null && event.pointerId !== this.gesturePointerId) return
      const pointerId = this.gesturePointerId
      this.gestureKind = null
      this.gesturePointerId = null
      this.gestureStartGeometry = null
      this.gestureBoxRect = null
      this.gestureChromeFraction = 0
      try { if (pointerId !== null && event?.currentTarget?.hasPointerCapture?.(pointerId)) event.currentTarget.releasePointerCapture(pointerId) } catch { /* Already released. */ }
    }
  }
}
</script>
