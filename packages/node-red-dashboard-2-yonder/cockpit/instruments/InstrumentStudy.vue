<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<div class="instrument-study" :data-position="position">
 <div class="study-toolbar"><b>INSTRUMENT DESIGN PREVIEW</b><span>Demo readings &amp; limits</span><label>Placement <select v-model="position" aria-label="Instrument placement"><option value="side">Left column</option><option value="top">Top strip</option></select></label><label>State <select v-model="scenario" aria-label="Instrument demo state"><option value="normal">Normal</option><option value="caution">Caution</option><option value="missing">No data</option></select></label><button @click="beginEdit()">Edit instruments</button></div>
 <YonderCockpit ref="cockpit" id="instrument-design-cockpit" :report="report" :api="api">
  <template #instrument-strip>
   <div class="study-bank" role="group" aria-label="Graphical instrument study">
    <button v-for="(slot,index) in slots" :key="index" class="study-instrument" :aria-label="`Configure ${instruments[slot.id].name}`" @click="beginEdit(index)">
     <GaugeFace :gauge="instruments[slot.id]" :value="reading(slot.id)" :secondary="secondary(slot.id)" :appearance="slot.style"/>
    </button>
    <span class="study-bank-label">DEMO LIMITS · TAP TO CONFIGURE</span>
   </div>
  </template>
 </YonderCockpit>
 <div v-if="editing" class="study-scrim" @click.self="cancelEdit" @keydown.esc.stop="cancelEdit">
  <section class="study-editor" role="dialog" aria-modal="true" aria-label="Configure instrument panel">
   <header><div><small>LOCAL DESIGN PREVIEW</small><h2>Instrument panel</h2></div><button @click="cancelEdit" aria-label="Close instrument editor">×</button></header>
   <nav aria-label="Instrument slots"><button v-for="(slot,index) in draft" :key="index" :aria-pressed="selected===index" @click="selected=index">{{index+1}}</button></nav>
   <div class="study-face-preview"><GaugeFace :gauge="instruments[draft[selected].id]" :value="reading(draft[selected].id)" :secondary="secondary(draft[selected].id)" :appearance="draft[selected].style"/></div>
   <label>Instrument<select v-model="draft[selected].id" aria-label="Selected instrument"><option v-for="(g,id) in instruments" :key="id" :value="id">{{g.name}}</option></select></label>
   <label>Presentation<select v-model="draft[selected].style" aria-label="Gauge presentation"><option value="">Recommended for this instrument</option><option value="arc">Arc gauge</option><option value="horizontal">Horizontal scale</option><option value="vertical">Vertical scale</option></select></label>
   <div class="study-order"><button :disabled="selected===0" @click="move(-1)">Move earlier</button><button :disabled="selected===draft.length-1" @click="move(1)">Move later</button></div>
   <p>{{instruments[draft[selected].id].source}}</p><p class="study-limit-note">Readings and colored limits are illustrative. This preview changes no aircraft settings.</p>
   <footer><button @click="draft=defaultSlots();selected=0">Load default</button><button @click="cancelEdit">Cancel</button><button @click="saveEdit" class="study-save">Apply to preview</button></footer>
  </section>
 </div>
