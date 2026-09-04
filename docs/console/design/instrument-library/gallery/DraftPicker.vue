<!-- Interactive. A real <select> under a drawn control: a custom listbox would
     have to reimplement keyboard handling, and a native select is what gives a
     tablet a usable wheel. -->
<template>
  <div class="d-field" :class="'is-' + state">
    <span v-if="label" class="d-lbl">{{ label }}</span>
    <div class="d-pick" :class="{ open: focused }">
      <span class="d-pick__v">{{ shownLabel }}</span>
      <span class="d-pick__car" aria-hidden="true">&#9662;</span>
      <select
        class="d-pick__sel"
        :value="modelValue"
        :disabled="state !== 'present'"
        :aria-label="label"
        @focus="focused = true"
        @blur="focused = false"
        @change="$emit('update:modelValue', $event.target.value)"
      >
        <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div v-if="reason" class="d-why" :class="'why-' + state">{{ reason }}</div>
  </div>
</template>
<script>
export default {
  name: 'DraftPicker',
  props: {
    label: { type: String, default: '' },
    modelValue: { type: [String, Number], default: '' },
    options: { type: Array, default: () => [] },
    state: { type: String, default: 'present' },
    reason: { type: String, default: '' }
  },
  emits: ['update:modelValue'],
  data: () => ({ focused: false }),
  computed: {
    shownLabel () {
      const hit = this.options.find(o => String(o.value) === String(this.modelValue))
      return hit ? hit.label : String(this.modelValue)
    }
  }
}
</script>
<style scoped>
.d-field { margin-bottom: 13px; }
.d-lbl { display:block; font-size:10.5px; letter-spacing:.11em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); margin-bottom:5px; }
.d-pick { position:relative; display:flex; width:100%; max-width:230px; align-items:center;
  justify-content:space-between; gap:10px; font-size:13px; min-height:36px; padding:0 12px; border-radius:3px;
  border:1px solid var(--yonder-divider,#2b333c);
  background: color-mix(in srgb, var(--yonder-value,#fff) 2%, transparent);
  color: var(--yonder-value,#fff); }
.d-pick.open { border-color: var(--yonder-select,#2ad4f0); }
.d-pick__sel { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer;
  font: inherit; }
.d-pick__sel:disabled { cursor:not-allowed; }
.d-pick__v { font-variant-numeric: tabular-nums; }
.d-pick__car { color: var(--yonder-select,#2ad4f0); font-size:11px; }
.is-advertised .d-pick { border-color: var(--yonder-waiting,#ffcf28); color: var(--yonder-waiting,#ffcf28); }
.is-advertised .d-pick__car, .is-gated .d-pick__car { display:none; }
.is-gated .d-pick { color: var(--yonder-label,#7f8a95); border-style:dashed; background:transparent; }
.d-why { font-size:11px; margin-top:5px; line-height:1.4; max-width:230px; }
.why-advertised { color: var(--yonder-waiting,#ffcf28); }
.why-gated { color: var(--yonder-label,#7f8a95); }
</style>
