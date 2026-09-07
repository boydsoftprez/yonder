<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <button class="pfd-skid-ball" aria-label="Slip and skid indicator settings" :title="description" @click="$emit('open')">
    <svg viewBox="0 0 160 30" role="img" :aria-label="description">
      <g v-if="state.available">
        <g class="skid-ball-motion" :style="{transform:`translateX(${state.position*65}px)`}"><circle class="skid-ball" cx="80" cy="15" r="11"/></g>
        <path class="skid-center-marks" d="M64 2 V28 M96 2 V28"/>
      </g>
      <text v-else x="80" y="20" text-anchor="middle" class="skid-unavailable">SLIP / SKID —</text>
    </svg>
  </button>
</template>
<script setup>
import {computed} from 'vue';
import {slipSkidState} from './slip-skid.mjs';
const props=defineProps({telemetry:{type:Object,default:()=>({})}});
defineEmits(['open']);
const state=computed(()=>slipSkidState(props.telemetry));
const description=computed(()=>state.value.available
  ? `Slip/skid ball: ${Math.abs(state.value.position)<.03?'centered':state.value.position<0?'left':'right'}; lateral acceleration ${state.value.lateralG.toFixed(2)} g`
  : `Slip/skid unavailable: ${state.value.reason}`);
</script>
<style scoped>
.pfd-skid-ball { position:absolute; z-index:6; padding:0!important; border:0!important; background:transparent!important; color:white!important; min-height:44px; cursor:pointer; touch-action:manipulation }
.pfd-skid-ball:hover,.pfd-skid-ball:focus-visible { outline:1px solid #73e5f1; outline-offset:2px }
svg { display:block; width:100%; height:100%; overflow:visible }
.skid-ball { fill:#fff; stroke:#07141c; stroke-width:2 }
.skid-center-marks { fill:none; stroke:#fff; stroke-width:3.5; filter:drop-shadow(0 1px 1px #07141c) }
.skid-ball-motion { transition:transform .18s linear }
.skid-unavailable { fill:#f4d09a; stroke:#07141c; stroke-width:2.5; paint-order:stroke; font:12px Arial,sans-serif }
@media (prefers-reduced-motion:reduce) { .skid-ball-motion { transition:none } }
</style>
