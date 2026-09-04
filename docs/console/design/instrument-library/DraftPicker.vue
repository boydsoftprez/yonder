<!-- DRAFT — blueprint for the plan. Real tokens, no invented colour. -->
<template>
  <div class="d-field" :class="'is-' + state">
    <span class="d-lbl">{{ label }}</span>
    <button type="button" class="d-pick" :disabled="state !== 'present'">
      <span class="d-pick__v">{{ value }}</span>
      <span class="d-pick__car" aria-hidden="true">&#9662;</span>
    </button>
    <div v-if="reason" class="d-why" :class="'why-' + state">{{ reason }}</div>
  </div>
</template>
<script>
export default {
  name: 'DraftPicker',
  props: {
    label: { type: String, default: '' },
    value: { type: String, default: '' },
    /** present | advertised | gated */
    state: { type: String, default: 'present' },
    reason: { type: String, default: '' }
  }
}
</script>
<style scoped>
.d-lbl { display:block; font-size:9.5px; letter-spacing:.11em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); margin-bottom:4px; }
.d-pick { display:flex; width:100%; max-width:264px; align-items:center; justify-content:space-between; gap:10px;
  font: inherit; font-size:12.5px; text-align:left; cursor:pointer;
  padding:8px 10px; border-radius:2px;
  border:1px solid var(--yonder-divider,#2b333c);
  background: color-mix(in srgb, var(--yonder-value,#fff) 2%, transparent);
  color: var(--yonder-value,#fff); }
.d-pick__v { font-variant-numeric: tabular-nums; }
.d-pick__car { color: var(--yonder-select,#2ad4f0); font-size:9px; }
.is-advertised .d-pick { border-color: var(--yonder-waiting,#ffcf28); color: var(--yonder-waiting,#ffcf28);
  cursor:not-allowed; }
.is-advertised .d-pick__car { display:none; }
.is-gated .d-pick { color: var(--yonder-label,#7f8a95); cursor:not-allowed;
  border-style:dashed; background:transparent; }
.is-gated .d-pick__car { display:none; }
.d-why { font-size:10px; margin-top:4px; line-height:1.35; max-width:264px; }
.why-advertised { color: var(--yonder-waiting,#ffcf28); }
.why-gated { color: var(--yonder-label,#7f8a95); }
</style>
