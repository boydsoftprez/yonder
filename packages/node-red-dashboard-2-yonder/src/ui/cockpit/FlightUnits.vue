<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template><div class="flight-units" aria-label="Flight units"><label v-for="(choices,key) in unitChoices" :key="key"><span>{{names[key]}}</span><select :aria-label="names[key]+' units'" :value="selected[key]" @change="$emit('option',key,$event.target.value)"><option v-for="unit in choices" :key="unit" :value="unit">{{unitLabels[unit]}}</option></select></label></div></template>
<script setup>
import {computed} from 'vue';
import {unitChoices,unitLabels,units} from './flight-units.mjs';
const props=defineProps({options:{type:Object,default:()=>({})}});defineEmits(['option']);
const selected=computed(()=>units(props.options)),names={altitudeUnit:'Altitude',speedUnit:'Speed',verticalSpeedUnit:'Vertical speed'};
</script>
<style scoped>.flight-units{display:flex;flex-wrap:wrap;gap:8px;padding:8px 0}.flight-units label{display:grid;gap:5px;flex:1;min-width:90px;font-size:11px}.flight-units select{width:100%;min-height:40px;background:#142632;color:#edf6fc;border:1px solid #587382;border-radius:4px;padding:5px}</style>
