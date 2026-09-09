<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <div class="flight-control-host">
    <nav class="flight-control-strip" aria-label="Persistent aircraft flight controls">
      <button v-for="shortcut in shortcuts" :key="shortcut.kind" :aria-label="shortcut.label" :aria-expanded="panel===shortcut.kind" @click="open(shortcut.kind)"><span>{{shortcut.label}}</span><small>{{shortcut.detail}}</small></button>
    </nav>
    <div v-if="panel" class="mission-touch-scrim flight-control-scrim" @click.self="close">
      <section ref="dialog" class="mission-touch flight-control-dialog" role="dialog" aria-modal="true" :aria-label="title" @keydown="keyboard">
        <header class="mission-touch-header"><div><small>AIRCRAFT CONTROLS · REVIEW BEFORE SEND</small><h2>{{title}}</h2></div><button aria-label="Close flight controls" @click="close">×</button></header>
        <div class="flight-control-actual"><small>REPORTED BY AIRCRAFT</small><strong>{{actual.mode}}</strong><span>{{actual.armed}}</span></div>
        <div class="mission-touch-body">
          <p v-if="reason" class="mission-touch-error" role="status">{{reason}}</p>
          <p v-if="error" class="mission-touch-error" role="alert">{{error}}</p>
          <template v-if="panel==='modes'">
            <p class="mission-touch-note">All modes supported by this aircraft. Highlight shows the reported mode.</p>
            <div class="mission-mode-grid" aria-label="Supported aircraft modes"><button v-for="mode in modes" :key="mode.customMode" :aria-pressed="actual.fresh&&snapshot.telemetry?.mode===mode.name" :disabled="!!reason" @click="submit('mode',{mode:mode.name})">{{mode.name}}<small>{{mode.source==='advertised'?'Aircraft advertised':'Firmware known'}}</small></button></div>
            <p v-if="!modes.length" class="mission-touch-note">Supported modes unavailable.</p>
          </template>
          <template v-else-if="panel==='arm'">
            <p class="mission-touch-note">Arming and disarming are separate from selecting a flight mode. No force-arm or force-disarm command is used.</p>
            <div class="mission-action-grid"><button aria-label="Review arm aircraft" :disabled="!!reason||snapshot.telemetry?.armed===true" @click="submit('arm',{armed:true})">Review arm aircraft</button><button aria-label="Review disarm aircraft" :disabled="!!reason||snapshot.telemetry?.armed!==true" @click="submit('arm',{armed:false})">Review disarm aircraft</button></div>
          </template>
          <template v-else-if="panel==='resume'||panel==='rtl'">
            <p class="mission-touch-note">{{panel==='resume'?(missionExecution.kind==='mission-start'?'The aircraft current item is Home (0). Review an explicit start of the verified mission. This does not arm the aircraft.':'Resume AUTO from the fresh aircraft current authored mission item. This does not arm the aircraft.'):'Select the aircraft RTL mode. The autopilot owns the return path and altitude.'}}</p>
            <p v-if="panel==='resume'">Current aircraft mission item: <strong>{{snapshot.mission?.currentFresh?(snapshot.mission.currentSeq===0?'Home (0)':snapshot.mission.currentSeq):'unavailable'}}</strong></p>
            <button v-if="panel==='resume'&&missionExecution.kind==='mission-start'" class="mission-touch-wide mission-primary" aria-label="Review start mission" :disabled="!!reason" @click="submit('mission-start')">Review start mission</button>
            <button v-else class="mission-touch-wide mission-primary" :aria-label="panel==='resume'?'Review Resume Mission':'Review RTL'" :disabled="!!reason" @click="submit(panel)">Review {{panel==='resume'?'Resume Mission':'RTL'}}</button>
          </template>
          <form v-else class="flight-request-form" @submit.prevent="submit(actionKind)">
            <p class="mission-touch-note">This request enters GUIDED and sends one operator-selected target. An ACK confirms command acceptance; actual motion remains visible in the instruments.</p>
            <FlightUnits v-if="['alt-speed','direct','loiter'].includes(panel)" :options="options" @option="(key,value)=>$emit('option',key,value)"/>
            <div v-if="panel==='alt-speed'" class="mission-categories"><button type="button" :aria-pressed="targetKind==='altitude'" @click="targetKind='altitude';error=''">Altitude</button><button type="button" :aria-pressed="targetKind==='speed'" @click="targetKind='speed';error=''">Airspeed</button></div>
            <div v-if="panel==='heading'" class="mission-field-grid">
              <label class="mission-parameter-field"><span>True heading <small>degrees</small></span><input v-model="form.headingDeg" aria-label="Requested true heading" type="number" min="0" max="359.999" step="any" required /></label>
              <label class="mission-parameter-field"><span>Turn acceleration <small>m/s²</small></span><input v-model="form.turnAccelerationMps2" aria-label="Heading turn acceleration" type="number" min=".05" max="20" step="any" required /></label>
            </div>
            <div v-if="panel==='direct'||panel==='loiter'" class="mission-field-grid">
              <label class="mission-parameter-field"><span>Latitude <small>degrees</small></span><input v-model="form.lat" aria-label="Target latitude" type="number" min="-90" max="90" step="any" required /></label>
              <label class="mission-parameter-field"><span>Longitude <small>degrees</small></span><input v-model="form.lon" aria-label="Target longitude" type="number" min="-180" max="180" step="any" required /></label>
              <button type="button" class="mission-touch-wide" @click="pickTarget">Choose target on map</button>
            </div>
            <div v-if="['direct','loiter','altitude'].includes(actionKind)" class="mission-field-grid">
              <label class="mission-parameter-field"><span>Requested altitude <small>{{unitLabels[selectedUnits.altitudeUnit]}}</small></span><FlightUnitInput v-model="form.altitudeM" :unit="selectedUnits.altitudeUnit" :aria-label="'Requested altitude '+unitLabels[selectedUnits.altitudeUnit]" :min="-1000" :max="30000" required /></label>
              <label class="mission-parameter-field"><span>Altitude datum</span><select v-model="form.datum" aria-label="Flight target altitude datum"><option value="home">Above home</option><option value="msl">Mean sea level</option></select></label>
              <label v-if="actionKind==='altitude'" class="mission-parameter-field"><span>Requested climb / descent rate <small>{{unitLabels[selectedUnits.verticalSpeedUnit]}} · 0 = aircraft maximum</small></span><FlightUnitInput v-model="form.verticalRateMps" :unit="selectedUnits.verticalSpeedUnit" aria-label="Requested vertical rate" :min="0" :max="100" required /></label>
            </div>
            <div v-if="actionKind==='speed'" class="mission-field-grid">
              <label class="mission-parameter-field"><span>Requested airspeed <small>{{unitLabels[selectedUnits.speedUnit]}}</small></span><FlightUnitInput v-model="form.airspeedMps" :unit="selectedUnits.speedUnit" :aria-label="'Requested airspeed '+unitLabels[selectedUnits.speedUnit]" :min=".01" :max="300" required /></label>
              <label class="mission-parameter-field"><span>Acceleration <small>m/s² · 0 = maximum</small></span><input v-model="form.accelerationMps2" aria-label="Requested speed acceleration" type="number" min="0" max="20" step="any" required /></label>
            </div>
            <p v-if="actionKind==='altitude'" class="mission-touch-note" role="status">Choose a target altitude; the aircraft determines climb or descent. ArduPlane 4.7.1 accepts nonzero rate requests but the tested climb was much slower. This is not a verified VS-hold mode. Zero requests the aircraft maximum within its configured limits.</p>
            <p v-if="actionKind==='speed'" class="mission-touch-note">This changes the requested airspeed. It does not select an IAS climb or FLC mode; ArduPlane manages speed and height together.</p>
            <template v-if="panel==='loiter'">
              <div class="mission-field-grid"><label class="mission-parameter-field"><span>Radius <small>metres</small></span><input v-model="form.radiusM" aria-label="Requested loiter radius" type="number" min="1" max="65535" step="1" required /></label><label class="mission-parameter-field"><span>Direction</span><select v-model="form.direction" aria-label="Requested loiter direction"><option value="cw">Clockwise</option><option value="ccw">Counterclockwise</option></select></label><label class="mission-parameter-field"><span>Duration</span><input aria-label="Requested loiter duration" value="Until another operator command" readonly></label></div>
              <div class="loiter-local-preview" aria-label="Local loiter circle preview"><svg viewBox="0 0 150 120" aria-hidden="true"><circle cx="75" cy="60" r="43"/><path d="M75 60 H118"/><path :d="form.direction==='cw'?'M116 44 L118 59 L130 50':'M107 62 L118 47 L129 61'" class="loiter-preview-arrow"/><circle cx="75" cy="60" r="3"/></svg><span><b>{{form.radiusM||'—'}} m · {{form.direction==='cw'?'Clockwise':'Counterclockwise'}}</b><small>Local plan preview · not the observed aircraft path</small></span></div>
              <p class="mission-touch-note">Timed or turn-count loiters are authored as mission items. This immediate GUIDED loiter has no timed exit.</p>
            </template>
            <div class="mission-form-actions"><button type="button" @click="close">Cancel</button><button class="mission-primary" type="submit" :disabled="!!reason">Review {{actionKind==='direct'?'Direct-To':actionKind}}</button></div>
          </form>
        </div>
      </section>
    </div>
  </div>
