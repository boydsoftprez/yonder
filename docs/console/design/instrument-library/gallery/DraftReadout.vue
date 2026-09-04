<!-- DRAFT — label, value, unit, stacked. Not the data bar, which is horizontal. -->
<template>
  <div class="d-rows">
    <div v-for="r in rows" :key="r.label" class="d-row" :class="{ absent: r.absent }">
      <span class="d-l">{{ r.label }}</span>
      <span class="d-v">{{ r.value }}<i v-if="r.unit">{{ r.unit }}</i></span>
    </div>
  </div>
</template>
<script>
export default { name: 'DraftReadout', props: { rows: { type: Array, default: () => [] } } }
</script>
<style scoped>
.d-rows { max-width:230px; }
.d-row { display:flex; align-items:baseline; justify-content:space-between; gap:10px;
  padding:4px 0; font-size:13px; }
.d-l { font-size:10.5px; letter-spacing:.1em; text-transform:uppercase;
  color: var(--yonder-label,#7f8a95); white-space:nowrap; }
.d-v { font-weight:600; font-variant-numeric: tabular-nums; color: var(--yonder-value,#fff);
  white-space:nowrap; }
/* A token carrying a unit is never uppercased: Mb/s, not MB/S. */
.d-v i { font-style:normal; font-weight:400; font-size:11.5px; text-transform:none; margin-left:4px;
  color: var(--yonder-label,#7f8a95); }
.absent .d-v { color: var(--yonder-neutral,#7d7869); font-weight:400; }
</style>