</div>
</template>
<script setup>
import {ref,onMounted,onBeforeUnmount,nextTick} from 'vue';
import YonderCockpit from '../../src/ui/YonderCockpit.vue';
import GaugeFace from './GaugeFace.vue';
import {instruments,defaultSlots} from './demo-instruments.mjs';
import {fixture} from '../fixture.mjs';
const report=ref(fixture()),cockpit=ref(null),position=ref('side'),scenario=ref('normal'),slots=ref(defaultSlots()),draft=ref(defaultSlots()),selected=ref(0),editing=ref(false);
const api={command:async()=>({accepted:false,message:'Instrument design preview has no aircraft connection'}),dataOptions:async dataOptions=>({dataOptions})};
const tick=setInterval(()=>{report.value={...report.value,sequence:report.value.sequence+1}},500);
onBeforeUnmount(()=>clearInterval(tick));
onMounted(()=>{
 const host=cockpit.value;host.preferences.display.stripPlacement='mfd';
 const relay=new URLSearchParams(location.search).get('ground');
 if(relay){try{const url=new URL(relay);if(['127.0.0.1','localhost'].includes(url.hostname)&&url.protocol==='http:'){host.groundRelayUrl=url.origin;host.groundRelayInput=url.origin;host.aircraftDatum='EGM96';host.onlineTerrain=true;host.configureGroundData()}}catch{}}
 window.instrumentStudy={snapshot:()=>({position:position.value,slots:slots.value,scenario:scenario.value}),cockpit:host};
});
function reading(id){if(scenario.value==='missing')return null;if(scenario.value==='caution')return ({power:25,battery:23,used:6160,lte:-111,cpu:83,link:530,throttle:85,volts:13.8,temp:80})[id];return instruments[id].value}
function secondary(id){
 if(scenario.value==='missing')return 'DATA UNAVAILABLE';
 if(id==='power')return `${Math.round(reading('power')*reading('volts'))} W`;
 if(scenario.value==='caution')return ({battery:'13.8 V',used:'98.6 Wh USED',lte:'RSRP · SINR 1 dB',cpu:'80 °C',link:'TELEMETRY 0.6 s OLD'})[id]||instruments[id].secondary;
 return instruments[id].secondary;
}
async function beginEdit(index=0){draft.value=slots.value.map(s=>({...s}));selected.value=index;editing.value=true;await nextTick();document.querySelector('.study-editor select')?.focus()}
function cancelEdit(){editing.value=false}
function saveEdit(){slots.value=draft.value.map(s=>({...s}));editing.value=false}
function move(direction){const i=selected.value,j=i+direction;if(j<0||j>=draft.value.length)return;[draft.value[i],draft.value[j]]=[draft.value[j],draft.value[i]];selected.value=j}
</script>
<style>
.instrument-study{height:100dvh;background:#030708;color:#fff;--cockpit-height:calc(100dvh - 46px);--study-column:220px;font-family:Arial,sans-serif}
.study-toolbar{height:46px;padding:4px 10px;display:flex;align-items:center;gap:10px;background:#0c1c25;border-bottom:1px solid #52717f;font-size:12px;white-space:nowrap}.study-toolbar b{color:#8bdef5;font-size:11px;letter-spacing:1px}.study-toolbar>span{color:#b9cdd5;margin-right:auto}.study-toolbar label{display:flex;align-items:center;gap:6px}.study-toolbar :is(button,select){background:#203c4c;border:1px solid #728e9c;border-radius:3px;color:white;padding:7px;font:inherit;min-height:34px}.study-toolbar button{cursor:pointer}
.instrument-study .study-bank{background:#030708;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));position:relative;padding:4px 7px 17px;min-height:162px;border-bottom:1px solid #65747b;gap:4px}.instrument-study .y-cockpit .study-instrument{display:block;min-width:0;min-height:0;height:145px;border:0;border-right:1px solid #3e474d;background:transparent;padding:0 9px;overflow:hidden;border-radius:0}.instrument-study .y-cockpit .study-instrument:last-of-type{border-right:0}.instrument-study .y-cockpit .study-instrument:hover{background:#15232b}.study-bank-label{position:absolute;bottom:3px;left:0;right:0;text-align:center;font-size:9px;letter-spacing:.8px;color:#a8bac4}
.instrument-study[data-position=side] .y-cockpit{display:grid;grid-template-columns:var(--study-column) minmax(0,1fr);grid-template-rows:52px 54px minmax(0,1fr)}
.instrument-study[data-position=side] .cockpit-header{grid-row:1;grid-column:1/-1}
.instrument-study[data-position=side] .flight-control-host{grid-row:2;grid-column:1/-1}
.instrument-study[data-position=side] .cockpit-navigation-data{grid-row:3;grid-column:1;overflow:hidden}
.instrument-study[data-position=side] .cockpit-body{grid-row:3;grid-column:2}
.instrument-study[data-position=side] .y-cockpit[data-layout=full] :is(.cockpit-mission,.cockpit-map-pane){width:clamp(115px,calc((100cqw - var(--study-column) - 320px)/2 - 14px),370px)}
.instrument-study[data-position=side] .study-bank{height:100%;min-height:0;grid-template-columns:1fr;grid-template-rows:repeat(6,minmax(0,1fr));gap:0;padding:0 4px 17px;border-right:1px solid #71818a;border-bottom:0}
.instrument-study[data-position=side] .y-cockpit .study-instrument{height:100%;padding:0 3px;border-right:0;border-bottom:1px solid #434c53}
.study-scrim{position:absolute;inset:46px 0 0;z-index:40;display:flex;justify-content:flex-end;background:#0005;padding:12px}.study-editor{width:350px;max-width:100%;max-height:100%;overflow:auto;border:1px solid #8aa7b8;border-radius:5px;background:#0b202c;color:#ecf6ff;padding:16px;box-shadow:0 8px 36px #000b}.study-editor header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.study-editor h2{font-size:20px;margin:4px 0}.study-editor small{font-size:10px;color:#9ac9df;letter-spacing:1px}.study-editor button,.study-editor select{font:inherit;min-height:44px;background:linear-gradient(#2c5065,#17313f);color:white;border:1px solid #718d9d;border-radius:3px;padding:8px;cursor:pointer}.study-editor button:disabled{opacity:.35;cursor:default}.study-editor nav{display:flex;gap:4px}.study-editor nav button{flex:1}.study-editor nav [aria-pressed=true]{background:#176486;border-color:#84dbff}.study-face-preview{height:165px;background:#030708;margin:14px 0;padding:5px}.study-editor label{display:grid;gap:6px;font-size:13px;margin:13px 0}.study-editor select{width:100%;background:#041721;font-size:16px}.study-order{display:flex;gap:8px}.study-order button{flex:1}.study-editor p{font-size:12px;line-height:1.5;color:#bed4e1}.study-limit-note{border-left:2px solid #6b8b9e;padding-left:10px}.study-editor footer{display:flex;gap:6px;flex-wrap:wrap;margin-top:18px}.study-editor .study-save{border-color:#7ad7f8;background:#23607c;margin-left:auto}
@media(max-width:1100px){.study-toolbar>span{display:none}.study-toolbar b{margin-right:auto}.instrument-study{--study-column:190px}}
@media(max-width:960px){.study-toolbar{height:84px;flex-wrap:wrap;gap:4px 10px}.study-toolbar b{width:100%;margin:0}.instrument-study{--cockpit-height:calc(100dvh - 84px)}.study-scrim{top:84px}.instrument-study[data-position=side] .y-cockpit{display:flex}.instrument-study[data-position=side] .y-cockpit[data-layout=full] :is(.cockpit-mission,.cockpit-map-pane){width:clamp(115px,calc((100cqw - 320px)/2 - 14px),370px)}.instrument-study .study-bank,.instrument-study[data-position=side] .study-bank{display:grid;height:auto;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,105px);min-height:226px;padding:2px 2px 16px}.instrument-study .y-cockpit .study-instrument,.instrument-study[data-position=side] .y-cockpit .study-instrument{height:105px;grid-row:auto;grid-column:auto;min-height:0;padding:0}.instrument-study[data-position=side] .study-instrument .eis-gauge{min-height:0!important}.instrument-study .study-bank-label{font-size:8px}}
</style>
