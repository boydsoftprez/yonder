<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
 <div ref="list" class="cockpit-mission-list waypoint-table" @wheel.passive="$emit('pause-follow')" @touchstart.passive="$emit('pause-follow')">
  <div class="waypoint-table-content" :style="{'--rows':mission.items.length}">
   <svg v-if="activeIndex>=0" class="mission-leg-connector" :viewBox="`0 0 28 ${mission.items.length*64}`" role="img" :aria-label="`Active leg ${progress.fromName||'Direct'} to ${progress.activeName}`" :data-from="progress.fromSeq" :data-to="progress.activeSeq"><path :d="connector"/><path :d="`M18 ${activeIndex*64+27} L25 ${activeIndex*64+32} L18 ${activeIndex*64+37} Z`" class="mission-leg-arrow"/></svg>
   <div v-for="(item,index) in mission.items" :key="item.seq" class="waypoint-row" :class="{active:index===activeIndex,next:!draft&&item.seq===progress.nextSeq}" :data-mission-seq="item.seq" :aria-current="index===activeIndex?'step':undefined">
    <button class="waypoint-name" @click="$emit('select',{seq:item.seq})"><b>{{String(item.seq).padStart(2,'0')}}</b><span>{{name(item)}}<small>{{index===activeIndex?'ACTIVE':!draft&&item.seq===progress.nextSeq?'NEXT IN PLAN':commandName(item)}}</small></span></button>
    <button class="waypoint-altitude" :aria-label="`Edit altitude at waypoint ${item.seq}`" :disabled="!hasAltitude(item)" @click="$emit('select',{seq:item.seq,editAltitude:true})"><strong>{{hasAltitude(item)?unitText(item.alt,selected.altitudeUnit):'— '+unitLabels[selected.altitudeUnit]}}</strong><small>{{hasAltitude(item)?datum(item.frame):'No altitude'}}</small><small class="waypoint-agl">{{unitText(altitudes.get(item.seq)?.aglM,selected.altitudeUnit)}} AGL</small></button>
    <div class="waypoint-leg-data"><strong>{{legData[index]?.course||'—'}}</strong><small>{{legData[index]?.length||'—'}} NM</small></div>
   </div>
  </div>
  <p v-if="!mission.items.length">No received mission items</p>
 </div>
</template>
<script setup>
import {computed,ref,watch,nextTick,onMounted} from 'vue';
import {getCommand} from './mission-commands.mjs';
import {units,unitText,unitLabels} from './flight-units.mjs';
import {bearing,distance,validPosition} from './cockpit-state.mjs';
import {planRoute} from './mission-profile.mjs';
const props=defineProps({mission:{type:Object,default:()=>({items:[]})},progress:{type:Object,default:()=>({})},profile:Object,draft:Boolean,options:Object,follow:Boolean,viewKey:String});
defineEmits(['select','pause-follow']);const list=ref(null),selected=computed(()=>units(props.options));
const activeIndex=computed(()=>props.draft?-1:props.mission.items.findIndex(i=>i.seq===props.progress.activeSeq));
const fromIndex=computed(()=>props.mission.items.findIndex(i=>i.seq===props.progress.fromSeq));
const connector=computed(()=>{const to=activeIndex.value*64+32,from=fromIndex.value*64+32;return fromIndex.value>=0?`M23 ${from} H14 Q8 ${from} 8 ${from+6} V${to-6} Q8 ${to} 14 ${to} H24`:`M3 ${to} H24`});
const altitudes=computed(()=>new Map((props.profile?.waypoints||[]).map(i=>[i.seq,i])));
const commandName=i=>getCommand(i.command)?.label||`Command ${i.command}`;
const name=i=>i.command===16?'WP'+String(i.seq).padStart(2,'0'):commandName(i);
const hasAltitude=i=>getCommand(i.command)?.altitude===true;
const datum=frame=>({0:'MSL',5:'MSL',3:'ABOVE HOME',6:'ABOVE HOME',10:'ABOVE TERRAIN',11:'ABOVE TERRAIN'}[frame]||'UNKNOWN DATUM');
const legData=computed(()=>{const legs=new Map(planRoute(props.mission).legs.map(leg=>[leg.to.seq,leg]));return props.mission.items.map(item=>{const leg=legs.get(item.seq);return leg?{course:Math.round(leg.courseDeg)+'° T',length:(leg.lengthM/1852).toFixed(2)}:null})});
async function followActive(){await nextTick();if(!props.follow||activeIndex.value<0||!list.value?.clientHeight)return;const row=list.value.querySelector('[aria-current="step"]');if(!row)return;
 const height=list.value.clientHeight,wantPrevious=fromIndex.value>=0&&activeIndex.value-fromIndex.value===1&&height>=128;
 list.value.scrollTop=Math.max(0,activeIndex.value*64-(wantPrevious?64:0));
}
watch(()=>[props.progress.activeSeq,props.draft,props.follow,props.viewKey].join('/'),followActive);onMounted(followActive);
</script>
<style scoped>
.waypoint-table{position:relative;min-height:80px;flex:1;overflow:auto}.waypoint-table-content{position:relative;padding-left:28px}.waypoint-row{height:64px;display:grid;grid-template-columns:minmax(100px,1fr) 112px 70px;border-bottom:1px solid #53657388;box-sizing:border-box;gap:3px}.waypoint-row.active{background:#50184e55}.waypoint-row.next{box-shadow:inset 2px 0 #b5d1e2}.waypoint-row button{border:0;border-radius:0;background:#112431aa;text-align:left;min-width:0;height:64px;color:#eaf7ff;padding:5px 7px;display:flex;box-sizing:border-box;cursor:pointer}.waypoint-row button:hover{background:#284455}.waypoint-row button:focus-visible{outline:2px solid #79e6f7;outline-offset:-2px}.waypoint-name{align-items:center;gap:8px}.waypoint-name b{font-size:11px;color:#bbcad6}.waypoint-name span{font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis}.waypoint-name small,.waypoint-altitude small,.waypoint-leg-data small{display:block;font-size:9px;color:#becfda;margin-top:4px;white-space:nowrap}.waypoint-row.active .waypoint-name span,.waypoint-row.active .waypoint-leg-data{color:#fa84ee}.waypoint-row .waypoint-altitude{display:block;border:1px solid #6d899b;border-radius:3px;text-align:right}.waypoint-altitude strong{font-size:14px}.waypoint-altitude .waypoint-agl{color:#85cfda}.waypoint-leg-data{align-content:center;text-align:right;padding:5px;font-size:12px}.mission-leg-connector{position:absolute;top:0;left:0;width:28px;height:calc(var(--rows)*64px);fill:none;stroke:#fb7aeb;stroke-width:2.8;pointer-events:none}.mission-leg-arrow{fill:#fb7aeb;stroke:none}.cockpit-mission:not(.expanded) .waypoint-row{grid-template-columns:minmax(90px,1fr) 104px}.cockpit-mission:not(.expanded) .waypoint-leg-data{display:none}
</style>
