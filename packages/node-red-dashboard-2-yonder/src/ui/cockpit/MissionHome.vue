<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<CockpitOverlay @escape="$emit('close')">
 <div class="mission-touch-scrim" @click.self="$emit('close')">
  <section ref="root" class="mission-touch" role="dialog" aria-modal="true" aria-label="Mission home" @keydown="keyboard">
   <header class="mission-touch-header"><div><small>MISSION PLANNING · AIRCRAFT REFERENCE</small><h2>Home</h2></div><button class="mission-touch-close" aria-label="Close home editor" @click="$emit('close')">×</button></header>
   <form class="mission-touch-body mission-parameter-form" @submit.prevent="save">
    <div class="mission-touch-section-label">PLANNING HOME</div>
    <p class="mission-touch-note">Local draft reference. Saving keeps waypoint heights, altitude references and order.</p>
    <div class="mission-field-grid">
     <label class="mission-parameter-field"><span>Latitude <small>degrees</small></span><input v-model="form.lat" type="number" min="-90" max="90" step="any" required aria-label="Home latitude" /></label>
     <label class="mission-parameter-field"><span>Longitude <small>degrees</small></span><input v-model="form.lon" type="number" min="-180" max="180" step="any" required aria-label="Home longitude" /></label>
     <label class="mission-parameter-field"><span>Home elevation <small>MSL · {{altitudeUnit}}</small></span><FlightUnitInput v-model="form.alt" :unit="altitudeUnit" :min="-1000" :max="30000" required aria-label="Home MSL elevation" /></label>
     <label class="mission-parameter-field"><span>Elevation units</span><select v-model="altitudeUnit" aria-label="Home elevation units"><option value="ft">Feet</option><option value="m">Metres</option></select></label>
    </div>
    <div class="mission-action-grid">
     <button type="button" :disabled="loading" @click="$emit('pick',editing())">Choose home on map</button>
     <button type="button" :disabled="loading||!terrainEnabled" @click="terrainElevation">Use official terrain elevation<small>Prepared ArduPilot MSL source · review estimate</small></button>
    </div>
    <p v-if="note" class="mission-touch-note" role="status">{{note}}</p>
    <p v-if="error||externalError" class="mission-touch-error" role="alert">{{error||externalError}}</p>
    <p v-if="difference" class="mission-touch-note">Controller home is {{difference.distanceM.toFixed(0)}} m from these coordinates<template v-if="Math.abs(difference.altitudeM)<.05">, at the same elevation.</template><template v-else> and {{unitText(Math.abs(difference.altitudeM),altitudeUnit)}} {{difference.altitudeM>0?'higher':'lower'}} than the entered elevation.</template></p>
    <div class="mission-action-grid"><button type="submit" class="mission-primary" :disabled="loading">Save planning home</button><button type="button" :disabled="!controllerHome" @click="useController">Use controller home for planning<small>Copy the reported reference into this draft</small></button></div>
    <div class="mission-touch-section-label">CONTROLLER HOME</div>
    <p class="mission-touch-note" v-if="controllerHome">Reported: {{controllerHome.lat.toFixed(7)}}°, {{controllerHome.lon.toFixed(7)}}° · {{unitText(controllerHome.alt,altitudeUnit)}} MSL</p>
    <p class="mission-touch-note" v-else>The controller has not reported a home position.</p>
    <p class="mission-touch-note">Changes return-home and above-home altitude references. In RTL or QRTL it can redirect the aircraft.</p>
    <button type="button" class="mission-touch-wide mission-execute" :disabled="!canSet||busy||loading" @click="review">Set controller home…<small>Review the coordinates and MSL elevation above, then confirm</small></button>
    <p v-if="!canSet" class="mission-touch-note">{{unavailableReason||'Controller-home command support has not been reported. Check the aircraft connection and server version.'}}</p>
    <p v-if="operation" class="mission-command-result" :class="{rejected:['rejected','failed','unknown'].includes(operation.state)||operation.effect?.state==='mismatch'}" role="status">{{operation.effect?.state==='mismatch'?'Home change not verified — '+operation.message:operationPresentation(operation).text}}</p>
    <details class="mission-touch-note"><summary>Home reference and GPS</summary><p>The controller may lock an explicitly set home; check its reported value before flight. This does not set an EKF origin or provide a live GPS position. A Do Set Home mission item is a separate action that runs during mission execution.</p></details>
   </form>
  </section>
 </div>
</CockpitOverlay>
</template>
<script setup>
import CockpitOverlay from './CockpitOverlay.vue';
import {ref,reactive,computed,onMounted,onBeforeUnmount,nextTick} from 'vue';
import FlightUnitInput from './FlightUnitInput.vue';
import {unitText} from './flight-units.mjs';
import {planningHome,homeDifference} from './mission-home.mjs';
import {operationPresentation} from './operation-presentation.mjs';
import {loadMissionTerrain} from './mission-terrain.mjs';
const props=defineProps({home:Object,controllerHome:Object,initial:Object,options:Object,canSet:Boolean,busy:Boolean,operation:Object,unavailableReason:String,externalError:String,officialClient:Object,terrainEnabled:Boolean});
const emit=defineEmits(['close','save','pick','review']);
const initial=props.initial||props.home||{};
const form=reactive({lat:initial.lat??'',lon:initial.lon??'',alt:initial.alt??''});
const altitudeUnit=ref(initial.altitudeUnit||props.options?.altitudeUnit||'ft'),error=ref(''),note=ref(initial.mapSelected?'Map location selected. Review the elevation for this location.':''),loading=ref(false),root=ref(null);
const previousFocus=document.activeElement;let controller;
const editing=()=>({...form,altitudeUnit:altitudeUnit.value});
const difference=computed(()=>{try{return homeDifference(planningHome(form),props.controllerHome)}catch{return null}});
function save(){try{error.value='';emit('save',planningHome(form))}catch(e){error.value=e.message}}
function useController(){try{if(props.controllerHome)emit('save',planningHome(props.controllerHome))}catch(e){error.value=e.message}}
function review(){try{error.value='';emit('review',planningHome(form),editing())}catch(e){error.value=e.message}}
async function terrainElevation(){
 try{
  const point=planningHome({...form,alt:0});loading.value=true;error.value='';note.value='Reading the selected terrain source…';controller=new AbortController();
  const report=await loadMissionTerrain({route:{points:[{...point,seq:0,frame:0}],legs:[],totalM:0,limitations:[]},home:null,client:props.officialClient,signal:controller.signal});
  if(controller.signal.aborted)return;
  const elevation=report.waypoints?.[0]?.groundM;
  if(!Number.isFinite(elevation))throw new Error(report.reason||'No matching terrain elevation at this location. Enter a known MSL elevation.');
  form.alt=elevation;note.value=`Estimated ground elevation · ${report.source.provider} · ${report.source.datum}. ${report.source.datumEvidence} Review before saving or sending.`;
 }catch(e){if(e.name!=='AbortError'){error.value=e.message;note.value=''}}finally{loading.value=false}
}
function keyboard(event){
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();emit('close');return;}
 if(event.key!=='Tab')return;
 const nodes=Array.from(root.value.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)'));
 if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1)?.focus()}
 else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0]?.focus()}
}
onMounted(async()=>{await nextTick();root.value?.querySelector('button')?.focus()});
onBeforeUnmount(()=>{controller?.abort();if(previousFocus?.isConnected)previousFocus.focus()});
</script>
