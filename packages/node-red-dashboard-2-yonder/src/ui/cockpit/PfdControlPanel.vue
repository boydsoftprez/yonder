<template>
<div class="pfd-modal-scrim" @click.self="$emit('close')">
    <section class="pfd-control-panel" ref="root" role="dialog" aria-modal="true" :aria-label="title" @keydown="keyboard">
      <header><div><small>PFD · TOUCH CONTROL</small><h2>{{title}}</h2></div><button @click="$emit('close')" aria-label="Close PFD controls">×</button></header>
      <form v-if="field" @submit.prevent="apply" class="pfd-numeric-form">
        <p class="pfd-control-note">Cyan references are saved on this display. They do not change aircraft targets.</p>
        <label class="pfd-entry-label" :for="'pfd-entry-'+kind">{{field.short}} <span>{{field.unit}}</span></label>
        <div class="pfd-number-entry"><button type="button" @click="step(-field.step)" :aria-label="'Decrease '+field.short">−</button><input ref="input" :id="'pfd-entry-'+kind" :aria-label="field.title+' value'" v-model="draft" inputmode="numeric" autocomplete="off" @input="error=''" placeholder="—"><button type="button" @click="step(field.step)" :aria-label="'Increase '+field.short">+</button></div>
        <div class="pfd-entry-helper"><span>LIVE {{fmt(liveValue)}} {{field.unit}}</span><span>{{field.min.toLocaleString('en-US')}} … {{field.max.toLocaleString('en-US')}}</span></div>
        <p class="pfd-validation" role="alert" v-if="error">{{error}}</p>
        <div class="pfd-keypad"><button type="button" v-for="digit in ['1','2','3','4','5','6','7','8','9']" :key="digit" @click="key(digit)">{{digit}}</button><button type="button" @click="key('sign')" :disabled="field.min>=0" aria-label="Change sign">±</button><button type="button" @click="key('0')">0</button><button type="button" @click="key('back')" aria-label="Backspace">⌫</button></div>
        <div class="pfd-control-actions"><button type="button" @click="step(-field.coarse)">−{{field.coarse}}</button><button type="button" @click="set(liveValue)" :disabled="liveValue===null">Sync live</button><button type="button" @click="step(field.coarse)">+{{field.coarse}}</button></div>
        <button v-if="kind==='altitude'" type="button" class="pfd-wide-button" @click="set(missionAltitude)" :disabled="missionAltitude===null">Use mission altitude · {{fmt(missionAltitude)}} FT MSL</button>
        <p v-if="kind==='altitude'&&missionAltitude===null" class="pfd-control-note">No mission target with a known MSL altitude is available.</p>
        <div class="pfd-control-actions pfd-final-actions"><button type="button" @click="$emit('reference',kind,null);$emit('close')">Clear</button><button type="button" @click="$emit('close')">Cancel</button><button type="submit" class="primary">Apply</button></div>
      </form>
      <div v-else-if="kind==='menu'" class="pfd-menu-grid">
        <button v-for="(f,key) in referenceFields" :key="key" @click="$emit('panel',key)">{{f.title}}<small>{{references[key]===null?'No local reference':fmt(references[key])+' '+f.unit}}</small></button>
        <button @click="$emit('panel','attitude')">Attitude & display<small>Transparency · terrain · declutter</small></button><button @click="$emit('panel','director')">Flight director<small>Cue style & visibility</small></button>
        <button @click="$emit('panel','nav')">Mission navigation<small>Flight plan · direct-to</small></button><button @click="$emit('panel','status')">Aircraft data<small>GPS · battery · source</small></button>
      </div>
      <div v-else-if="kind==='attitude'" class="pfd-options">
        <label class="pfd-option"><span>Synthetic vision<small>{{terrainStatus?.message||'Terrain display'}}</small></span><input type="checkbox" :checked="options.syntheticVision" @change="$emit('option','syntheticVision',$event.target.checked)"></label>
        <label class="pfd-option pfd-range"><span>Tape background <b>{{Math.round(options.tapeOpacity*100)}}%</b></span><input aria-label="Tape background opacity" type="range" min="10" max="100" step="5" :value="options.tapeOpacity*100" @input="$emit('option','tapeOpacity',Number($event.target.value)/100)"></label>
        <label class="pfd-option pfd-range"><span>HSI background <b>{{Math.round(options.hsiOpacity*100)}}%</b></span><input aria-label="HSI background opacity" type="range" min="10" max="100" step="5" :value="options.hsiOpacity*100" @input="$emit('option','hsiOpacity',Number($event.target.value)/100)"></label>
        <label class="pfd-option"><span>Pitch ladder</span><input type="checkbox" :checked="options.pitchLadder" @change="$emit('option','pitchLadder',$event.target.checked)"></label>
        <label class="pfd-option"><span>Secondary readouts<small>Pitch / bank and desired track</small></span><input type="checkbox" :checked="options.secondary" @change="$emit('option','secondary',$event.target.checked)"></label>
        <label class="pfd-option"><span>Instrument strip</span><select aria-label="Instrument strip placement" :value="options.stripPlacement" @change="$emit('option','stripPlacement',$event.target.value)"><option value="mfd">Mission / navigation</option><option value="pfd">PFD</option><option value="hidden">Hidden</option></select></label>
        <button class="pfd-wide-button" @click="navigate('display')">Background, insets &amp; data sources →</button>
        <button class="pfd-wide-button" @click="$emit('panel','director')">Flight director settings →</button>
        <p class="pfd-control-note">Display settings save immediately. Terrain is shown only when elevation data and aircraft pose are available.</p>
        <p class="pfd-control-note" v-if="Number.isFinite(terrainStatus?.estimatedAglM)">Estimated height above terrain: {{fmt(terrainStatus.estimatedAglM/.3048)}} ft · terrain elevation {{fmt(terrainStatus.groundElevationM)}} m MSL. This is the elevation-map estimate, separate from height above home.</p>
        <p class="pfd-control-note" v-if="terrainStatus?.detailState">Nearby imagery: {{terrainStatus.detailState}}{{Number.isFinite(terrainStatus.detailMetresPerPixel)?' · '+fmt(terrainStatus.detailMetresPerPixel,1)+' m/pixel':''}}</p>
        <p class="pfd-control-note" v-if="terrainStatus?.imageryAttributionUrl">Surface imagery: {{terrainStatus.imageryState}} · <a :href="terrainStatus.imageryAttributionUrl" target="_blank" rel="noopener">{{terrainStatus.imageryAttribution}}</a></p>
        <p class="pfd-control-note" v-if="terrainStatus?.attributionUrl"><a :href="terrainStatus.attributionUrl" target="_blank" rel="noopener">{{terrainStatus.attribution}}</a></p>
      </div>
      <div v-else-if="kind==='director'" class="pfd-options">
        <label class="pfd-option"><span>Show flight director</span><input type="checkbox" :checked="options.fdVisible" @change="$emit('option','fdVisible',$event.target.checked)"></label>
        <label class="pfd-option"><span>Cue style</span><select aria-label="Flight director style" :value="options.fdStyle" @change="$emit('option','fdStyle',$event.target.value)"><option value="vbar">V-bar</option><option value="crossbar">Crossbar</option></select></label>
        <dl class="pfd-data-list"><div><dt>Cue data</dt><dd>{{flight.fdValid?'Available':'Unavailable'}}</dd></div><div><dt>Desired pitch</dt><dd>{{fmt(flight.navPitch,1)}}°</dd></div><div><dt>Desired bank</dt><dd>{{fmt(flight.navRoll,1)}}°</dd></div><div><dt>Aircraft mode</dt><dd>{{flight.live?telemetry.mode:'—'}}</dd></div></dl>
        <p class="pfd-control-note">Yellow is the fixed aircraft attitude reference. Magenta is the flight director's commanded pitch and bank from ArduPlane. The autopilot follows these commands; the cues line up as the aircraft reaches the requested attitude.</p>
        <p class="pfd-control-note">Cyan references are local to this display. Fly-to sends a destination and altitude; it does not select a VS, HDG or ALT capture mode. Director cues disappear when their data becomes stale.</p>
      </div>
      <div v-else-if="kind==='nav'" class="pfd-options">
        <dl class="pfd-data-list"><div><dt>Navigation source</dt><dd>{{guidance.preview?'Local preview':guidance.guidanceSource||'MAVLink'}}</dd></div><div><dt>Active item / mode</dt><dd>{{guidance.targetName||(guidance.seq===null||guidance.seq===undefined?'—':'WP'+String(guidance.seq).padStart(3,'0'))}}</dd></div><div><dt>{{guidance.trackTitle||'Desired track'}}</dt><dd>{{guidance.valid&&Number.isFinite(guidance.radialValid?guidance.pathBearingDeg:guidance.desiredTrackDeg)?fmt(guidance.radialValid?guidance.pathBearingDeg:guidance.desiredTrackDeg)+'° TRUE':'—'}}</dd></div><div><dt>Distance</dt><dd>{{guidance.valid?fmt(guidance.distanceM/1852,2)+' NM':'—'}}</dd></div></dl>
        <p v-if="guidance.radialValid" class="pfd-control-note">GUIDED loiter: the magenta pointer identifies the circle center. The crossbar moves toward the center when outside the requested circle, and away when inside. This is radial path error, not a straight-leg course deviation.</p>
        <p class="pfd-control-note" v-if="!guidance.valid">{{guidance.reason||'Waiting for mission guidance'}}</p>
        <div class="pfd-menu-grid"><button @click="navigate('mission')">Mission flight plan</button><button @click="navigate('direct')">Direct-to preview</button><button @click="navigate('waypoints')">Mission waypoints</button><button @click="navigate('settings')">Map settings</button></div>
      </div>
      <div v-else-if="kind==='status'" class="pfd-options">
        <dl class="pfd-data-list"><div><dt>Source</dt><dd>{{telemetry.source||'Waiting'}}</dd></div><div><dt>Instruments</dt><dd>{{flight.live?'Live':'Unavailable'}}</dd></div><div><dt>Mode / arm state</dt><dd>{{flight.live?(telemetry.mode+' / '+(telemetry.armed?'Armed':'Disarmed')):'—'}}</dd></div><div><dt>GPS fix / satellites</dt><dd>{{flight.live?fmt(telemetry.fixType)+' / '+fmt(telemetry.satellites):'—'}}</dd></div><div><dt>Battery</dt><dd>{{flight.live?fmt(telemetry.batteryV,1):'—'}} V · {{flight.live?fmt(telemetry.batteryPercent):'—'}}%</dd></div><div><dt>Current</dt><dd>{{flight.live?fmt(telemetry.currentA,1):'—'}} A</dd></div><div><dt>Terrain</dt><dd>{{terrainStatus?.message||'Off'}}</dd></div></dl>
        <p class="pfd-control-note">The strip shows available MAVLink sensors. Engine RPM, fuel and temperatures require their own telemetry sources.</p><button class="pfd-wide-button" @click="navigate('status')">Mission & data status →</button>
      </div>
    </section>
  </div>
