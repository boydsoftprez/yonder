<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <div class="flight-mode-annunciator" :class="[state.tone,{unavailable:!state.fresh}]" aria-label="Actual flight mode and command outcome">
    <button class="flight-mode-actual" aria-label="Open aircraft mode picker" @click="$emit('open','modes')"><small>ACTUAL MODE</small><strong>{{state.mode}}</strong></button>
    <button class="flight-mode-arm" aria-label="Open aircraft arm and disarm controls" @click="$emit('open','arm')">{{state.armed}}</button>
    <button class="flight-mode-fd" aria-label="Flight director settings" @click="$emit('director')">{{directorLabel}}</button>
    <div v-if="state.request" class="flight-mode-request" role="status"><span>{{state.request}}</span><small>{{state.outcome}}</small></div>
  </div>
</template>
<script setup>
import {computed} from 'vue';
import {flightAnnunciation} from './flight-workflow.mjs';
const props=defineProps({snapshot:{type:Object,default:()=>({})},directorLabel:{type:String,default:'FD OFF'}});
defineEmits(['open','director']);
const state=computed(()=>flightAnnunciation(props.snapshot));
</script>
