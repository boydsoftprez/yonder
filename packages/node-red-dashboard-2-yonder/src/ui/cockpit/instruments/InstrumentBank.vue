<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="instrument-bank" :data-placement="placement" aria-label="Aircraft instrument bank">
    <div class="instrument-bank-faces" :style="{ '--instrument-count': Math.max(1, config.length) }">
      <button v-for="slot in config" :key="slot.id" type="button" class="instrument-bank-reading" :aria-label="`Inspect ${itemForSlot(items, slot).label}`" @click="emit('select', slot.id)"><InstrumentGauge :item="itemForSlot(items, slot)" :settings="slot" /></button>
      <span v-if="!config.length" class="empty-bank">No instruments selected</span>
    </div>
    <button v-if="editable" type="button" class="instrument-bank-configure" aria-label="Configure instruments" @click="editing = true">Instruments <span aria-hidden="true">⚙</span></button>
    <InstrumentConfigEditor v-if="editing" :items="items" :config="config" :defaults="defaultBankConfig()" @cancel="editing = false" @apply="apply" />
  </section>
</template>
<script setup lang="ts">
import { ref } from 'vue';
import InstrumentGauge from './InstrumentGauge.vue';
import InstrumentConfigEditor from './InstrumentConfigEditor.vue';
import { defaultBankConfig, itemForSlot, type InstrumentItem, type InstrumentSlot } from './instrument-settings';
withDefaults(defineProps<{ items: InstrumentItem[]; config?: InstrumentSlot[]; placement?: 'top' | 'side' | 'mfd'; editable?: boolean }>(), { config: defaultBankConfig, placement: 'side', editable: true });
const emit = defineEmits<{ select: [id: string]; 'update:config': [config: InstrumentSlot[]] }>();
const editing = ref(false);
function apply(config: InstrumentSlot[]) { emit('update:config', config); editing.value = false; }
</script>
<style scoped>
.instrument-bank{display:flex;flex-direction:column;min-width:0;min-height:0;height:100%;background:#030708;color:#f4f8fb;font-family:Arial,sans-serif;border-right:1px solid #64737c;box-sizing:border-box;position:relative}.instrument-bank-faces{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:repeat(var(--instrument-count),minmax(80px,1fr));flex:1;min-height:0;overflow:auto;padding:0 4px}.instrument-bank .instrument-bank-reading{display:block;width:100%;height:100%;min-width:0;min-height:80px;border:0;border-bottom:1px solid #434c53;background:transparent;color:inherit;padding:1px 3px;overflow:hidden;border-radius:0;cursor:pointer}.instrument-bank .instrument-bank-reading:hover{background:#10212b}.instrument-bank .instrument-bank-configure{min-height:44px;width:100%;padding:4px 8px;border:0;border-top:1px solid #415662;border-radius:0;background:#0b1b24;color:#c6dce8;font:inherit;font-size:12px;cursor:pointer}.instrument-bank :is(button):focus-visible{outline:2px solid #94dfff;outline-offset:-3px}.instrument-bank-configure span{margin-left:6px}.empty-bank{padding:12px;font-size:12px;color:#b2c7d3}.instrument-bank[data-placement=top],.instrument-bank[data-placement=mfd]{height:auto;border-right:0;border-bottom:1px solid #64737c}.instrument-bank[data-placement=top] .instrument-bank-faces{grid-template-columns:repeat(var(--instrument-count),minmax(105px,1fr));grid-template-rows:145px;overflow:auto}.instrument-bank[data-placement=top] .instrument-bank-reading{border-bottom:0;border-right:1px solid #434c53}.instrument-bank[data-placement=mfd] .instrument-bank-faces{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));grid-template-rows:none;grid-auto-rows:160px}.instrument-bank[data-placement=mfd] .instrument-bank-reading{border-right:1px solid #434c53}
</style>