</template>
<script setup>
import FlightUnits from './FlightUnits.vue';
import FlightUnitInput from './FlightUnitInput.vue';
import {units,unitLabels,unitText} from './flight-units.mjs';
import {computed, nextTick, onBeforeUnmount, reactive, ref} from 'vue';
import {flightAnnunciation, flightAvailability, flightModes, flightRequest, missionExecutionState} from './flight-workflow.mjs';
const props=defineProps({snapshot:{type:Object,default:()=>({})},available:Boolean,selectedTarget:Object,options:{type:Object,default:()=>({})}});
const emit=defineEmits(['request','pick-target','option']);
const selectedUnits=computed(()=>units(props.options));
const editGeneration=ref(null);
const panel=ref(null),targetKind=ref('altitude'),error=ref(''),dialog=ref(null);
const form=reactive({headingDeg:'',turnAccelerationMps2:2,lat:'',lon:'',altitudeM:'',datum:'home',verticalRateMps:0,airspeedMps:'',accelerationMps2:1,radiusM:200,direction:'cw'});
const shortcuts=[{kind:'direct',label:'Direct-To',detail:'Position'},{kind:'heading',label:'Heading',detail:'True heading'},{kind:'alt-speed',label:'Altitude / Speed',detail:'GUIDED targets'},{kind:'loiter',label:'Loiter',detail:'Circle target'},{kind:'resume',label:'Resume Mission',detail:'AUTO · current item'},{kind:'rtl',label:'RTL',detail:'Return mode'},{kind:'modes',label:'Modes',detail:'All supported'},{kind:'arm',label:'Arm / Disarm',detail:'Aircraft state'}];
const title=computed(()=>shortcuts.find(item=>item.kind===panel.value)?.label||'Flight controls');
const missionExecution=computed(()=>missionExecutionState(props.snapshot));
const actionKind=computed(()=>panel.value==='alt-speed'?targetKind.value:panel.value==='resume'?(missionExecution.value.kind||'resume'):panel.value);
const reason=computed(()=>panel.value&&editGeneration.value!==props.snapshot.identity?.generation?'The aircraft changed while editing. Close and reopen these controls.':flightAvailability(actionKind.value,props.snapshot,props.available));
const modes=computed(()=>flightModes(props.snapshot));
const actual=computed(()=>flightAnnunciation(props.snapshot,props.options));
let previousFocus=null;
async function open(kind,target){
  const aliases={altitude:'alt-speed',airspeed:'alt-speed',speed:'alt-speed',mode:'modes'};
  targetKind.value=['airspeed','speed'].includes(kind)?'speed':'altitude';
  if(!panel.value)previousFocus=document.activeElement;
  editGeneration.value=props.snapshot.identity?.generation;
  panel.value=aliases[kind]||kind;error.value='';
  const t=props.snapshot.telemetry||{};
  Object.assign(form,{headingDeg:t.headingDeg??'',lat:t.latitude??'',lon:t.longitude??'',altitudeM:t.relativeAltitudeM??'',datum:'home',airspeedMps:Number.isFinite(t.airspeedKt)?Math.round(t.airspeedKt*.514444*10)/10:''},props.selectedTarget||{},target||{});
  await nextTick();dialog.value?.querySelector('button,input,select')?.focus();
}
function close(){panel.value=null;previousFocus?.isConnected&&previousFocus.focus()}
function submit(kind,values=form){
  error.value='';
  const blocked=reason.value||flightAvailability(kind,props.snapshot,props.available);
  if(blocked){error.value=blocked;return}
  try{const request=flightRequest(kind,values,props.snapshot);const u=selectedUnits.value;if(kind==='altitude')request.label=`GUIDED · altitude ${unitText(request.action.altitudeM,u.altitudeUnit)} ${values.datum==='home'?'above home':'MSL'} · requested rate ${request.action.verticalRateMps?unitText(request.action.verticalRateMps,u.verticalSpeedUnit):'aircraft maximum'} · rate response unverified`;if(kind==='speed')request.label=`GUIDED · airspeed ${unitText(request.action.airspeedMps,u.speedUnit,1)} · ${request.action.accelerationMps2} m/s² acceleration`;if(['direct','loiter'].includes(kind))request.label=`GUIDED · ${kind==='loiter'?('loiter '+request.action.radiusM+' m '+request.action.direction):'Direct-To'} · ${request.action.target.lat.toFixed(6)}°, ${request.action.target.lon.toFixed(6)}° · ${unitText(request.action.target.altitudeM,u.altitudeUnit)} ${values.datum==='home'?'above home':'MSL'}`;emit('request',request);close()}catch(e){error.value=e.message}
}
function pickTarget(){emit('pick-target',{kind:panel.value,target:{...form}});close()}
function keyboard(event){
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}
  if(event.key==='Tab'){
    const controls=[...dialog.value.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)')].filter(el=>el.getClientRects().length),first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}
  }
}
onBeforeUnmount(()=>previousFocus?.isConnected&&previousFocus.focus());
defineExpose({open,close});
</script>