</template>
<script>
// Touch controls for the local Yonder display, not autopilot commands.
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  ref,
  computed,
  onMounted,
  onBeforeUnmount,
  nextTick
} from 'vue';
import {
  referenceFields,
  parseReference,
  referenceStep,
  missionAltitudeFt
} from './pfd-controls.mjs';
export default {
  props: ['kind', 'flight', 'guidance', 'telemetry', 'references', 'options', 'mission', 'terrainStatus'],
  emits: ['close', 'reference', 'option', 'navigate', 'panel'],
  setup(props, {
    emit
  }) {
    const root = ref(null),
      input = ref(null),
      error = ref('');
    const field = computed(() => referenceFields[props.kind]);
    const draft = ref(field.value && props.references[props.kind] !== null ? String(props.references[props.kind]) : '');
    const previousFocus = document.activeElement;
    const titles = {
      menu: 'PFD touch menu',
      attitude: 'Attitude & display',
      nav: 'Mission navigation',
      status: 'Aircraft data',
      director: 'Flight director'
    };
    const title = computed(() => field.value?.title || titles[props.kind]);
    const liveValue = computed(() => props.flight[props.kind] ?? null);
    const missionAltitude = computed(() => missionAltitudeFt(props.guidance.target, props.mission?.home));
    const fmt = (value, digits = 0) => Number.isFinite(value) ? value.toLocaleString('en-US', {
      maximumFractionDigits: digits
    }) : '—';

    function key(value) {
      error.value = '';
      if (value === 'back') draft.value = draft.value.slice(0, -1);
      else if (value === 'sign') draft.value = draft.value.startsWith('-') ? draft.value.slice(1) : '-' + draft.value;
      else if (draft.value.length < 8) draft.value += value;
      input.value?.focus();
    }

    function step(amount) {
      error.value = '';
      let value;
      try {
        value = parseReference(props.kind, draft.value);
      } catch {
        value = liveValue.value;
      }
      draft.value = String(referenceStep(props.kind, value, amount));
    }

    function apply() {
      try {
        emit('reference', props.kind, parseReference(props.kind, draft.value));
        emit('close');
      } catch (e) {
        error.value = e.message;
      }
    }

    function set(value) {
      if (Number.isFinite(value)) {
        draft.value = String(Math.round(value));
        error.value = '';
      }
    }

    function keyboard(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        emit('close');
      }
      if (e.key === 'Tab') {
        const elements = Array.from(root.value?.querySelectorAll(
          'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') || []).filter(
          el => el.tabIndex >= 0 && el.getClientRects().length);
        const first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    onMounted(async () => {
      await nextTick();
      (input.value || root.value?.querySelector('button'))?.focus();
    });
    onBeforeUnmount(() => previousFocus?.isConnected && previousFocus.focus());
    const navigate = page => {
      emit('close');
      emit('navigate', page);
    };
    return {
      root,
      input,
      error,
      field,
      draft,
      title,
      liveValue,
      missionAltitude,
      fmt,
      key,
      step,
      apply,
      set,
      keyboard,
      navigate,
      referenceFields
    };
  }
}
</script>
