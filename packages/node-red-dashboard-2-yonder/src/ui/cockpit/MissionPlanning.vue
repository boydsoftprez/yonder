<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
 <section v-show="visible" class="mission-profile" aria-label="Mission terrain profile" :aria-busy="loading">
  <div class="profile-controls"><strong>{{draft?'DRAFT':'AIRCRAFT'}} · ROUTE PROFILE</strong><label>Plan MSL datum<select aria-label="Plan MSL datum" v-model="datumOverride"><option value="aircraft">{{aircraftDatum||'UNKNOWN'}} · aircraft reference</option><option value="EGM96">EGM96</option><option value="NAVD88">NAVD88</option><option value="UNKNOWN">Unknown</option></select></label><button @click="refresh++">Refresh terrain</button></div>
  <button v-if="aircraftSource&&!aircraftConsent" class="profile-aircraft-load" @click="aircraftConsent=true">Load route terrain from aircraft · up to 32 MiB decoded</button>
  <p class="profile-status" role="status">{{loading?(report.samples?.length?'Updating terrain · previous profile shown':'Loading route terrain…'):report.reason}}<template v-if="report.samples?.length"> · ground {{Math.round(report.groundCount/report.samples.length*100)}}% · surface {{Math.round(report.surfaceCount/report.samples.length*100)}}%</template></p>
  <svg v-if="report.samples?.length" class="profile-chart" viewBox="0 0 700 250" role="img" aria-label="Planned altitude, ground and mapped surface along the mission">
   <defs><pattern id="profile-unknown" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M0 8 L8 0" stroke="#566775" stroke-width="1"/></pattern></defs>
   <rect x="52" y="15" width="630" height="190" fill="url(#profile-unknown)" opacity=".25"/>
   <g v-for="tick in axis" :key="tick.height"><line x1="52" x2="682" :y1="tick.y" :y2="tick.y" stroke="#405362"/><text x="46" :y="tick.y+4" text-anchor="end">{{tick.label}}</text></g>
   <path v-for="(d,i) in paths('groundM',true)" :key="'g'+i" :d="d" fill="#596e45" stroke="#90a876"/>
   <path v-for="(d,i) in paths('surfaceM',false)" :key="'s'+i" :d="d" fill="none" stroke="#ecb769" stroke-width="2"/>
   <path v-for="(d,i) in paths('altitudeM',false)" :key="'p'+i" :d="d" fill="none" stroke="#fb7aeb" stroke-width="2.8"/>
   <line v-if="probe" :x1="x(probe.distanceM)" :x2="x(probe.distanceM)" y1="15" y2="205" stroke="#76e5f0" stroke-width="1.5"/>
   <g v-for="w in plottedWaypoints" :key="w.seq" class="profile-waypoint" role="button" tabindex="0" :aria-label="`Inspect waypoint ${w.seq} in profile`" @click="selectedSeq=w.seq" @keydown.enter="selectedSeq=w.seq"><line :x1="x(w.distanceM)" :x2="x(w.distanceM)" y1="15" y2="205" stroke="#b4cbd650" stroke-dasharray="3 4"/><circle :cx="x(w.distanceM)" :cy="y(w.altitudeM)" r="5" :fill="w.seq===selectedSeq?'#fff':'#fb7aeb'"/><text :x="x(w.distanceM)" y="222" text-anchor="middle">{{String(w.seq).padStart(2,'0')}}</text></g>
   <text x="52" y="243">DISTANCE · {{(route.totalM/1852).toFixed(2)}} NM</text><text x="680" y="243" text-anchor="end">{{unitLabels[selectedUnits.altitudeUnit]}} MSL · {{datum}}</text>
  </svg>
  <p v-else class="profile-empty">Add two geographic route points to see their profile.</p>
  <div class="profile-legend"><span class="planned">━ Planned altitude</span><span class="ground">━ Ground</span><span class="surface">━ Mapped surface</span><span>▨ Unknown coverage</span></div>
  <label v-if="report.samples?.length" class="profile-probe">Inspect along route<input type="range" aria-label="Inspect distance along route" min="0" :max="report.samples.length-1" step="1" v-model.number="probeIndex"><span v-if="probe">{{(probe.distanceM/1852).toFixed(2)}} NM · {{unitText(probe.aglM,selectedUnits.altitudeUnit)}} AGL · {{unitText(probe.clearanceM,selectedUnits.altitudeUnit)}} above mapped surface</span></label>
  <div class="profile-selection" v-if="selectedWaypoint"><label>Inspect waypoint<select aria-label="Profile waypoint" v-model.number="selectedSeq"><option v-for="w in report.waypoints" :key="w.seq" :value="w.seq">WP{{String(w.seq).padStart(2,'0')}}</option></select></label><strong>{{unitText(selectedWaypoint.altitudeM,selectedUnits.altitudeUnit)}} MSL</strong><span>{{unitText(selectedWaypoint.aglM,selectedUnits.altitudeUnit)}} AGL</span><span :class="{conflict:selectedWaypoint.clearanceM!==null&&selectedWaypoint.clearanceM<0}">{{unitText(selectedWaypoint.clearanceM,selectedUnits.altitudeUnit)}} above mapped surface</span><button :disabled="loading" @click="$emit('select',{seq:selectedWaypoint.seq,editAltitude:true})">Edit waypoint altitude</button></div>
  <p class="profile-note">Planned straight legs · sampled centreline, {{sampleSpacing}} m nominal spacing. Turns, climb performance and unobserved obstacles are not represented. Gaps mean unavailable data.</p>
  <p v-if="report.limited||report.errors" class="profile-note">Partial terrain load: {{report.errors||0}} tile failures{{report.limited?' · tile/byte limit reached':''}}. Missing samples stay unavailable.</p>
  <p v-if="report.sampledDistanceM<route.totalM-1" class="profile-note">Sample budget reached; later route segments are not shown.</p>
  <p v-for="note in route.limitations" :key="note" class="profile-note">{{note}}</p>
  <details v-if="report.manifest"><summary>Terrain source &amp; survey</summary><p>{{report.manifest.title}} · {{report.manifest.sourceResolutionM}} m native data · {{report.manifest.verticalDatum}}</p><p>{{report.manifest.surfaceDescription}}</p><p v-for="source in report.manifest.sources" :key="source.id">{{source.attribution}} · {{source.surveyStart}}–{{source.surveyEnd}}</p><p v-for="note in report.manifest.limitations" :key="note">{{note}}</p></details>
 </section>
