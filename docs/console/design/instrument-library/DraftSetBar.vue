<!-- DRAFT — one track, two marks: where the device is, and what was asked for. -->
<template>
  <div class="d-field" :class="'is-' + state">
    <div class="d-top">
      <span class="d-lbl">{{ label }}</span>
      <span class="d-val">{{ shown }}<i v-if="unit">{{ unit }}</i></span>
    </div>
    <div class="d-trk">
      <i class="d-fill" :style="{ width: pct(actual) }" />
      <i v-if="showCommanded" class="d-cmd" :style="{ left: pct(commanded) }" />
      <i class="d-ptr" :style="{ left: pct(actual) }" />
    </div>
    <div v-if="fine" class="d-fine">{{ fine }}</div>
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
    actual: { type: Number, default: 0 },
    commanded: { type: Number, default: null },
    state: { type: String, default: 'present' },
    reason: { type: String, default: '' },
    fine: { type: String, default: '' },
    precision: { type: Number, default: 0 }
  },
  computed: {
    shown () { return this.state === 'gated' ? '——' : this.actual.toFixed(this.precision) },
    showCommanded () {
      return this.commanded !== null && this.commanded !== this.actual && this.state === 'present'
    }
  },
  methods: {
    pct (v) {
      if (v === null) return '0%'
      const span = this.max - this.min
      return span <= 0 ? '0%' : `${Math.max(0, Math.min(100, (100 * (v - this.min)) / span))}%`
    }
  }
}
</script>
<style scoped>
.d-top { display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.d-lbl { font-size:9.5px; letter-spacing:.11em; text-transform:uppercase; color: var(--yonder-label,#7f8a95); }
.d-val { font-size:13px; font-weight:600; font-variant-numeric: tabular-nums; color: var(--yonder-value,#fff); }
/* A unit is never uppercased. */
.d-val i { font-style:normal; font-weight:400; font-size:10px; color: var(--yonder-label,#7f8a95);
  text-transform:none; margin-left:4px; }
/* Fixed width. It never stretches to its column. */
.d-trk { position:relative; width:180px; height:9px; margin:6px 0 3px; border-radius:1px;
  background: var(--yonder-track,#161b21); cursor:pointer; }
.d-fill { position:absolute; inset:0 auto 0 0; border-radius:1px; background: var(--yonder-select,#2ad4f0); }
.d-ptr { position:absolute; top:-3px; width:2px; height:15px; margin-left:-1px;
  background: var(--yonder-value,#fff); }
.d-cmd { position:absolute; top:-4px; width:2px; height:17px; margin-left:-1px;
  background: var(--yonder-waiting,#ffcf28); }
.d-fine { font-size:9px; letter-spacing:.06em; color: var(--yonder-label,#7f8a95);
  font-variant-numeric: tabular-nums; }
.is-gated .d-trk { background:transparent; border:1px dashed var(--yonder-divider,#2b333c); cursor:not-allowed; }
.is-gated .d-fill, .is-gated .d-ptr { display:none; }
.is-gated .d-val { color: var(--yonder-label,#7f8a95); font-weight:400; }
.is-advertised .d-trk { background: color-mix(in srgb, var(--yonder-waiting,#ffcf28) 18%, transparent);
  cursor:not-allowed; }
.d-why { font-size:10px; margin-top:4px; line-height:1.35; }
.why-advertised { color: var(--yonder-waiting,#ffcf28); }
.why-gated { color: var(--yonder-label,#7f8a95); }
</style>
