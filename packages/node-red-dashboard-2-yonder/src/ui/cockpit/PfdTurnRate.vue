<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <g class="pfd-turn-rate" :aria-label="state.degS===null?'Turn rate unavailable':`Turn rate ${Math.abs(state.degS).toFixed(1)} degrees per second ${state.degS<0?'left':'right'}`">
    <title>Six-second heading trend · inner marks 1.5°/s · outer marks 3°/s</title>
    <path :d="turnArcPath(-24)+ ' '+turnArcPath(24)" class="turn-track"/>
    <line v-for="angle in [-18,-9,9,18]" :key="angle" x1="0" y1="-124" x2="0" :y2="Math.abs(angle)===18?-137:-133" :transform="`rotate(${angle})`" class="turn-tick"/>
    <path v-if="state.vectorDeg!==null" class="turn-vector" :d="turnArcPath(state.vectorDeg)"/>
    <path v-if="state.overrange" class="turn-overrange" :transform="`rotate(${state.vectorDeg})`" :d="state.vectorDeg>0?'M-5 -131 L2 -125 L-5 -119':'M5 -131 L-2 -125 L5 -119'"/>
    <text v-if="state.degS===null" x="70" y="-116" class="turn-unavailable">TURN —</text>
  </g>
</template>
<script setup>
import {turnArcPath} from './turn-cues.mjs';
defineProps({state:{type:Object,required:true}});
</script>
<style scoped>
.turn-track{stroke:#fff;stroke-opacity:.65;stroke-width:1.5;fill:none}
.turn-tick{stroke:#fff;stroke-width:3;filter:drop-shadow(0 1px 1px #07141c)}
.turn-vector,.turn-overrange{stroke:#ff70ed;stroke-width:5;fill:none;stroke-linejoin:round}
.turn-unavailable{fill:#f4d09a;font-size:10px;paint-order:stroke;stroke:#07141c;stroke-width:2}
</style>
