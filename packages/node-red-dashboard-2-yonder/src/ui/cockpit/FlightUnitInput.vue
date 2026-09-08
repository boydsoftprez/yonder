<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template><input type="number" :value="display" :min="toDisplay(min,unit)??undefined" :max="toDisplay(max,unit)??undefined" step="any" @input="$emit('update:modelValue',fromDisplay($event.target.value,unit)??'')"></template>
<script setup>
import {computed} from 'vue';
import {toDisplay,fromDisplay} from './flight-units.mjs';
const props=defineProps({modelValue:[Number,String],unit:String,min:Number,max:Number});defineEmits(['update:modelValue']);
const display=computed(()=>{if(props.modelValue===''||props.modelValue===null||props.modelValue===undefined)return '';const value=toDisplay(Number(props.modelValue),props.unit);return value===null?'':Number(value.toFixed(6))});
</script>
