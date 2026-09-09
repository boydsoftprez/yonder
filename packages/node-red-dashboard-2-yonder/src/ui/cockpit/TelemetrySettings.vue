<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <fieldset class="cockpit-telemetry-settings"><legend>Flight telemetry cadence</legend>
    <label>Browser update target<select :value="rate" aria-label="Display telemetry updates" @change="$emit('rate',Number($event.target.value))">
      <option v-for="hz in telemetryRates" :key="hz" :value="hz">{{hz}} / second{{hz===8?' · default':''}}</option>
    </select></label>
    <p role="status">Browser received {{hz(stats?.flightHz)}} · new attitude {{hz(stats?.attitudeHz)}}<template v-if="Number.isFinite(stats?.attitudeAgeMs)"> · sample age {{Math.round(stats.attitudeAgeMs)}} ms</template></p>
    <p>The target limits browser reads. Observed rates include link delays and missed samples; they do not measure every packet at the controller. Instruments animate between received samples. System instruments remain at up to 1 update/second.</p>
    <button :disabled="!canRequest" @click="$emit('request')">Request flight telemetry · attitude 10 Hz</button>
    <p>This explicitly requests the controller's flight streams and optional slower sensor reports. It changes reporting rates, not aircraft motion. Acknowledgement does not guarantee the achieved rate.</p>
  </fieldset>
</template>
<script>
import {telemetryRates} from './telemetry-cadence.mjs';
export default {
  props:['rate','stats','canRequest'],emits:['rate','request'],
  setup(){return {telemetryRates,hz:value=>Number.isFinite(value)?`${value.toFixed(1)} Hz`:'— Hz'};},
};
</script>
