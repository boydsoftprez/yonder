<!-- Interactive. A maximum width, and it never stretches to its container. -->
<template>
  <div class="d-field" :class="'is-' + state">
    <span v-if="label" class="d-lbl">{{ label }}</span>
    <div class="d-seg" role="group">
      <button v-for="o in options" :key="o" type="button" class="d-seg__b"
              :class="{ on: o === modelValue }" :disabled="state !== 'present'"
              @click="pick(o)">{{ o }}</button>
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
    modelValue: { type: String, default: '' },
    state: { type: String, default: 'present' },
    reason: { type: String, default: '' }
  },
  emits: ['update:modelValue'],
  methods: {
    pick (o) { if (this.state === 'present') this.$emit('update:modelValue', o) }
  }
}
</script>
<style scoped>
.d-field { margin-bottom: 13px; }
.d-lbl { display:block; font-size:10.5px; letter-spacing:.11em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); margin-bottom:5px; }
.d-seg { display:flex; gap:4px; max-width:230px; }
.d-seg__b { flex:1 1 auto; min-width:58px; min-height:34px; font: inherit; font-size:11.5px; font-weight:500;
  letter-spacing:.04em; padding:0 12px; cursor:pointer; border-radius:3px;
  border:1px solid var(--yonder-divider,#2b333c); background:transparent;
  color: var(--yonder-label,#7f8a95); transition: none; }
.d-seg__b:hover:not(:disabled) { border-color: var(--yonder-label,#7f8a95); color: var(--yonder-value,#fff); }
.d-seg__b.on { border-color: var(--yonder-select,#2ad4f0); color: var(--yonder-select,#2ad4f0);
  background: color-mix(in srgb, var(--yonder-select,#2ad4f0) 12%, transparent); }
.d-seg__b:disabled { cursor:not-allowed; }
.is-advertised .d-seg__b { border-color: var(--yonder-waiting,#ffcf28); color: var(--yonder-waiting,#ffcf28); }
.is-gated .d-seg__b { border-style:dashed; }
.d-why { font-size:11px; margin-top:5px; max-width:230px; }
.why-advertised { color: var(--yonder-waiting,#ffcf28); }
.why-gated { color: var(--yonder-label,#7f8a95); }
</style>
