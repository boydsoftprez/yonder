<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <div class="pfd-telemetry-strip" role="group" aria-label="Aircraft instrument data">
    <button v-for="field in fields" :key="field.key" :aria-label="field.name+' · aircraft status'" @click="$emit('open')">
      <small>{{field.label}}</small><b>{{value(field.key,field.digits)}}<i> {{field.unit}}</i></b>
    </button>
  </div>
</template>
<script>
export default {
  props: ['telemetry', 'live'],
  emits: ['open'],
  setup(props) {
    const fields = [
      {key:'batteryV',label:'BUS',name:'Bus voltage',digits:1,unit:'V'},
      {key:'currentA',label:'CURRENT',name:'Current',digits:1,unit:'A'},
      {key:'batteryPercent',label:'BATTERY',name:'Battery',unit:'%'},
      {key:'throttlePercent',label:'THROTTLE',name:'Throttle',unit:'%'},
      {key:'satellites',label:'GPS',name:'GPS satellites',unit:'SAT'}
    ];
    const value = (key, digits = 0) => props.live && Number.isFinite(props.telemetry[key]) ? props.telemetry[key]
      .toLocaleString('en-US', {maximumFractionDigits: digits}) : '—';
    return {value,fields};
  }
}
</script>