</template>
<script setup>
import {computed,shallowRef,ref,watch,onBeforeUnmount} from 'vue';
import {planRoute,buildMissionProfile} from './mission-profile.mjs';
import {loadMissionTerrain} from './mission-terrain.mjs';
import {units,unitText,unitLabels,toDisplay} from './flight-units.mjs';
const props=defineProps({mission:Object,provider:Object,enabled:Boolean,visible:Boolean,draft:Boolean,options:Object,aircraftDatum:String});
const emit=defineEmits(['report','select']);
const report=shallowRef({samples:[],waypoints:[],reason:'Terrain not loaded'}),loading=ref(false),refresh=ref(0),selectedSeq=ref(null),datumOverride=ref('aircraft');
const selectedUnits=computed(()=>units(props.options)),datum=computed(()=>datumOverride.value==='aircraft'?props.aircraftDatum||'UNKNOWN':datumOverride.value);
const probeIndex=ref(0),probe=computed(()=>report.value.samples?.[Math.min(probeIndex.value,report.value.samples.length-1)]);
const sourceRevision=ref(0),aircraftConsent=ref(false);let unsubscribe;
watch(()=>props.provider,p=>{unsubscribe?.();sourceRevision.value++;aircraftConsent.value=false;unsubscribe=p?.subscribe?.(()=>{sourceRevision.value++;aircraftConsent.value=false})},{immediate:true});
const aircraftSource=computed(()=>{sourceRevision.value;return props.provider?.options?.mode==='aircraft'});
const route=computed(()=>planRoute(props.mission));let timer,controller,generation=0,lastPlanKey;
watch(()=>JSON.stringify([props.mission,props.enabled,sourceRevision.value,aircraftConsent.value,datum.value,refresh.value]),()=>{
 clearTimeout(timer);controller?.abort();const token=++generation;
 const pending={...buildMissionProfile(route.value,props.mission?.home),reason:props.enabled?'Loading terrain':'Terrain disabled'};
 const planKey=JSON.stringify([props.mission?.items,sourceRevision.value,datum.value]),homeOnly=planKey===lastPlanKey;lastPlanKey=planKey;
 // Keep controls and chart nodes stable while replacing their data atomically.
 // The table receives unavailable estimates until the new plan is resolved.
 if(!report.value.samples?.length||!props.enabled)report.value=pending;if(!homeOnly)emit('report',pending);loading.value=false;
 if(!props.enabled)return;
 if(aircraftSource.value&&!aircraftConsent.value){report.value={...pending,reason:'Route terrain from the aircraft requires an explicit load'};emit('report',report.value);return;}
 loading.value=true;timer=setTimeout(async()=>{const local=new AbortController();controller=local;
  try{const value=await loadMissionTerrain({route:route.value,home:props.mission?.home,datum:datum.value,provider:props.provider,signal:local.signal});if(token===generation){report.value=value;emit('report',value)}}
  catch(e){if(token===generation&&e.name!=='AbortError'){report.value={...pending,reason:e.message};emit('report',report.value)}}
  finally{if(token===generation)loading.value=false}
 },homeOnly?0:180);
},{immediate:true});
onBeforeUnmount(()=>{unsubscribe?.();clearTimeout(timer);controller?.abort();generation++});
watch(()=>report.value.waypoints,items=>{if(!items.some(w=>w.seq===selectedSeq.value))selectedSeq.value=items[0]?.seq??null});
const selectedWaypoint=computed(()=>report.value.waypoints?.find(w=>w.seq===selectedSeq.value));
const plottedWaypoints=computed(()=>report.value.compatible?report.value.waypoints.filter(w=>Number.isFinite(w.altitudeM)):[]);
const extent=computed(()=>{const h=(report.value.samples||[]).flatMap(p=>[p.groundM,p.surfaceM,p.altitudeM]).filter(Number.isFinite);const min=h.length?Math.min(...h):0,max=h.length?Math.max(...h):100;return {min:min-20,max:Math.max(min+60,max+20)}});
const x=d=>52+630*d/Math.max(1,route.value.totalM),y=h=>205-190*(h-extent.value.min)/(extent.value.max-extent.value.min);
const axis=computed(()=>Array.from({length:5},(_,i)=>{const height=extent.value.min+(extent.value.max-extent.value.min)*i/4;return {height,y:y(height),label:Math.round(toDisplay(height,selectedUnits.value.altitudeUnit))}}));
const sampleSpacing=computed(()=>Math.max(2,route.value.totalM/Math.max(1,2048-route.value.legs.length*2)).toFixed(1));
function paths(key,fill){const result=[];let group=[];const flush=()=>{if(group.length>1){let d=group.map((p,i)=>`${i?'L':'M'}${x(p.distanceM).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');if(fill)d+=` L${x(group.at(-1).distanceM)} 205 L${x(group[0].distanceM)} 205 Z`;result.push(d)}group=[]};for(const p of report.value.samples||[]){if(!Number.isFinite(p[key])){flush();continue}if(group.length&&group.at(-1).legIndex!==p.legIndex)flush();group.push(p)}flush();return result}
</script>
<style scoped>
.profile-probe{display:grid;gap:5px;margin:12px 0;font-size:11px;color:#a7e3ec}.profile-probe input{width:100%;min-height:32px}.mission-profile{min-height:0;overflow:auto;padding:10px;background:#0b1a24;flex:1;color:#e4f0f7}.profile-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:11px}.profile-controls label,.profile-selection label{display:grid;gap:4px;font-size:10px}.profile-controls strong{margin-right:auto}.profile-controls select,.profile-controls button,.profile-selection button,.profile-selection select{background:#1b3343;color:#e5f4ff;border:1px solid #627c8b;border-radius:4px;padding:7px;min-height:38px}.profile-status{font-size:11px;color:#c9dae4}.profile-chart{display:block;width:100%;min-height:220px}.profile-chart text{font-size:10px;fill:#e1edf5}.profile-waypoint{cursor:pointer}.profile-waypoint:focus{outline:2px solid cyan}.profile-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px}.planned{color:#fb7aeb}.ground{color:#90a876}.surface{color:#ecb769}.profile-selection{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:12px 0;font-size:12px}.profile-selection .conflict{color:#ff8585}.profile-note,details{font-size:11px;line-height:1.5;color:#b6cbd8}.profile-empty{padding:20px;text-align:center}
</style>
