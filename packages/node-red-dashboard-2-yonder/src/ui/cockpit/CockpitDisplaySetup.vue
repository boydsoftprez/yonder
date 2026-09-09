<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
 <div class="cockpit-scrim" @click.self="$emit('close')" @keydown="keyboard">
  <section ref="dialog" class="cockpit-dialog cockpit-display-setup" role="dialog" aria-modal="true" aria-label="Display setup">
   <header><h2>Display setup</h2><button aria-label="Close display setup" @click="$emit('close')">×</button></header>
   <div class="cockpit-dialog-body">
    <label>Screen arrangement<select aria-label="Display arrangement" :value="config.arrangement" @change="$emit('option','arrangement',$event.target.value)"><option value="single">Single PFD with insets</option><option value="split">PFD beside MFD</option><option value="stacked">PFD above MFD</option></select></label>
    <label>Instrument panel<select aria-label="Instrument placement" :value="config.bankPlacement" @change="$emit('option','bankPlacement',$event.target.value)"><option value="side">Beside the PFD</option><option value="top">Across the top</option><option value="mfd">Across the top of the MFD</option><option value="mfd-left">Left side of the MFD</option><option value="hidden">Hidden</option></select></label>
    <label class="cockpit-check-option"><span>Navigation fields across the top</span><input type="checkbox" :checked="config.showDataBar" @change="$emit('option','showDataBar',$event.target.checked)"></label>
    <label class="cockpit-check-option"><span>HOME bearing pointer on the HSI</span><input type="checkbox" :checked="config.homePointer" @change="$emit('option','homePointer',$event.target.checked)"></label>
    <label>Navigation distance<select aria-label="Navigation distance units" :value="config.distanceUnit" @change="$emit('option','distanceUnit',$event.target.value)"><option value="nm">Nautical miles</option><option value="mi">Miles</option><option value="km">Kilometres</option></select></label>
    <FlightUnits :options="flightOptions" @option="(key,value)=>$emit('flight-option',key,value)"/>
    <p>The same PFD stays active while you change pages. Tap Fields or Instruments to choose readings, sources, order and gauge styles.</p>
    <p v-if="config.arrangement==='stacked'">The PFD and MFD keep their own display heights. Scroll down within the displays to reach the MFD; flight controls and user fields stay above the scrolling area.</p>
    <p v-if="['mfd','mfd-left'].includes(config.bankPlacement)&&config.arrangement==='single'">Open an MFD page to see its instrument panel.</p>
    <div class="cockpit-display-actions"><button @click="$emit('page','map')">Open map</button><button @click="$emit('page','mission')">Open flight plan</button><button @click="$emit('page','systems')">Open systems</button><button @click="$emit('reset')">Restore display defaults</button></div>
   </div>
  </section>
 </div>
</template>
<script setup>
import {ref,nextTick,onMounted,onBeforeUnmount} from 'vue';
import FlightUnits from './FlightUnits.vue';
defineProps({config:Object,flightOptions:Object});const emit=defineEmits(['option','flight-option','page','reset','close']);
const dialog=ref(null);let previousFocus=null;
const controls=()=>[...(dialog.value?.querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled)')||[])];
onMounted(async()=>{previousFocus=document.activeElement;await nextTick();controls()[0]?.focus()});
onBeforeUnmount(()=>{if(previousFocus?.isConnected)previousFocus.focus()});
function keyboard(event){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();emit('close');return}if(event.key!=='Tab')return;const list=controls(),first=list[0],last=list.at(-1),active=document.activeElement;if(!list.length)return;if(event.shiftKey&&active===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&active===last||!list.includes(active)){event.preventDefault();first.focus()}}
</script>
<style scoped>
.cockpit-display-setup{width:min(580px,calc(100vw - 24px))}.cockpit-display-setup label{display:grid;gap:7px;margin-bottom:16px;color:#d8e8ef;font-size:14px}.cockpit-display-setup select{width:100%;min-height:44px;background:#071b27;border:1px solid #7f9dac;border-radius:3px;padding:8px;color:white;font-size:16px}.cockpit-display-setup .cockpit-check-option{display:flex;justify-content:space-between;align-items:center;gap:10px}.cockpit-check-option input{width:22px;height:22px}.cockpit-display-setup p{font-size:12px;line-height:1.5;color:#b7ceda}.cockpit-display-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
</style>
