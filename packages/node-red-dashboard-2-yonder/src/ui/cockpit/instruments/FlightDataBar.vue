<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="flight-data-bar" aria-label="Navigation data fields">
    <div class="flight-data-fields">
      <button v-for="slot in config" :key="slot.id" type="button" class="flight-data-field" :data-id="slot.id" :data-available="instrumentAvailable(itemForSlot(items,slot))" :title="fieldDescription(slot)" :aria-label="`Inspect ${itemForSlot(items, slot).label}: ${fieldDescription(slot)}`" @click="emit('select', slot.id)">
        <InstrumentGauge v-if="['arc', 'horizontal', 'vertical', 'bearing', 'status'].includes(slot.kind || itemForSlot(items, slot).kind || '')" :item="itemForSlot(items, slot)" :settings="slot" />
        <template v-else><span class="field-label">{{ itemForSlot(items, slot).shortLabel || itemForSlot(items, slot).label }}</span><span class="field-reading">{{ formatInstrumentValue(itemForSlot(items, slot), slot.kind) }} <small>{{ instrumentDisplayUnit(itemForSlot(items, slot), slot.kind) }}</small></span><span v-if="!instrumentAvailable(itemForSlot(items, slot))" class="field-reason">{{ itemForSlot(items, slot).reason || 'Data unavailable' }}</span><span v-else-if="itemForSlot(items, slot).quality === 'partial'" class="field-reason">Partial history</span></template>
      </button>
    </div>
    <button v-if="editable" type="button" class="flight-data-configure" aria-label="Configure navigation fields" @click="editing = true"><span aria-hidden="true">⚙</span><span>Fields</span></button>
    <InstrumentConfigEditor v-if="editing" title="Configure navigation fields" :items="items" :config="config" :defaults="defaultTopConfig()" @cancel="editing = false" @apply="apply" />
  </section>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import InstrumentConfigEditor from './InstrumentConfigEditor.vue';
import InstrumentGauge from './InstrumentGauge.vue';
import { defaultTopConfig, formatInstrumentValue, instrumentAvailable, instrumentDisplayUnit, itemForSlot, type InstrumentItem, type InstrumentSlot } from './instrument-settings';
const props = withDefaults(defineProps<{ items: InstrumentItem[]; config?: InstrumentSlot[]; editable?: boolean }>(), { config: defaultTopConfig, editable: true });
const emit = defineEmits<{ select: [id: string]; 'update:config': [config: InstrumentSlot[]] }>();
const editing = ref(false);
function fieldDescription(slot: InstrumentSlot) { const item = itemForSlot(props.items, slot); return instrumentAvailable(item) ? `${formatInstrumentValue(item, slot.kind)} ${instrumentDisplayUnit(item, slot.kind)}` : item.reason || 'Data unavailable'; }
function apply(config: InstrumentSlot[]) { emit('update:config', config); editing.value = false; }
</script>
<style scoped>
.flight-data-bar{display:flex;min-width:0;background:#03090d;color:#f5f9fc;font:14px Arial,sans-serif;border-bottom:1px solid #71818a;min-height:54px}.flight-data-fields{display:flex;flex:1;min-width:0;overflow:auto}.flight-data-bar .flight-data-field{display:flex;flex-direction:column;justify-content:center;align-items:stretch;flex:1;min-width:100px;min-height:54px;max-height:88px;padding:5px 10px;border:0;border-right:1px solid #52616a;border-radius:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.flight-data-field:hover{background:#112531}.field-label{font-size:11px;line-height:1.25;color:#b5d0df;white-space:nowrap}.field-reading{overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;font-size:21px;line-height:1.25;white-space:nowrap}.flight-data-field[data-available=true]:is([data-id="nav.activeWaypoint"],[data-id="nav.distance"],[data-id="nav.ete"],[data-id="nav.desiredTrack"]) .field-reading{color:#f28de4}.field-reading small{font-size:11px;color:#d3e3ec}.field-reason{display:none;font-size:10px;line-height:1.2;color:#edc1bc;max-width:180px}.flight-data-bar .flight-data-configure{flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;min-width:48px;min-height:44px;border:0;border-radius:0;background:#102530;color:#d5e8f3;font:11px Arial,sans-serif;cursor:pointer}.flight-data-configure>span:first-child{font-size:18px}.flight-data-bar button:focus-visible{outline:2px solid #9fe3ff;outline-offset:-3px}.flight-data-field :deep(.instrument-gauge){height:74px}.flight-data-field :deep(.instrument-label){font-size:11px}
</style>
