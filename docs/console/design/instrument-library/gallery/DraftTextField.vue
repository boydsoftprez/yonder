<!-- A name the operator chooses. Yonder ships Cam 1, Cam 2 … because a
     default that guesses at a mounting — nose, belly, gimbal — is a guess
     about somebody else's aircraft. -->
<template>
  <div class="d-field">
    <span v-if="label" class="d-lbl">{{ label }}</span>
    <div class="d-tf" :class="{ focus }">
      <input
        class="d-tf__i" type="text" :value="modelValue" :maxlength="max"
        :placeholder="placeholder" :aria-label="label"
        @focus="focus = true" @blur="focus = false"
        @input="$emit('update:modelValue', $event.target.value)"
      >
      <span v-if="focus" class="d-tf__n">{{ modelValue.length }}/{{ max }}</span>
    </div>
    <div v-if="hint" class="d-fine">{{ hint }}</div>
  </div>
</template>
<script>
export default {
  name: 'DraftTextField',
  props: {
    label: { type: String, default: '' },
    modelValue: { type: String, default: '' },
    placeholder: { type: String, default: '' },
    hint: { type: String, default: '' },
    max: { type: Number, default: 24 }
  },
  emits: ['update:modelValue'],
  data: () => ({ focus: false })
}
</script>
<style scoped>
.d-field { margin-bottom: 13px; }
.d-lbl { display:block; font-size:9.5px; letter-spacing:.11em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); margin-bottom:4px; }
.d-tf { display:flex; align-items:center; gap:8px; max-width:250px; padding:7px 10px;
  border-radius:2px; border:1px solid var(--yonder-divider,#2b333c);
  background: color-mix(in srgb, var(--yonder-value,#fff) 2%, transparent); }
.d-tf.focus { border-color: var(--yonder-select,#2ad4f0); }
.d-tf__i { flex:1; min-width:0; background:transparent; border:0; outline:none; font:inherit;
  font-size:13px; color: var(--yonder-value,#fff); }
.d-tf__i::placeholder { color: var(--yonder-label,#7f8a95); }
.d-tf__n { font-size:9px; font-variant-numeric:tabular-nums; color: var(--yonder-label,#7f8a95); }
.d-fine { font-size:9.5px; margin-top:4px; max-width:250px; color: var(--yonder-label,#7f8a95); }
</style>
