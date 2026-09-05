<!-- DRAFT — the Setup step that gives the aim guard its envelope (§8.7,
     R-CAM-11). One axis at a time, five degrees a step, the limit flag
     watched rather than assumed: this is the operator-directed procedure
     spec §15 requires in place of "an autonomous sweep or a hard-coded
     manufacturer's range". The flag here is a toggle standing in for the
     device's own push (byte 10 of gimbal/0x05, 20 Hz) — the bench's real
     signal, not something this page invents — so the operator watches it the
     same way they would watching telemetry, rather than the software
     deciding a bound from the angle alone.

     A step that would drive further into an already-lit limit is refused,
     the same rule the production guard applies (§8.7: "At a limit, refuse
     motion farther into it") — small enough to demonstrate here, and worth
     demonstrating, because it is the same rule twice rather than a special
     case invented for this page. -->
<template>
  <div class="d-rf">
    <p class="d-rf__intro">One axis at a time, five degrees a step. Move to where the limit flag lights, record that bound, and never a sweep — the envelope is what this procedure finds, not a figure from the manufacturer.</p>

    <div class="d-field">
      <span class="d-lbl">Axis</span>
      <div class="d-seg" role="group">
        <button v-for="a in AXES" :key="a" type="button" class="d-seg__b"
                :class="{ on: axis === a }" @click="selectAxis(a)">{{ label(a) }}</button>
      </div>
    </div>

    <div class="d-rf__pos">
      <span class="l">{{ label(axis) }} position</span>
      <span class="v">{{ fmt(position[axis]) }}&deg;</span>
    </div>
    <div class="d-rf__keys">
      <button type="button" class="d-recentre" :disabled="blocked(-1)" @click="step(-1)">&minus;5&deg;</button>
      <button type="button" class="d-recentre" :disabled="blocked(1)" @click="step(1)">+5&deg;</button>
      <button type="button" class="d-recentre" :class="{ 'd-recentre--flag': flag }" @click="flag = !flag">
        {{ flag ? 'Limit flag — lit' : 'Limit flag — clear' }}
      </button>
    </div>
    <div v-if="flag" class="d-limit"><i></i>At the limit</div>

    <button type="button" class="d-recentre d-recentre--soft d-rf__record"
            :disabled="!flag || recordedThisSide" @click="recordBound">
      Record this bound
    </button>

    <div class="d-rf__found">
      <div v-for="a in AXES" :key="a" class="d-row">
        <span class="l">{{ label(a) }} envelope</span>
        <span class="v">{{ foundText(a) }}</span>
      </div>
    </div>

    <button type="button" class="d-recentre d-recentre--soft d-rf__save"
            :disabled="!complete" @click="$emit('update:known', true)">
      {{ known ? 'Envelope recorded — save again' : 'Save envelope' }}
    </button>
    <div class="d-fine">recorded per mounting and mode, for this camera only</div>
  </div>
</template>
<script>
const AXES = ['pan', 'tilt']
const STEP = 5

export default {
  name: 'DraftRangeFinder',
  props: {
    /** Whether an envelope has already been saved for this camera. */
    known: { type: Boolean, default: false }
  },
  emits: ['update:known'],
  data () {
    return {
      AXES,
      axis: 'pan',
      position: { pan: 0, tilt: 0 },
      flag: false,
      // The last direction stepped, per axis — which side "record this
      // bound" fills. null until a step has been taken on that axis.
      lastDir: { pan: null, tilt: null },
      found: { pan: { min: null, max: null }, tilt: { min: null, max: null } }
    }
  },
  computed: {
    complete () {
      return AXES.every((a) => this.found[a].min !== null && this.found[a].max !== null)
    },
    recordedThisSide () {
      const dir = this.lastDir[this.axis]
      if (!dir) return false
      const f = this.found[this.axis]
      return dir < 0 ? f.min !== null : f.max !== null
    }
  },
  methods: {
    label (a) { return a === 'pan' ? 'Pan' : 'Tilt' },
    // The flag belongs to whichever axis is being driven right now — a stale
    // "lit" reading carried over from the axis you just left would credit a
    // bound to a position nobody has actually watched the limit at.
    selectAxis (a) { this.axis = a; this.flag = false },
    fmt (v) { return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0) },
    // The same rule the production guard applies: refuse a step that would
    // drive further into a limit already lit (§8.7).
    blocked (dir) { return this.flag && this.lastDir[this.axis] === dir },
    step (dir) {
      if (this.blocked(dir)) return
      this.position[this.axis] += dir * STEP
      this.lastDir[this.axis] = dir
      this.flag = false
    },
    recordBound () {
      if (!this.flag) return
      const dir = this.lastDir[this.axis]
      if (!dir) return
      if (dir < 0) this.found[this.axis].min = this.position[this.axis]
      else this.found[this.axis].max = this.position[this.axis]
    },
    foundText (a) {
      const f = this.found[a]
      if (f.min === null && f.max === null) return 'not run'
      return `${f.min === null ? '——' : this.fmt(f.min) + '°'} … ${f.max === null ? '——' : this.fmt(f.max) + '°'}`
    }
  }
}
</script>
<style scoped>
.d-rf { max-width: 252px; }
.d-rf__intro { font-size:11px; line-height:1.5; color: var(--yonder-label,#7f8a95); margin:0 0 13px; }
.d-field { margin-bottom:13px; }
.d-lbl { display:block; font-size:10.5px; letter-spacing:.11em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); margin-bottom:5px; }
.d-seg { display:flex; gap:4px; max-width:230px; }
.d-seg__b { flex:1 1 auto; min-width:58px; min-height:34px; font:inherit; font-size:11.5px; font-weight:500;
  letter-spacing:.04em; padding:0 12px; cursor:pointer; border-radius:3px;
  border:1px solid var(--yonder-divider,#2b333c); background:transparent;
  color: var(--yonder-label,#7f8a95); }
.d-seg__b.on { border-color: var(--yonder-select,#2ad4f0); color: var(--yonder-select,#2ad4f0);
  background: color-mix(in srgb, var(--yonder-select,#2ad4f0) 12%, transparent); }
.d-rf__pos { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:9px; }
.d-rf__pos .l { font-size:10.5px; letter-spacing:.11em; text-transform:uppercase; color: var(--yonder-label,#7f8a95); }
.d-rf__pos .v { font-size:16px; font-weight:600; font-variant-numeric:tabular-nums; color: var(--yonder-value,#fff); }
.d-rf__keys { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:9px; }
.d-rf__keys .d-recentre { margin-top:0; flex:0 0 auto; }
.d-recentre:disabled { opacity:.4; cursor:not-allowed; }
.d-recentre:disabled:hover { border-color: var(--yonder-divider,#2b333c); color: var(--yonder-value,#fff); }
.d-recentre--flag { border-color: var(--yonder-waiting,#ffcf28); color: var(--yonder-waiting,#ffcf28); }
.d-limit { margin:0 0 11px; display:inline-flex; align-items:center; gap:6px; font-size:11px;
  letter-spacing:.12em; text-transform:uppercase; padding:3px 7px; border-radius:2px;
  border:1px solid var(--yonder-waiting,#ffcf28); color: var(--yonder-waiting,#ffcf28); }
.d-limit i { width:5px; height:5px; border-radius:50%; background: var(--yonder-waiting,#ffcf28); }
.d-rf__record { width:100%; margin-bottom:16px; }
.d-rf__found { border-top:1px solid var(--yonder-divider,#2b333c); padding-top:10px; margin-bottom:13px; }
.d-row { display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:3px 0; font-size:12px; }
.d-row .l { font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color: var(--yonder-label,#7f8a95); }
.d-row .v { font-weight:600; font-variant-numeric:tabular-nums; color: var(--yonder-value,#fff); }
.d-rf__save { width:100%; }
.d-fine { font-size:10px; letter-spacing:.04em; color: var(--yonder-label,#7f8a95); margin-top:6px; }
</style>
