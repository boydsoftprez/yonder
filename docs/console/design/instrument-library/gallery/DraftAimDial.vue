<!-- The dial from aim-and-bitrate.html option A, made to work.
     Drag sets a RATE. Let go and it stops. Absolute pointing was rejected
     there and the reason is 300 ms of lag: you aim at a picture that is
     already stale, overshoot, and correct against a picture that is stale
     again. -->
<template>
  <div class="d-aim">
    <svg width="132" height="132" viewBox="0 0 118 118" class="d-aim__dial"
         :class="{ live: pushing }"
         @pointerdown="down" @pointermove="move"
         @pointerup="up" @pointercancel="up" @pointerleave="up">
      <circle cx="59" cy="59" r="54" fill="none" :stroke="c.divider" stroke-width="1"/>
      <!-- crosshair, stopping short of the puck -->
      <g :stroke="c.divider" stroke-width="1">
        <path d="M59 8v37 M59 73v38 M8 59h37 M73 59h38"/>
      </g>
      <g :fill="c.label" font-size="7.5" font-family="ui-sans-serif,system-ui" letter-spacing=".8" text-anchor="middle">
        <text x="59" y="24">TILT +</text><text x="59" y="89">PAN</text>
        <text x="22" y="62">&#8722;</text><text x="96" y="62">+</text>
      </g>
      <!-- an axis that will not answer stays on the pad, struck and labelled -->
      <template v-if="axes.roll !== 'present'">
        <path d="M 26 96 A 49 49 0 0 0 92 96" fill="none" :stroke="c.waiting" stroke-opacity=".5" stroke-width="2.5" stroke-dasharray="3 4"/>
        <text x="59" y="116" text-anchor="middle" font-size="7.5" :fill="c.waiting" letter-spacing=".8" font-family="ui-sans-serif,system-ui">ROLL &#8212;</text>
      </template>
      <!-- the puck: where you are pushing, or the centre at rest -->
      <circle :cx="pushing ? px : 59" :cy="pushing ? py : 59" r="11" fill="none" :stroke="c.select" stroke-width="1" stroke-dasharray="2.5 2.5"/>
      <circle :cx="pushing ? px : 59" :cy="pushing ? py : 59" r="6.5" :fill="c.select" :stroke="c.display" stroke-width="1.5"/>
    </svg>

    <div class="d-aim__rows">
      <div class="d-blk">
        <span class="d-blk__h">Reported position</span>
        <div v-for="ax in axesShown" :key="ax.key" class="d-pos" :class="{ dead: ax.state !== 'present' }">
          <div class="d-row"><span class="l">{{ ax.label }}</span><span class="v">{{ ax.state === 'present' ? fmt(ax.value) + '°' : '——' }}</span></div>
          <div class="d-pos__trk">
            <i class="d-pos__zero" />
            <i v-if="ax.state === 'present'" class="d-pos__ptr" :style="{ left: pct(ax.value, ax.min, ax.max) }" />
          </div>
          <div class="d-pos__b"><span>{{ ax.min }}&deg;</span><span>0&deg;</span><span>+{{ ax.max }}&deg;</span></div>
        </div>
      </div>
      <div v-if="axes.pan === 'present' || axes.tilt === 'present'" class="d-blk">
        <span class="d-blk__h">Commanded rate</span>
        <div class="d-rate" :class="{ pushing }">{{ rateShown }}<i>&deg;/s</i></div>
        <div class="d-pos__b d-pos__b--rate"><span>0</span><i></i><span>{{ MAX }} &deg;/s</span></div>
      </div>
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
    MAX: () => MAX_RATE,
    /* The gimbal's own heading, so the white mark points where it looks. */
    bearing () { return Math.max(-180, Math.min(180, this.pan)) },
    rateShown () { return this.pushing ? this.rate.toFixed(0) : '0' },
    /* R-UI-09: a bounded quantity is drawn against its bounds. */
    axesShown () {
      return [
        { key: 'pan', label: 'Pan', value: this.pan, min: -180, max: 180, state: this.axes.pan },
        { key: 'tilt', label: 'Tilt', value: this.tilt, min: -90, max: 90, state: this.axes.tilt },
      ]
    }
  },
  methods: {
    fmt (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) },
    pct (v, lo, hi) { return `${Math.max(0, Math.min(100, (100 * (v - lo)) / (hi - lo)))}%` },
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
.d-aim__rows { flex:1; min-width:0; display:flex; flex-direction:column; gap:12px; margin-bottom:6px; }
.d-blk__h { display:block; font-size:12px; color: var(--yonder-label,#7f8a95); margin-bottom:8px; }
.d-pos__b--rate { justify-content:flex-start; gap:8px; align-items:center; }
.d-pos__b--rate i { width:18px; height:1px; background: var(--yonder-divider,#2b333c); }
.d-pos { margin-bottom:8px; }
.d-pos.dead .d-pos__trk { border:1px dashed var(--yonder-divider,#2b333c); background:transparent; }
.d-pos__trk { position:relative; height:6px; margin:4px 0 3px; border-radius:1px; background: var(--yonder-track,#161b21); }
.d-pos__zero { position:absolute; left:50%; top:-2px; width:1px; height:10px; background: var(--yonder-divider,#2b333c); }
.d-pos__ptr { position:absolute; top:-3px; width:2px; height:12px; margin-left:-1px; background: var(--yonder-value,#fff); }
.d-pos__b { display:flex; justify-content:space-between; font-size:10.5px; font-variant-numeric:tabular-nums;
  color: var(--yonder-label,#7f8a95); }
.d-rate { font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; color: var(--yonder-value,#fff); line-height:1.1; }
.d-rate.pushing { color: var(--yonder-select,#2ad4f0); }
.d-rate i { font-style:normal; font-weight:400; font-size:11px; text-transform:none; margin-left:4px; color: var(--yonder-label,#7f8a95); }
.d-row { display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:3px 0; }
.d-row .l { font-size:12px; letter-spacing:.1em; text-transform:uppercase;
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
