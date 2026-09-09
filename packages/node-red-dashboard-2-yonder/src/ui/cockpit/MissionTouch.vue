<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
<div class="mission-touch-scrim" @click.self="$emit('close')">
  <section ref="root" class="mission-touch" role="dialog" aria-modal="true" :aria-label="title" @keydown="keyboard">
    <header class="mission-touch-header"><button v-if="view!=='context'" class="mission-touch-back" @click="view='context';localError=''" aria-label="Back to mission actions">‹</button><div><small>{{draft?'LOCAL DRAFT':'MISSION CONTROL'}} · AIRCRAFT</small><h2>{{title}}</h2></div><button class="mission-touch-close" @click="$emit('close')" aria-label="Close mission controls">×</button></header>
    <div class="mission-link-status" :class="{connected:linked}"><span>{{linked?'Vehicle connected':'Vehicle unavailable'}}</span><b>{{sitl.mode||'—'}} · {{sitl.armed===true?'ARMED':sitl.armed===false?'DISARMED':'—'}}</b></div>
    <p v-if="sitl.unavailableReason" class="mission-touch-note" role="status">{{sitl.unavailableReason}}</p>
    <div class="mission-command-result pending" role="status" v-if="pending">Waiting for the aircraft response…</div>
    <div class="mission-command-result" :class="{rejected:result.ok===false}" role="status" v-else-if="result"><strong>{{result.state||'Command status'}}</strong><span>{{result.message||result.result}}</span></div>
    <p class="mission-touch-error" role="alert" v-if="error||localError">{{localError||error}}</p>

    <div v-if="view==='context'" class="mission-touch-body">
      <template v-if="selected">
        <div class="mission-selected-summary"><span>{{selectedMeta?.category||'Imported command'}} · MAV_CMD {{selected.command}}</span><b v-if="selectedMeta?.altitude">{{unitText(selected.alt,selectedUnits.altitudeUnit)}} <small>{{datumLabel(selected.frame)}}</small></b><p>{{selectedMeta?.description||'This imported command is preserved. Its parameters can be inspected below.'}}</p></div>
        <div class="mission-touch-section-label">AIRCRAFT ACTIONS</div>
        <div class="mission-action-grid"><button class="mission-execute" :disabled="commandDisabled||!flyTarget" @click="flySelected">Review fly-to<small>GUIDED · use this position and altitude</small></button><button class="mission-execute" :disabled="commandDisabled||!flyTarget" @click="$emit('flight-controls',{kind:'loiter',...flyTarget})">Loiter at this item…<small>Choose radius and direction, then review</small></button><button class="mission-execute" :disabled="commandDisabled||draft" @click="send({action:'set-current',seq:selected.seq})">Set current item<small>Keep the current flight mode</small></button><button class="mission-execute" :disabled="commandDisabled||draft" @click="send({action:'continue-auto',seq:selected.seq})">Continue AUTO from this item<small>Set current item, then select AUTO</small></button></div>
        <p class="mission-touch-note" v-if="!flyTarget">Fly-to requires a fixed geographic position and an MSL or home-relative altitude.</p><p class="mission-touch-note" v-if="draft">Upload and verify the draft before selecting one of its items as the aircraft's current mission item.</p>
        <button v-if="immediateAllowed" class="mission-touch-wide mission-execute" :disabled="commandDisabled" @click="runImmediate">Send {{selectedMeta?.label||'command '+selected.command}} now<small>Immediate aircraft command · uses these parameters</small></button>
        <p class="mission-touch-note" v-if="!immediateAllowed&&selectedMeta?.category!=='Navigation'">This item runs through mission execution. It has no immediate command action enabled here.</p>
        <div class="mission-touch-section-label">EDIT LOCAL DRAFT</div>
        <div class="mission-action-grid"><button :disabled="pending||!selectedMeta" @click="editSelected">Edit parameters<small>Coordinates, altitude datum and parameters</small></button><button aria-label="Change mission action" :disabled="pending" @click="openCatalog(true)">Change action<small>Keep item identity; use new command defaults</small></button><button :disabled="pending" @click="openCatalog()">Insert after this item<small>Choose from {{MISSION_COMMANDS.length}} mission commands</small></button><button :disabled="pending||selectedIndex<=0" @click="modify('move',-1)">Move earlier</button><button :disabled="pending||selectedIndex>=items.length-1" @click="modify('move',1)">Move later</button><button :disabled="pending" @click="modify('delete')">Remove item</button><button @click="view='details'">Inspect all parameters</button></div>
      </template>
      <template v-else-if="selection?.lat!==undefined">
        <div class="mission-selected-summary"><span>MAP POSITION</span><b>{{fmt(selection.lat,7)}}°, {{fmt(selection.lon,7)}}°</b></div>
        <div class="mission-action-grid"><button :disabled="pending" @click="startForm(16,{point:selection,after:items.at(-1)?.seq??null})">Add waypoint here<small>Edit altitude and mission order</small></button><button :disabled="pending" @click="openCatalog()">Add another mission command<small>Navigation, condition or action</small></button><button class="mission-execute" :disabled="commandDisabled" @click="flyPosition">Direct-To here…<small>Choose altitude, then review GUIDED target</small></button><button class="mission-execute" :disabled="commandDisabled" @click="$emit('flight-controls',{kind:'loiter',lat:selection.lat,lon:selection.lon})">Loiter here…<small>Choose altitude, radius and direction</small></button></div>
      </template>
      <template v-else>
        <div class="mission-selected-summary"><span>{{draft?'LOCAL DRAFT':'DISPLAYED MISSION'}} · {{items.length}} ITEMS</span><b>{{mission?.name||'No mission loaded'}}</b></div>
        <div class="mission-action-grid"><button :disabled="pending" @click="openCatalog()">Add mission item<small>{{MISSION_COMMANDS.length}} Mission Planner ArduPlane commands</small></button><button :disabled="pending" @click="$emit('pick-location',{command:16,afterSeq:items.at(-1)?.seq??null})">Add waypoint on map<small>Choose its location by touch</small></button></div>
      </template>

      <div class="mission-touch-section-label">DRAFT & MISSION</div>
      <div class="mission-action-grid mission-compact-actions"><button :disabled="pending||!canUndo" @click="$emit('undo')">Undo edit</button><button :disabled="!mission" @click="$emit('export')">Export .waypoints</button><button class="mission-execute" :disabled="commandDisabled||!draft||!mission" @click="$emit('upload')">Upload draft to aircraft<small>Transfer, then verify readback</small></button><button :disabled="pending||!draft" @click="$emit('use-live')">Show aircraft mission<small>Return to the received mission</small></button></div>
      <template v-if="!selected&&selection?.lat===undefined">
        <div class="mission-touch-section-label">FLIGHT CONTROLS · AIRCRAFT</div>
        <div class="mission-action-grid mission-compact-actions"><button class="mission-execute" :disabled="commandDisabled||sitl.armed===true" @click="send({action:'arm'})">Arm aircraft</button><button class="mission-execute" :disabled="commandDisabled||sitl.armed!==true" @click="send({action:'disarm'})">Disarm aircraft</button></div>
        <button class="mission-touch-wide mission-execute" :disabled="commandDisabled||draft||!mission" @click="$emit('start')">Start aircraft mission<small>Explicit start request · does not silently arm</small></button>
        <p v-if="draft" class="mission-touch-note">You are viewing a local draft. Upload and verify your changes first. To start the uploaded mission, choose Show aircraft mission, then reopen Mission controls.</p>
        <p v-else-if="!mission" class="mission-touch-note">Read and verify the aircraft mission before starting.</p>
        <div class="mission-mode-grid" role="group" aria-label="Aircraft flight mode"><button v-for="mode in (sitl.modes||[])" :key="mode" class="mission-execute" :disabled="commandDisabled" :aria-pressed="sitl.mode===mode" @click="send({action:'mode',mode})">{{mode}}</button></div>
      </template>
      <button class="mission-touch-wide mission-execute" :disabled="commandDisabled" @click="send({action:'mission-clear'})">Clear aircraft mission…<small>Review removal and verify readback</small></button><p class="mission-touch-note">Draft edits stay in this browser until uploaded. An accepted command response is separate from actual mode, mission progress and peripheral effects.</p>
    </div>

    <div v-else-if="view==='catalog'" class="mission-touch-body mission-catalog-body">
      <input class="mission-command-search" v-model="query" type="search" aria-label="Search mission commands" placeholder="Search command, parameter or MAV_CMD ID">
      <div class="mission-categories" role="group" aria-label="Mission command category"><button v-for="c in categories" :key="c" :aria-pressed="category===c" @click="category=c">{{c}}</button></div>
      <p class="mission-touch-note">{{commands.length}} of {{MISSION_COMMANDS.length}} ArduPlane mission commands · {{catalogReplace?'changes the selected local draft item':'inserts a local draft item'}}</p>
      <div class="mission-command-list"><button v-for="command in commands" :key="command.id" :aria-label="(catalogReplace?'Change to ':'Add ')+command.label" @click="chooseCommand(command.id)"><span><b>{{command.label}}</b><small>{{command.category}} · {{command.name}}</small></span><em>{{command.id}}</em><p>{{command.description}}</p></button><p v-if="!commands.length" class="mission-touch-note">No commands match this search.</p></div>
    </div>

    <form v-else-if="view==='form'||view==='fly'" class="mission-touch-body mission-parameter-form" @submit.prevent="view==='fly'?submitFly():submitEdit()">
      <div class="mission-command-heading"><small>{{view==='fly'?'GUIDED TARGET':meta?.category+' · MAV_CMD '+formCommand}}</small><h3>{{view==='fly'?'Choose position and altitude':meta?.label}}</h3><p>{{view==='fly'?'Sends an immediate target to the local aircraft. It does not add a mission item.':meta?.description}}</p></div>
      <p v-if="view==='form'&&homeDatumConversion" class="mission-touch-note" role="status">Enter a new MSL altitude for Set Home. The previous {{selected.alt}} m {{datumLabel(selected.frame)}} value was cleared; it has not been converted to MSL.</p>
      <label class="mission-form-row" v-if="view==='form'&&operation==='insert'"><span>Insert after</span><select aria-label="Insert after mission item" v-model="afterSeq"><option :value="null">Beginning of mission</option><option v-for="item in items" :key="item.seq" :value="item.seq">{{itemLabel(item)}} · {{getCommand?.(item.command)?.label||'Command '+item.command}}</option></select></label>
      <div v-if="loiter" class="mission-loiter-editor">
        <div class="mission-field-grid"><label class="mission-parameter-field"><span>Radius <small>metres</small></span><input v-if="loiter.radiusIndex" aria-label="Loiter radius metres" type="number" min="0" step="any" :value="loiter.radiusM??0" @input="setLoiterRadius($event.target.value)"><input v-else aria-label="Loiter radius source" value="Aircraft WP_LOITER_RAD" readonly><small>{{loiter.radiusIndex?'0 uses the aircraft configured radius.':'Timed loiter uses the aircraft configured radius; only direction is stored here.'}}</small></label><label class="mission-parameter-field"><span>Direction</span><select aria-label="Loiter direction" :value="loiter.direction" @change="setLoiterDirection($event.target.value)"><option v-if="loiter.radiusIndex" value="default">Aircraft default (radius 0)</option><option value="cw">Clockwise</option><option value="ccw">Counterclockwise</option></select></label><label v-if="[17,31].includes(formCommand)" class="mission-parameter-field"><span>Duration</span><input aria-label="Loiter duration" :value="loiter.duration" readonly></label></div>
        <div class="loiter-local-preview" aria-label="Local mission loiter circle preview"><svg viewBox="0 0 150 120" aria-hidden="true"><circle cx="75" cy="60" r="43" :stroke-dasharray="loiter.radiusM?'none':'6 5'"/><path d="M75 60 H118"/><path v-if="loiter.direction!=='default'" :d="loiter.direction==='cw'?'M116 44 L118 59 L130 50':'M107 62 L118 47 L129 61'" class="loiter-preview-arrow"/><circle cx="75" cy="60" r="3"/></svg><span><b>{{loiter.radiusM?loiter.radiusM+' m':'Aircraft configured radius'}} · {{loiter.duration}}</b><small>Local draft preview · {{loiter.direction==='cw'?'Clockwise':loiter.direction==='ccw'?'Counterclockwise':'Aircraft direction'}}</small></span></div>
      </div>
      <FlightUnits :options="options" @option="(key,value)=>$emit('option',key,value)"/>
      <div class="mission-field-grid">
        <label v-for="param in formFields" :key="param.index" class="mission-parameter-field" :class="{'coordinate-field':meta?.location&&[5,6].includes(param.index)}"><span>{{param.label}} <small>P{{param.index}}{{convertedUnit(param)?' · '+unitLabels[convertedUnit(param)]:param.unit?' · '+param.unit:''}}</small></span>
          <select v-if="fieldType(param)==='enum'" :aria-label="param.label+' parameter '+param.index" v-model="fieldValues[param.index]"><option v-if="!param.required" value="">Default</option><option v-for="option in param.options" :key="option.value" :value="String(option.value)">{{option.label}} ({{option.value}})</option></select>
          <FlightUnitInput v-else-if="convertedUnit(param)" :aria-label="param.label+' parameter '+param.index" v-model="fieldValues[param.index]" :unit="convertedUnit(param)" :min="param.min" :max="param.max"/>
          <input v-else type="number" :aria-label="param.label+' parameter '+param.index" v-model="fieldValues[param.index]" :min="param.min" :max="param.max" :step="param.integer?1:'any'" inputmode="decimal" :placeholder="param.required?'Required':'Default'">
          <small class="mission-param-description" v-if="param.description">{{param.description}}</small><small class="mission-param-description" v-if="param.bitmask">Flags: {{param.options.map(o=>o.value+' = '+o.label).join(' · ')}}</small>
        </label>
      </div>
      <label class="mission-form-row" v-if="meta?.altitude||view==='fly'"><span>Altitude datum</span><select aria-label="Mission altitude datum" v-model.number="frame"><option :value="0">Mean sea level (MSL)</option><option v-if="formCommand!==179" :value="3">Above home</option><option v-if="formCommand!==179" :value="10" :disabled="view==='fly'">Above terrain{{view==='fly'?' · unsupported for target':''}}</option><option v-if="frame===5" :value="5">Mean sea level (MSL · INT)</option><option v-if="frame===6&&formCommand!==179" :value="6">Above home (INT)</option><option v-if="frame===11&&view!=='fly'&&formCommand!==179" :value="11">Above terrain (INT)</option></select></label>
      <p class="mission-touch-note" v-if="[10,11].includes(frame)">Terrain-relative mission altitudes need terrain support and data in the autopilot. Immediate fly-to does not use this datum.</p>
      <button v-if="view==='form'&&meta?.location" type="button" class="mission-touch-wide" @click="pickLocation">Choose location on map<small>Keep these parameters while selecting coordinates</small></button>
      <label class="mission-autocontinue" v-if="view==='form'"><span>Continue automatically</span><input type="checkbox" v-model="autocontinue" aria-label="Continue automatically"></label>
      <p class="mission-command-notes" v-if="view==='form'&&meta?.notes">{{meta.notes}}</p><p class="mission-touch-note" v-if="view==='form'&&meta?.capability&&meta.capability!=='Plane mission command; actual firmware acceptance and execution reported separately'">{{meta.capability}}</p>
      <p v-for="warning in validation.warnings||[]" :key="warning" class="mission-touch-note">{{warning}}</p>
      <p class="mission-touch-note" v-if="view==='form'">{{catalogReplace&&operation==='replace'?'Changing action resets command parameters to the new command defaults. Coordinates and altitude datum remain where the new action uses them.':'Active command parameters are shown. Unused imported parameter values are retained.'}} Conditions and DO items follow ArduPlane mission sequencing.</p>
      <div class="mission-form-actions"><button type="button" @click="view='context'">Cancel</button><button class="mission-primary" type="submit" :disabled="view==='fly'?commandDisabled:pending">{{view==='fly'?'Review fly-to request':operation==='replace'?'Save draft item':'Add to draft'}}</button></div>
    </form>

    <div v-else-if="view==='details'&&selected" class="mission-touch-body">
      <p class="mission-touch-note">{{selectedMeta?.description||'Unknown imported command; all values are preserved.'}}</p>
      <dl class="mission-item-details"><div><dt>Command / frame</dt><dd>{{selected.command}} / {{selected.frame}}</dd></div><div><dt>Automatic continuation</dt><dd>{{selected.autocontinue?'Yes':'No'}}</dd></div><div v-for="(value,index) in [...selected.params,selected.lat,selected.lon,selected.alt]" :key="index"><dt>P{{index+1}} · {{selectedMeta?.params.find(p=>p.index===index+1)?.label||'Unused / imported'}}</dt><dd>{{fmt(value,7)}}</dd></div></dl><p class="mission-command-notes" v-if="selectedMeta?.notes">{{selectedMeta.notes}}</p>
    </div>
  </section>
  </div>
