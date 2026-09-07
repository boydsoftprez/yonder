<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <button class="pfd-wind-display" aria-label="Wind display settings" :title="description" @click="$emit('open')">
    <svg viewBox="0 0 128 86" role="img" :aria-label="description">
      <text class="wind-title" x="8" y="14">WIND · KT</text><text class="wind-est" x="118" y="14" text-anchor="end">EST</text>
      <g v-if="wind.available">
        <g v-if="mode==='components'" class="wind-components">
          <path class="wind-stem" d="M10 42 H46 M28 24 V60"/>
          <path v-if="head!==0" class="wind-arrow" :data-direction="head>0?'down':'up'" :d="head>0?'M22 54 L28 60 L34 54':'M22 30 L28 24 L34 30'"/>
          <path v-if="cross!==0" class="wind-arrow" :data-direction="cross>0?'left':'right'" :d="cross>0?'M16 36 L10 42 L16 48':'M40 36 L46 42 L40 48'"/>
          <text class="wind-value" x="65" y="47">{{Math.abs(cross)}}</text>
          <text class="wind-caption" x="65" y="59">{{cross===0?'CROSS':cross>0?'FROM R':'FROM L'}}</text>
          <text class="wind-value" x="28" y="80" text-anchor="middle">{{Math.abs(head)}}</text>
          <text class="wind-caption" x="65" y="79">{{head===0?'HEAD/TAIL':head>0?'HEAD':'TAIL'}}</text>
        </g>
        <g v-else class="wind-vector">
          <g v-if="Math.round(wind.speedKt)>0" :transform="`translate(28 47) rotate(${wind.relativeFromDeg})`"><path class="wind-arrow" d="M0 -18 V18 M-7 11 L0 18 L7 11"/></g>
          <text class="wind-value" x="64" y="49">{{Math.round(wind.speedKt)}}</text>
          <text v-if="mode==='direction'" class="wind-bearing" x="64" y="72">{{bearing}}° T</text>
        </g>
      </g>
      <g v-else class="wind-no-data"><text x="64" y="43" text-anchor="middle">NO WIND</text><text x="64" y="63" text-anchor="middle">DATA</text></g>
    </svg>
  </button>
</template>
<script setup>
import {computed} from 'vue';
import {windState} from './wind-state.mjs';
const props=defineProps({telemetry:{type:Object,default:()=>({})},mode:{type:String,default:'components'}});
defineEmits(['open']);
const wind=computed(()=>windState(props.telemetry));
const head=computed(()=>Math.round(wind.value.headwindKt)||0),cross=computed(()=>Math.round(wind.value.crosswindKt)||0);
const bearing=computed(()=>String(Math.round(wind.value.directionFromDeg)%360).padStart(3,'0'));
const description=computed(()=>wind.value.available
  ? `Estimated wind from ${bearing.value} degrees true at ${Math.round(wind.value.speedKt)} knots; ${Math.abs(head.value)} knots ${head.value<0?'tailwind':'headwind'}; ${Math.abs(cross.value)} knots crosswind${cross.value===0?'':cross.value>0?' from right':' from left'}`
  : `No wind data: ${wind.value.reason}`);
</script>
<style scoped>
.pfd-wind-display { position:absolute; z-index:6; padding:0!important; min-height:0!important; min-width:0; border:1px solid #b1c8cc88!important; border-radius:4px; color:#fff!important; background:#07141cc9!important; cursor:pointer; touch-action:manipulation }
.pfd-wind-display:hover,.pfd-wind-display:focus-visible { outline:2px solid #73e5f1; outline-offset:2px }
svg { display:block; width:100%; height:100%; overflow:visible; font-family:Arial,sans-serif; fill:currentColor }
.wind-title { font-size:10px; font-weight:700; letter-spacing:.3px }
.wind-est { font-size:8px; fill:#c4d4d9 }
.wind-stem,.wind-arrow { fill:none; stroke:currentColor; stroke-width:2.7; stroke-linejoin:round }
.wind-value { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums }
.wind-caption { font-size:9px; fill:#d2e0e4 }
.wind-bearing { font-size:14px }
.wind-no-data { font-size:14px; fill:#f2d5a1 }
</style>
