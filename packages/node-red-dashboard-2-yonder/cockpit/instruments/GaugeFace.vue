<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<svg class="eis-gauge" :class="'eis-'+style" :viewBox="`0 0 190 ${height}`" role="img" :aria-label="`${gauge.label}: ${valid?display+' '+gauge.unit:'data unavailable'}`">
 <title>{{gauge.label}} — {{valid?display+' '+gauge.unit:'data unavailable'}}</title>
 <text x="95" y="20" class="eis-title">{{gauge.label}}</text>
 <template v-if="style==='arc'">
  <path :d="arc(0,1)" class="scale-back"/>
  <path v-for="(band,i) in gauge.bands" :key="i" :d="arc(fraction(band[0]),fraction(band[1]))" :stroke="band[2]" class="scale-band"/>
  <g v-for="tick in ticks" :key="tick">
   <line :x1="point(fraction(tick),54).x" :y1="point(fraction(tick),54).y" :x2="point(fraction(tick),64).x" :y2="point(fraction(tick),64).y" class="scale-tick"/>
   <text :x="point(fraction(tick),76).x" :y="fraction(tick)===.5?52:point(fraction(tick),76).y+4" class="scale-label">{{tick}}</text>
  </g>
  <g v-if="valid" transform="translate(95 91)"><path d="M-6 -49 L0 -70 L6 -49Z" class="eis-pointer" :style="{transform:`rotate(${-112+224*fraction(value)}deg)`}"/></g>
  <text x="95" y="91" class="eis-number" :fill="tone">{{display}}</text><text x="95" y="109" class="eis-unit">{{gauge.unit}}</text>
  <text x="95" y="140" class="eis-secondary">{{secondary}}</text>
 </template>
 <template v-else-if="style==='vertical'">
  <rect x="89" y="39" width="12" height="61" class="scale-back-fill"/>
  <rect v-for="(band,i) in gauge.bands" :key="i" x="89" :y="100-61*fraction(band[1])" width="12" :height="61*(fraction(band[1])-fraction(band[0]))" :fill="band[2]"/>
  <g v-for="tick in ticks" :key="tick"><line x1="83" x2="106" :y1="100-61*fraction(tick)" :y2="100-61*fraction(tick)" class="scale-tick"/><text x="69" :y="104-61*fraction(tick)" text-anchor="end" class="scale-label">{{tick}}</text></g>
  <path v-if="valid" :d="`M112 ${100-61*fraction(value)}l16 -6v12Z`" class="eis-pointer"/>
  <text x="95" y="124" class="eis-number" :fill="tone">{{display}}<tspan class="eis-unit"> {{gauge.unit}}</tspan></text>
  <text x="95" y="144" class="eis-secondary">{{secondary}}</text>
 </template>
 <template v-else>
  <rect x="17" y="44" width="156" height="9" class="scale-back-fill"/>
  <rect v-for="(band,i) in gauge.bands" :key="i" :x="17+156*fraction(band[0])" y="44" :width="156*(fraction(band[1])-fraction(band[0]))" height="9" :fill="band[2]"/>
  <g v-for="tick in ticks" :key="tick"><line :x1="17+156*fraction(tick)" :x2="17+156*fraction(tick)" y1="42" y2="57" class="scale-tick"/><text :x="17+156*fraction(tick)" y="72" class="scale-label">{{tick}}</text></g>
  <path v-if="valid" :d="`M${17+156*fraction(value)} 44l-6 -17h12Z`" class="eis-pointer"/>
  <text x="95" y="103" class="eis-number" :fill="tone">{{display}}<tspan class="eis-unit"> {{gauge.unit}}</tspan></text>
  <text x="95" y="126" class="eis-secondary">{{secondary}}</text>
 </template>
 <path v-if="!valid" d="M44 33L146 120M146 33L44 120" stroke="#e6433f" stroke-width="3"/>
</svg>
</template>
<script setup>
import {computed} from 'vue';
const props=defineProps({gauge:Object,value:Number,secondary:String,appearance:String});
const style=computed(()=>props.appearance||props.gauge.style||'horizontal');
const valid=computed(()=>Number.isFinite(props.value));
const display=computed(()=>valid.value?props.value.toLocaleString('en-US',{minimumFractionDigits:props.gauge.precision||0,maximumFractionDigits:props.gauge.precision||0}):'—');
const fraction=n=>Math.max(0,Math.min(1,(n-props.gauge.min)/(props.gauge.max-props.gauge.min)));
const point=(f,r)=>({x:95+Math.sin((-112+224*f)*Math.PI/180)*r,y:91-Math.cos((-112+224*f)*Math.PI/180)*r});
const arc=(start,end)=>{const a=point(start,59),b=point(end,59);return `M${a.x} ${a.y}A59 59 0 ${224*(end-start)>180?1:0} 1 ${b.x} ${b.y}`};
const ticks=computed(()=>props.gauge.ticks||[props.gauge.min,(props.gauge.min+props.gauge.max)/2,props.gauge.max]);
const tone=computed(()=>{if(!valid.value)return '#fff';const b=props.gauge.bands?.find(b=>props.value>=b[0]&&props.value<=b[1]);return b?.[2]||'#fff'});
const height=computed(()=>style.value==='vertical'?155:style.value==='arc'?150:137);
</script>
<style scoped>
.eis-gauge{display:block;width:100%;height:100%;overflow:visible;font-family:Arial,sans-serif;font-variant-numeric:tabular-nums;text-anchor:middle;color:#fff}
.eis-title{font-size:16px;fill:#fff;font-weight:600}.scale-back{fill:none;stroke:#465158;stroke-width:9}.scale-band{fill:none;stroke-width:9}.scale-back-fill{fill:#465158}.scale-tick{stroke:white;stroke-width:1.4}.scale-label{font-size:11px;fill:#f8fafb;paint-order:stroke;stroke:#040b10;stroke-width:2px;stroke-linejoin:round}.eis-number{font-size:28px;font-weight:600;paint-order:stroke;stroke:#030809;stroke-width:1.6px}.eis-unit{font-size:14px;fill:#fff;font-weight:400}.eis-secondary{font-size:13px;fill:#d4e4eb}.eis-pointer{fill:#fff;stroke:#020607;stroke-width:1.4;transition:transform .4s linear}
@media(prefers-reduced-motion:reduce){.eis-pointer{transition:none}}
</style>
