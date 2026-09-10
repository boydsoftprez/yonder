<!-- Interactive. Up to three marks on one track: where the device is, what was
     asked for and has not yet arrived, and — hollow, the third — what a Live
     edit has drafted but not applied. Drag or tap; it snaps to the driver's
     own step and clamps to its bounds. -->
<template>
  <div class="d-field" :class="'is-' + state">
    <div class="d-top">
      <span class="d-lbl">{{ label }}</span>
      <span class="d-val">{{ shown }}<i v-if="unit">{{ unit }}</i></span>
    </div>
    <div ref="trk" class="d-trk"
         @pointerdown="down" @pointermove="move" @pointerup="up"
         @pointercancel="up" @pointerleave="up">
      <i class="d-fill" :style="{ width: pct(displayed) }" />
      <i v-if="showCommanded" class="d-cmd" :style="{ left: pct(commanded) }" />
      <i v-if="state === 'present'" class="d-ptr" :style="{ left: pct(actual) }" />
      <i v-if="grabAt !== null" class="d-pend" :style="{ left: pct(grabAt) }"
         :aria-label="pending !== null ? 'requested' : 'set'" />
    </div>
    <div v-if="fine" class="d-fine">{{ fine }}</div>
    <div v-if="pending !== null" class="d-pend-note">Pending &middot; apply on Setup</div>
    <div v-if="reason" class="d-why" :class="'why-' + state">{{ reason }}</div>
  </div>
</template>
<script>
export default {
  name: 'DraftSetBar',
  props: {
    label: { type: String, default: '' },
    unit: { type: String, default: '' },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 100 },
    step: { type: Number, default: 1 },
    precision: { type: Number, default: 0 },
    /** What the device says it is now. */
    actual: { type: Number, default: 0 },
    /** What was asked for and has not arrived. null when they agree. */
    commanded: { type: Number, default: null },
    /** A Live edit not yet applied on Setup (§7). null when there is none. */
    pending: { type: Number, default: null },
    state: { type: String, default: 'present' },
    reason: { type: String, default: '' },
    fine: { type: String, default: '' }
  },
  emits: ['set'],
  data: () => ({ dragging: false }),
  computed: {
    shown () { return this.state === 'gated' ? '——' : this.actual.toFixed(this.precision) },
    displayed () { return this.state === 'present' ? this.actual : this.min },
    /* The handle sits at the pending value when there is one and at the
       device's value otherwise, so the bar always has exactly one thing
       that moves — never none, never two. */
    grabAt () {
      if (this.state !== 'present') return null
      return this.pending !== null ? this.pending : this.actual
    },
    showCommanded () {
      return this.state === 'present' && this.commanded !== null &&
        Math.abs(this.commanded - this.actual) > this.step / 2
    }
  },
  methods: {
    pct (v) {
      const span = this.max - this.min
      if (v === null || span <= 0) return '0%'
      return `${Math.max(0, Math.min(100, (100 * (v - this.min)) / span))}%`
    },
    from (e) {
      const r = this.$refs.trk.getBoundingClientRect()
      const f = r.width <= 0 ? 0 : Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
      const raw = this.min + f * (this.max - this.min)
      // The device's own step, not a step we invented. A picker that offered
      // a value the camera never named is the same mistake one layer up.
      const snapped = Math.round((raw - this.min) / this.step) * this.step + this.min
      return Math.max(this.min, Math.min(this.max, snapped))
    },
    down (e) {
      if (this.state !== 'present') return
      this.dragging = true
      this.$refs.trk.setPointerCapture?.(e.pointerId)
      this.$emit('set', this.from(e))
    },
    move (e) { if (this.dragging) this.$emit('set', this.from(e)) },
    up () { this.dragging = false }
  }
}
</script>
<style scoped>
.d-field { margin-bottom: 13px; }
.d-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.d-lbl { font-size:10.5px; letter-spacing:.11em; text-transform:uppercase; color: var(--yonder-label,#7f8a95); }
.d-val { font-size:14px; font-weight:600; font-variant-numeric: tabular-nums; color: var(--yonder-value,#fff); }
/* A token carrying a unit is never uppercased: MB/S would say megabytes. */
.d-val i { font-style:normal; font-weight:400; font-size:11px; text-transform:none;
  margin-left:4px; color: var(--yonder-label,#7f8a95); }
/* Fixed width. It never stretches to its column. */
.d-trk { position:relative; width:220px; height:10px; margin:9px 0 4px; border-radius:2px;
  background: var(--yonder-track,#161b21); cursor:pointer; touch-action:none;
  background-clip:padding-box; border:6px solid transparent; box-sizing:content-box; }
.d-trk:hover { outline:1px solid color-mix(in srgb, var(--yonder-select,#2ad4f0) 40%, transparent); }
/* **Exactly one mark may look draggable, and it is the requested one.**
   This bar used to fill the track to the device's value and end it in a tick.
   A filled track ending in a tick is the shape of a slider, and the hollow
   ring beside it is the shape of a thumb, so the operator met two things that
   looked grabbable and found that only one moved. He said so within a minute
   of using it. The behaviour was right; the drawing was not.

   So the readings now sit *below* the track as carets, where nothing invites
   a grab, and the fill is gone. What remains on the track is the one thing
   that is a request rather than a reading. */
.d-fill { display:none; }
.d-ptr { position:absolute; top:11px; width:0; height:0; margin-left:-4px;
  border-left:4px solid transparent; border-right:4px solid transparent;
  border-bottom:5px solid var(--yonder-value,#fff); pointer-events:none; }
.d-cmd { position:absolute; top:11px; width:0; height:0; margin-left:-5px;
  border-left:5px solid transparent; border-right:5px solid transparent;
  border-bottom:6px solid var(--yonder-waiting,#ffcf28); pointer-events:none; }
/* The one grabbable mark: solid, on the track, and large enough to read as a
   handle beside the carets that are not one. */
.d-pend { position:absolute; top:-3px; width:14px; height:14px; margin-left:-7px;
  border-radius:50%; border:2px solid var(--yonder-display,#04060a);
  background: var(--yonder-select,#2ad4f0); pointer-events:none;
  box-shadow:0 0 0 1px var(--yonder-select,#2ad4f0); }
.d-pend-note { font-size:10.5px; margin-top:4px; color: var(--yonder-select,#2ad4f0); }
.d-fine { font-size:10px; letter-spacing:.04em; color: var(--yonder-label,#7f8a95);
  font-variant-numeric: tabular-nums; }
.is-gated .d-trk { background:transparent; border:1px dashed var(--yonder-divider,#2b333c);
  cursor:not-allowed; }
.is-gated .d-trk:hover { outline:none; }
.is-gated .d-fill { display:none; }
.is-gated .d-val { color: var(--yonder-label,#7f8a95); font-weight:400; }
.is-advertised .d-trk { background: color-mix(in srgb, var(--yonder-waiting,#ffcf28) 18%, transparent);
  cursor:not-allowed; }
.is-advertised .d-trk:hover { outline:none; }
.d-why { font-size:11px; margin-top:4px; line-height:1.4; max-width:230px; }
.why-advertised { color: var(--yonder-waiting,#ffcf28); }
.why-gated { color: var(--yonder-label,#7f8a95); }
</style>
