<!-- DRAFT — a maximum width, and it never stretches to its container. -->
<template>
  <div class="d-field" :class="'is-' + state">
    <span v-if="label" class="d-lbl">{{ label }}</span>
    <div class="d-seg" role="group">
      <button v-for="o in options" :key="o" type="button" class="d-seg__b"
              :class="{ on: o === value }" :disabled="state !== 'present'">{{ o }}</button>
    </div>
    <div v-if="reason" class="d-why" :class="'why-' + state">{{ reason }}</div>
  </div>
</template>
<script>
export default {
  name: 'DraftSegmented',
  props: {
    label: { type: String, default: '' },
    options: { type: Array, default: () => [] },
    value: { type: String, default: '' },
    state: { type: String, default: 'present' },
    reason: { type: String, default: '' }
  }
}
</script>
<style scoped>
.d-lbl { display:block; font-size:9.5px; letter-spacing:.11em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); margin-bottom:4px; }
/* The rule this object exists to keep. */
.d-seg { display:flex; gap:4px; max-width:264px; }
.d-seg__b { flex:0 1 auto; min-width:62px; font: inherit; font-size:10px; font-weight:500;
  letter-spacing:.04em; padding:7px 12px; cursor:pointer; border-radius:2px;
  border:1px solid var(--yonder-divider,#2b333c); background:transparent;
  color: var(--yonder-label,#7f8a95); }
.d-seg__b.on { border-color: var(--yonder-select,#2ad4f0); color: var(--yonder-select,#2ad4f0);
  background: color-mix(in srgb, var(--yonder-select,#2ad4f0) 12%, transparent); }
.is-advertised .d-seg__b { border-color: var(--yonder-waiting,#ffcf28); color: var(--yonder-waiting,#ffcf28);
  cursor:not-allowed; }
.is-gated .d-seg__b { border-style:dashed; cursor:not-allowed; }
.d-why { font-size:10px; margin-top:4px; }
.why-advertised { color: var(--yonder-waiting,#ffcf28); }
.why-gated { color: var(--yonder-label,#7f8a95); }
</style>
