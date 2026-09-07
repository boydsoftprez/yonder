<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <fieldset class="cockpit-data-settings"><legend>Our aircraft breadcrumbs</legend>
    <label><input type="checkbox" :checked="options.enabled" @change="change('enabled',$event.target.checked)" /> Show aircraft trail</label>
    <label>Trail window<select aria-label="Aircraft trail window" :value="options.mode" @change="change('mode',$event.target.value)">
      <option value="time">Last X minutes</option><option value="distance">Last X miles</option><option value="power">Since power-on</option>
    </select></label>
    <label v-if="options.mode==='time'">Minutes<input aria-label="Aircraft trail minutes" type="number" min="1" max="1440" :value="options.minutes" @change="change('minutes',Number($event.target.value))" /></label>
    <template v-if="options.mode==='distance'">
      <label>Distance<input aria-label="Aircraft trail distance" type="number" min="0.1" max="1000" step="0.1" :value="options.distance" @change="change('distance',Number($event.target.value))" /></label>
      <label>Distance units<select aria-label="Aircraft trail distance units" :value="options.unit" @change="change('unit',$event.target.value)"><option value="nm">Nautical miles (NM)</option><option value="mi">Miles (mi)</option></select></label>
      <p>Distance follows the observed path flown, including turns and loiter circles.</p>
    </template>
    <p role="status">{{status.label}} · {{status.message}}</p>
    <div class="cockpit-actions"><button @click="$emit('clear')">Clear displayed trail</button><button @click="$emit('restore')">Restore recorded trail</button></div>
    <p>Gold dots mark the observed path. The dashed cyan line is the future-motion forecast. Recording continues with the display hidden; these controls send no flight commands.</p>
  </fieldset>
</template>
<script>
import {trailPreferences} from './own-trail.mjs';
export default {name:'OwnTrailSettings',props:{options:Object,status:Object},emits:['change','clear','restore'],methods:{change(key,value){this.$emit('change',trailPreferences({...this.options,[key]:value}))}}};
</script>
