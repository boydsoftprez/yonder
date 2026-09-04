<!-- The dial from aim-and-bitrate.html option A, made to work.
     Drag sets a RATE. Let go and it stops. Absolute pointing was rejected
     there and the reason is 300 ms of lag: you aim at a picture that is
     already stale, overshoot, and correct against a picture that is stale
     again. -->
<template>
  <div class="d-aim">
    <svg width="160" height="160" viewBox="0 0 118 118" class="d-aim__dial"
         :class="{ live: pushing }"
         @pointerdown="down" @pointermove="move"
         @pointerup="up" @pointercancel="up" @pointerleave="up">
      <circle cx="59" cy="59" r="52" :fill="c.display" :stroke="c.divider" stroke-width="1"/>
      <circle cx="59" cy="59" r="44" fill="none" :stroke="c.track" stroke-width="1"/>
      <g :stroke="c.label" stroke-width="1.5" stroke-opacity=".7">
        <path d="M59 7v7 M59 104v7 M7 59h7 M104 59h7"/>
      </g>
      <g :stroke="c.divider" stroke-width="1.2">
        <path d="M22 22l5 5 M96 22l-5 5 M22 96l5-5 M96 96l-5-5"/>
      </g>
      <circle cx="59" cy="59" r="15" fill="none" :stroke="c.divider" stroke-width="1" stroke-dasharray="3 3"/>

      <!-- an axis that will not answer stays on the dial, struck and labelled,
           so a gimbal that half works is not read as one that does -->
      <template v-if="axes.roll !== 'present'">
        <path d="M 30 88 A 44 44 0 0 0 88 88" fill="none" :stroke="c.waiting"
              stroke-opacity=".55" stroke-width="3" stroke-dasharray="4 4"/>
        <text x="59" y="112" text-anchor="middle" font-size="8.5" :fill="c.waiting"
              letter-spacing="1">ROLL &#8212;</text>
      </template>

      <!-- where the gimbal actually is -->
      <g :transform="`rotate(${bearing} 59 59)`">
        <path d="M59 15 l-5 9 h10 z" :fill="c.value"/>
      </g>

      <!-- where you are pushing -->
      <template v-if="pushing">
        <line x1="59" y1="59" :x2="px" :y2="py" :stroke="c.select" stroke-width="3"/>
        <circle :cx="px" :cy="py" r="13" :fill="c.select" fill-opacity=".2" :stroke="c.select" stroke-width="2"/>
        <circle :cx="px" :cy="py" r="3.5" :fill="c.select"/>
      </template>
    </svg>

    <div class="d-aim__rows">
      <div class="d-row"><span class="l">Pan</span><span class="v">{{ fmt(pan) }}&deg;</span></div>
      <div class="d-row"><span class="l">Tilt</span><span class="v">{{ fmt(tilt) }}&deg;</span></div>
      <div class="d-row">
        <span class="l">Rate</span>
        <span class="v" :class="{ pushing }">{{ rateShown }}<i>&deg;/s</i></span>
      </div>
      <div class="d-fine">white &#9650; where it is<br>cyan where you push</div>
      <div v-if="atLimit" class="d-limit"><i></i>At the limit</div>
    </div>
  </div>
</template>
<script>
const R = 44          /* rim: full rate at the edge of the inner ring */
const DEAD = 15       /* the dashed centre: no command inside it */
const MAX_RATE = 30   /* deg/s at the rim */

export default {
  name: 'DraftAimDial',
  props: {
    pan: { type: Number, default: 0 },
    tilt: { type: Number, default: 0 },
    axes: { type: Object, default: () => ({ pan: 'present', tilt: 'present', roll: 'present' }) },
    atLimit: { type: Boolean, default: false },
    /** Palette, read from the page's custom properties by the parent. */
    c: { type: Object, required: true }
  },
  emits: ['slew', 'stop'],
  data: () => ({ pushing: false, px: 59, py: 59, rate: 0 }),
  computed: {
    /* The gimbal's own heading, so the white mark points where it looks. */
    bearing () { return Math.max(-180, Math.min(180, this.pan)) },
    rateShown () { return this.pushing ? this.rate.toFixed(0) : '0' }
  },
  methods: {
    fmt (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) },
    at (e) {
      const r = this.$el.querySelector('.d-aim__dial').getBoundingClientRect()
      const x = ((e.clientX - r.left) / r.width) * 118 - 59
      const y = ((e.clientY - r.top) / r.height) * 118 - 59
      const d = Math.hypot(x, y)
      if (d <= DEAD) return null
      const k = Math.min(1, (d - DEAD) / (R - DEAD))
      const ux = x / d, uy = y / d
      return { x: 59 + ux * Math.min(d, R), y: 59 + uy * Math.min(d, R),
               panRate: ux * k * MAX_RATE, tiltRate: -uy * k * MAX_RATE, k }
    },
    down (e) {
      this.$el.querySelector('.d-aim__dial').setPointerCapture?.(e.pointerId)
      this.pushing = true
      this.apply(e)
    },
    move (e) { if (this.pushing) this.apply(e) },
    apply (e) {
      const a = this.at(e)
      if (!a) { this.px = 59; this.py = 59; this.rate = 0; return }
      this.px = a.x; this.py = a.y
      this.rate = Math.hypot(a.panRate, a.tiltRate)
      this.$emit('slew', { pan: a.panRate, tilt: a.tiltRate })
    },
    /* Release stops it. A dial that kept slewing after release is a runaway
       gimbal on a laggy link, which is the whole reason rate beat position. */
    up () {
      if (!this.pushing) return
      this.pushing = false; this.rate = 0; this.px = 59; this.py = 59
      this.$emit('stop')
    }
  }
}
</script>
<style scoped>
.d-aim { display:flex; gap:12px; align-items:flex-start; }
.d-aim__dial { flex:0 0 auto; cursor:grab; touch-action:none; }
.d-aim__dial.live { cursor:grabbing; }
.d-aim__rows { flex:1; min-width:0; }
.d-row { display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:3px 0; }
.d-row .l { font-size:11px; letter-spacing:.1em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); }
.d-row .v { font-size:14px; font-weight:600; font-variant-numeric: tabular-nums;
  color: var(--yonder-value,#fff); }
.d-row .v.pushing { color: var(--yonder-select,#2ad4f0); }
.d-row .v i { font-style:normal; font-weight:400; font-size:10px; text-transform:none;
  margin-left:3px; color: var(--yonder-label,#7f8a95); }
.d-fine { font-size:10.5px; line-height:1.5; margin:6px 0 12px; color: var(--yonder-label,#7f8a95); }
.d-limit { margin-top:9px; display:inline-flex; align-items:center; gap:6px; font-size:11px;
  letter-spacing:.12em; text-transform:uppercase; padding:3px 7px; border-radius:2px;
  border:1px solid var(--yonder-waiting,#ffcf28); color: var(--yonder-waiting,#ffcf28); }
.d-limit i { width:5px; height:5px; border-radius:50%; background: var(--yonder-waiting,#ffcf28); }
</style>