</template>
<script>
// Touch mission authoring and explicit commands for the connected aircraft.
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  ref,
  reactive,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick
} from 'vue';
import {
  MISSION_COMMANDS,
  getCommand,
  createMissionItem,
  validateMissionItem
} from './mission-commands.mjs';
import FlightUnitInput from './FlightUnitInput.vue';
import FlightUnits from './FlightUnits.vue';
import {units,unitLabels,unitText} from './flight-units.mjs';
import {changeMissionAction,loiterPresentation} from './mission-action-edit.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const itemLabel = item => 'WP' + String(item.seq).padStart(3, '0');
const datumLabel = frame => ({
  0: 'MSL',
  5: 'MSL',
  3: 'above home',
  6: 'above home',
  10: 'above terrain',
  11: 'above terrain'
} [frame] || 'frame ' + frame);
export default {
  components:{FlightUnitInput,FlightUnits},
  props: {
    mission: Object,
    options:{type:Object,default:()=>({})},
    selection: Object,
    sitl: {
      type: Object,
      default: () => ({})
    },
    busy: Boolean,
    error: String,
    draft: Boolean,
    canUndo: Boolean
  },
  emits: ['close', 'edit', 'command', 'upload', 'undo', 'export', 'use-live', 'pick-location', 'start', 'flight-controls','option'],
  setup(props, {
    emit
  }) {
    const selectedUnits=computed(()=>units(props.options));
    const convertedUnit=p=>p.index===7&&(meta.value?.altitude||view.value==='fly')?selectedUnits.value.altitudeUnit:p.unit==='m/s'&&formCommand.value===178?selectedUnits.value.speedUnit:null;
    const root = ref(null),
      view = ref('context'),
      query = ref(''),
      category = ref('All'),
      catalogReplace = ref(false),
      localError = ref(''),
      formCommand = ref(16),
      operation = ref('insert'),
      editSeq = ref(null),
      afterSeq = ref(null),
      frame = ref(3),
      autocontinue = ref(true),
      fieldValues = reactive({});
    let originalItem = null;
    const previousFocus = document.activeElement;
    const items = computed(() => props.mission?.items || []);
    const selected = computed(() => items.value.find(item => item.seq === props.selection?.seq) || null);
    const selectedMeta = computed(() => selected.value ? getCommand(selected.value.command) : null);
    const meta = computed(() => getCommand(formCommand.value));
    const categories = ['All', 'Navigation', 'Condition', 'Action'];
    const commands = computed(() => {
      const q = query.value.trim().toLowerCase();
      return MISSION_COMMANDS.filter(c => (category.value === 'All' || c.category === category.value) && (!q || [c
        .id, c.name, c.label, c.description, ...c.params.map(p => p.label)
      ].join(' ').toLowerCase().includes(q)));
    });
    const pending = computed(() => props.busy || props.sitl?.busy);
    const linked = computed(() => props.sitl?.available === true && props.sitl?.connected === true);
    const commandDisabled = computed(() => pending.value || !linked.value);
    const selectedIndex = computed(() => items.value.findIndex(item => item.seq === selected.value?.seq));
    const formTitle = computed(() => view.value === 'fly' ? 'Fly to map position' : (operation.value === 'replace' ?
      'Edit ' + (selected.value ? itemLabel(selected.value) : 'mission item') : 'Add mission item'));
    const title = computed(() => ({
      context: selected.value ? itemLabel(selected.value) + ' · ' + (selectedMeta.value?.label || 'Command ' +
          selected.value.command) : props.selection?.lat !== undefined ? 'Map position' :
        'Mission & flight controls',
      catalog: 'Choose a mission command',
      form: formTitle.value,
      fly: formTitle.value,
      details: 'Mission item details'
    } [view.value] || 'Mission controls'));
    const fmt = (value, digits = 0) => Number.isFinite(value) ? value.toLocaleString('en-US', {
      maximumFractionDigits: digits
    }) : value === null ? 'Default' : '—';
    const positionValid = item => item && Number.isFinite(item.lat) && Number.isFinite(item.lon) && Math.abs(item
      .lat) <= 90 && Math.abs(item.lon) <= 180 && (item.lat !== 0 || item.lon !== 0);
    const flyTarget = computed(() => {
      if (selected.value) {
        const item = selected.value;
        if (!selectedMeta.value?.location || !selectedMeta.value?.altitude || !positionValid(item) || !Number
          .isFinite(item.alt) || ![0, 3, 5, 6].includes(item.frame)) return null;
        return {
          lat: item.lat,
          lon: item.lon,
          alt: item.alt,
          frame: item.frame
        };
      }
      return null;
    });
    const immediateAllowed = computed(() => selected.value && (props.sitl?.immediateCommands || []).some(x => (
      typeof x === 'object' ? x.id ?? x.command : x) === selected.value.command));
    const result = computed(() => props.sitl?.lastResult || null);

    function valuesFrom(item) {
      const all = [...(item.params || [0, 0, 0, 0]), item.lat, item.lon, item.alt];
      for (let i = 1; i <= 7; i++) fieldValues[i] = all[i - 1] === null || all[i - 1] === undefined ? '' : String(all[
        i - 1]);
      frame.value = item.frame;
      autocontinue.value = item.autocontinue !== false;
    }

    function currentItem() {
      const values = Array.from({
        length: 7
      }, (_, i) => fieldValues[i + 1] === null || String(fieldValues[i + 1] ?? '').trim() === '' ? null : Number(
        fieldValues[i + 1]));
      return {
        ...(originalItem ? clone(originalItem) : {}),
        seq: editSeq.value ?? 0,
        command: formCommand.value,
        frame: Number(frame.value),
        params: values.slice(0, 4),
        lat: values[4],
        lon: values[5],
        alt: values[6],
        current: false,
        autocontinue: autocontinue.value
      };
    }
    const validation = computed(() => view.value === 'form' && meta.value ? validateMissionItem(currentItem()) : {
      valid: true,
      errors: [],
      warnings: []
    });

    function startForm(command, {
      replace = false,
      item = null,
      point = null,
      after = null
    } = {}) {
      try {
        formCommand.value = command;
        operation.value = replace ? 'replace' : 'insert';
        editSeq.value = replace ? (item?.seq ?? selected.value?.seq) : null;
        afterSeq.value = after;
        const fallback = selected.value || items.value.at(-1);
        originalItem = item ? clone(item) : createMissionItem(command, {
          lat: point?.lat ?? props.selection?.lat ?? fallback?.lat ?? props.mission?.home?.lat ?? 0,
          lon: point?.lon ?? props.selection?.lon ?? fallback?.lon ?? props.mission?.home?.lon ?? 0,
          alt: point?.alt ?? (Number.isFinite(fallback?.alt) ? fallback.alt : 100),
          frame: command === 179 ? 0 : point?.frame ?? (fallback && [0, 3, 5, 6, 10, 11].includes(fallback.frame) ?
            fallback.frame : 3)
        });
        if (point && getCommand(command)?.location) {
          originalItem.lat = point.lat;
          originalItem.lon = point.lon;
        }
        valuesFrom(originalItem);
        view.value = 'form';
        localError.value = '';
      } catch (error) {
        localError.value = error.message;
      }
    }

    function initialize() {
      view.value = 'context';
      localError.value = '';
      query.value = '';
      category.value = 'All';
      const s = props.selection;
      if(s?.editAltitude&&selected.value){editSelected();return;}
      if (s?.action === 'insert' || s?.action === 'replace') startForm(s.command ?? s.item?.command ?? 16, {
        replace: s.action === 'replace',
        item: s.item || null,
        point: s.lat !== undefined ? {
          lat: s.lat,
          lon: s.lon
        } : null,
        after: Object.hasOwn(s, 'afterSeq') ? s.afterSeq : items.value.at(-1)?.seq ?? null
      });
    }
    watch(() => props.selection, initialize, {
      immediate: true
    });
    const focusFirst = async () => {
      await nextTick();
      root.value?.querySelector('input:not(:disabled),button:not(:disabled),select:not(:disabled)')?.focus();
    };
    watch(view, focusFirst);
    onMounted(focusFirst);
    onBeforeUnmount(() => previousFocus?.isConnected && previousFocus.focus());

    function keyboard(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        emit('close');
      }
      if (event.key === 'Tab') {
        const controls = Array.from(root.value?.querySelectorAll(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]'
            ) || []).filter(el => el.getClientRects().length);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }

    function openCatalog(replace = false) {
      catalogReplace.value = replace;
      afterSeq.value = selected.value?.seq ?? items.value.at(-1)?.seq ?? null;
      query.value = '';
      category.value = 'All';
      view.value = 'catalog';
      localError.value = '';
    }

    function chooseCommand(command) {
      if(catalogReplace.value && selected.value) startForm(command,{replace:true,item:changeMissionAction(selected.value,command)});
      else startForm(command,{point:props.selection?.lat!==undefined?props.selection:null,after:afterSeq.value});
    }
    const homeDatumConversion = computed(()=>catalogReplace.value && formCommand.value===179 && selected.value && ![0,5].includes(selected.value.frame));
    const loiter = computed(()=>view.value==='form'?loiterPresentation(currentItem()):null);
    function setLoiterRadius(value) {
      const index=loiter.value?.radiusIndex;if(!index)return;
      fieldValues[index]=String(Math.abs(Number(value))*(loiter.value.direction==='ccw'?-1:1));
    }
    function setLoiterDirection(value) {
      const l=loiter.value;if(!l)return;
      const index=l.radiusIndex||3;
      if(l.radiusIndex && !l.radiusM && value!=='default'){localError.value='Enter a radius greater than zero before choosing direction. Radius zero uses the aircraft default.';return;}
      localError.value='';
      fieldValues[index]=String(value==='default'?0:(value==='ccw'?-1:1)*(l.radiusIndex?l.radiusM:1));
    }

    function pickLocation() {
      emit('pick-location', {
        command: formCommand.value,
        afterSeq: afterSeq.value,
        ...(operation.value === 'replace' ? {
          seq: editSeq.value
        } : {}),
        item: currentItem()
      });
    }

    function submitEdit() {
      if (pending.value) return;
      const check = validateMissionItem(currentItem());
      if (!check.valid) {
        localError.value = check.errors.join(' · ');
        return;
      }
      emit('edit', operation.value === 'replace' ? {
        kind: 'replace',
        seq: editSeq.value,
        item: currentItem()
      } : {
        kind: 'insert',
        afterSeq: afterSeq.value,
        item: currentItem()
      });
    }

    function editSelected() {
      if (selectedMeta.value) startForm(selected.value.command, {
        replace: true,
        item: selected.value
      });
    }

    function modify(kind, direction) {
      if (!selected.value || pending.value) return;
      emit('edit', {
        kind,
        seq: selected.value.seq,
        ...(direction ? {
          direction
        } : {})
      });
    }

    function send(payload) {
      if (!commandDisabled.value) {
        localError.value = '';
        emit('command', payload);
      }
    }

    function flySelected() {
      if (flyTarget.value) send({
        action: 'goto',
        ...flyTarget.value
      });
    }

    function flyPosition() {
      const p = props.selection,
        fallback = items.value.at(-1),
        validDatum = fallback && [0, 3, 5, 6].includes(fallback.frame);
      formCommand.value = 16;
      originalItem = createMissionItem(16, {
        lat: p.lat,
        lon: p.lon,
        alt: validDatum && Number.isFinite(fallback.alt) ? fallback.alt : 100,
        frame: validDatum ? fallback.frame : 3
      });
      valuesFrom(originalItem);
      view.value = 'fly';
      localError.value = '';
    }

    function submitFly() {
      const item = currentItem();
      if (!positionValid(item) || !Number.isFinite(item.alt) || ![0, 3, 5, 6].includes(item.frame)) {
        localError.value = 'Enter a valid latitude, longitude and altitude with MSL or home-relative datum.';
        return;
      }
      send({
        action: 'goto',
        lat: item.lat,
        lon: item.lon,
        alt: item.alt,
        frame: item.frame
      });
    }

    function runImmediate() {
      if (immediateAllowed.value) {
        const item = selected.value;
        send({
          action: 'command',
          command: item.command,
          params: [...item.params, item.lat, item.lon, item.alt],
          frame: 2
        });
      }
    }
    const fieldType = p => p.options?.length && !p.bitmask ? 'enum' : 'number';
    const formFields = computed(() => view.value === 'fly' ? [{
      index: 5,
      label: 'Latitude',
      unit: 'deg',
      required: true,
      min: -90,
      max: 90
    }, {
      index: 6,
      label: 'Longitude',
      unit: 'deg',
      required: true,
      min: -180,
      max: 180
    }, {
      index: 7,
      label: 'Altitude',
      unit: 'm',
      required: true
    }] : (meta.value?.params || []).filter(p=>!loiter.value || p.index!==(loiter.value.radiusIndex||3)).map(p=>loiter.value&&p.index===1?{...p,label:formCommand.value===19?'Duration':'Duration in turns'}:p));
    return {
      selectedUnits,convertedUnit,unitLabels,unitText,
      root,
      view,
      query,
      category,
      localError,
      formCommand,
      operation,
      editSeq,
      afterSeq,
      frame,
      autocontinue,
      fieldValues,
      items,
      selected,
      selectedMeta,
      meta,
      categories,
      commands,
      pending,
      linked,
      commandDisabled,
      selectedIndex,
      title,
      fmt,
      flyTarget,
      immediateAllowed,
      result,
      validation,
      keyboard,
      startForm,
      openCatalog,
      catalogReplace,
      chooseCommand,
      loiter,
      homeDatumConversion,
      setLoiterRadius,
      setLoiterDirection,
      pickLocation,
      submitEdit,
      editSelected,
      modify,
      send,
      flySelected,
      flyPosition,
      submitFly,
      runImmediate,
      fieldType,
      formFields,
      itemLabel,
      datumLabel,
      getCommand,
      MISSION_COMMANDS
    };
  }
}
</script>
