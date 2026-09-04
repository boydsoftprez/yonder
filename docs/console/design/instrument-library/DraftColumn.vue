<!-- DRAFT — a titled group inside the deck, with an optional right-hand qualifier. -->
<template>
  <div class="d-col">
    <div class="d-h"><span>{{ title }}</span><em v-if="note" :class="'q-' + noteTone">{{ note }}</em></div>
    <slot />
  </div>
</template>
<script>
export default {
  name: 'DraftColumn',
  props: { title: String, note: { type: String, default: '' }, noteTone: { type: String, default: 'label' } }
}
</script>
<style scoped>
.d-col { padding:14px 15px; min-width:0; }
.d-h { display:flex; align-items:baseline; justify-content:space-between; gap:10px;
  font-size:9.5px; letter-spacing:.16em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); margin-bottom:11px; }
.d-h em { font-style:normal; letter-spacing:.1em; }
.q-select { color: var(--yonder-select,#2ad4f0); }
.q-waiting { color: var(--yonder-waiting,#ffcf28); }
.q-label { color: var(--yonder-label,#7f8a95); }
</style>
