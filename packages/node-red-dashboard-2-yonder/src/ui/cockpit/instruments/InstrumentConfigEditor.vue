<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <!-- Cockpit strips and MFD panes have their own stacking/containment contexts. -->
  <Teleport :to="overlayTarget">
  <div class="instrument-editor-scrim" @click.self="emit('cancel')" @keydown.esc.stop="emit('cancel')" @keydown.tab="trapFocus">
    <section ref="dialog" class="instrument-editor" role="dialog" aria-modal="true" :aria-label="title">
      <header><h2>{{ title }}</h2><button type="button" aria-label="Close instrument editor" @click="emit('cancel')">×</button></header>
      <nav class="slot-tabs" aria-label="Instrument slots">
        <button v-for="(slot, index) in draft" :key="index" type="button" :aria-label="`Edit slot ${index + 1}: ${itemForSlot(items, slot).label}`" :aria-pressed="selected === index" @click="selected = index">{{ index + 1 }}</button>
        <button type="button" aria-label="Add instrument" :disabled="draft.length >= MAX_INSTRUMENT_SLOTS || !nextItem" @click="addSlot">+</button>
      </nav>
      <template v-if="slot">
        <div class="editor-preview"><InstrumentGauge :item="activeItem" :settings="slot" /></div>
        <label>Find a reading<input v-model="query" type="search" aria-label="Search instrument sources" placeholder="Name, category or source" /></label>
        <label>Instrument source<select :value="slot.id" aria-label="Instrument source" @change="setSource(($event.target as HTMLSelectElement).value)">
          <option v-if="!sourceItems.some(item => item.id === slot.id)" :value="slot.id">{{ activeItem.label }} · {{ activeItem.source || slot.id }}</option>
          <optgroup v-for="category in categories" :key="category" :label="category"><option v-for="item in sourceItems.filter(item => item.category === category)" :key="item.id" :value="item.id" :disabled="draft.some((entry, i) => i !== selected && entry.id === item.id)">{{ item.label }} · {{ item.source || item.id }}</option></optgroup>
        </select></label>
        <p class="source-detail">{{ activeItem.source || 'Source not yet reported' }}<br />{{ activeItem.id }}<span v-if="!activeItem.available"><br />{{ activeItem.reason || 'Data unavailable' }}</span></p>
        <label>Presentation<select v-model="slot.kind" aria-label="Presentation"><option :value="undefined">Recommended</option><option v-for="kind in instrumentKinds" :key="kind" :value="kind">{{ kindLabels[kind] }}</option></select></label>
        <fieldset v-if="['arc', 'horizontal', 'vertical'].includes(slot.kind || activeItem.kind || '')">
          <legend>Display scale <span v-if="activeItem.unit">({{ activeItem.unit }})</span></legend>
          <div class="editor-pair"><label>Minimum<input type="number" step="any" :value="slot.min" :placeholder="String(activeItem.min ?? 0)" aria-label="Display minimum" @input="setBound('min', ($event.target as HTMLInputElement).value)" /></label><label>Maximum<input type="number" step="any" :value="slot.max" :placeholder="String(activeItem.max ?? 100)" aria-label="Display maximum" @input="setBound('max', ($event.target as HTMLInputElement).value)" /></label></div>
          <button type="button" class="text-button" @click="clearScale">Use source scale</button>
          <div v-for="(band, index) in slot.bands || []" :key="index" class="band-editor">
            <label>From<input v-model.number="band.from" type="number" step="any" :aria-label="`Band ${index + 1} minimum`" /></label><label>To<input v-model.number="band.to" type="number" step="any" :aria-label="`Band ${index + 1} maximum`" /></label>
            <label>Color<select v-model="band.color" :aria-label="`Band ${index + 1} color`"><option v-for="color in ['neutral', 'normal', 'caution', 'warning']" :key="color" :value="color">{{ color }}</option></select></label><button type="button" :aria-label="`Remove band ${index + 1}`" @click="removeBand(index)">×</button>
          </div>
          <button type="button" aria-label="Add display band" :disabled="(slot.bands?.length || 0) >= 8" @click="addBand">Add display band</button>
        </fieldset>
        <div class="editor-order"><button type="button" aria-label="Move earlier" :disabled="selected === 0" @click="move(-1)">Move earlier</button><button type="button" aria-label="Move later" :disabled="selected === draft.length - 1" @click="move(1)">Move later</button><button type="button" aria-label="Remove instrument" @click="removeSlot">Remove</button></div>
      </template>
      <p v-else class="source-detail">No fields selected. Add a reading or restore the defaults.</p>
      <p class="display-note">Colored starter bands are editable display presets. Set scales and bands for your aircraft and equipment; they do not read or change aircraft warning or failsafe limits.</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <footer><button type="button" aria-label="Restore default instruments" @click="restoreDefaults">Restore defaults</button><button type="button" aria-label="Cancel instrument changes" @click="emit('cancel')">Cancel</button><button type="button" class="apply-button" aria-label="Apply instrument changes" :disabled="!!error" @click="emit('apply', validateInstrumentSlots(draft, defaults))">Apply</button></footer>
    </section>
  </div>
  </Teleport>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref } from 'vue';
import InstrumentGauge from './InstrumentGauge.vue';
import { cloneInstrumentSlots, instrumentKinds, instrumentSlotsError, itemForSlot, MAX_INSTRUMENT_SLOTS, validateInstrumentSlots, type InstrumentItem, type InstrumentKind, type InstrumentSlot } from './instrument-settings';
const props = withDefaults(defineProps<{ items: InstrumentItem[]; config: InstrumentSlot[]; defaults: InstrumentSlot[]; title?: string }>(), { title: 'Configure instruments' });
const emit = defineEmits<{ apply: [config: InstrumentSlot[]]; cancel: [] }>();
const draft = ref(cloneInstrumentSlots(props.config)), selected = ref(0), query = ref(''), dialog = ref<HTMLElement | null>(null);
const priorFocus = typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null;
const overlayTarget = ref<Element | string>(document.fullscreenElement || 'body');
const fullscreenChanged = () => { overlayTarget.value = document.fullscreenElement || 'body'; };
const slot = computed(() => draft.value[selected.value]);
const activeItem = computed(() => itemForSlot(props.items, slot.value));
const sourceItems = computed(() => { const q = query.value.trim().toLowerCase(); return props.items.filter(item => `${item.label} ${item.id} ${item.category} ${item.source || ''}`.toLowerCase().includes(q)); });
const categories = computed(() => [...new Set(sourceItems.value.map(item => item.category))]);
const nextItem = computed(() => props.items.find(item => !draft.value.some(slot => slot.id === item.id)));
const error = computed(() => instrumentSlotsError(draft.value));
const kindLabels: Record<InstrumentKind, string> = { number: 'Numeric field', arc: 'Arc gauge', horizontal: 'Horizontal scale', vertical: 'Vertical scale', timer: 'Elapsed time', bearing: 'Bearing pointer', status: 'Status indicator' };
function setSource(id: string) { draft.value[selected.value] = { id, ...(slot.value.kind ? { kind: slot.value.kind } : {}) }; }
function setBound(bound: 'min' | 'max', value: string) { if (value === '') delete slot.value[bound]; else slot.value[bound] = Number(value); }
function clearScale() { delete slot.value.min; delete slot.value.max; delete slot.value.bands; }
function addBand() {
  slot.value.min ??= activeItem.value.min ?? 0;
  slot.value.max ??= activeItem.value.max ?? 100;
  const from = slot.value.bands?.at(-1)?.to ?? slot.value.min;
  (slot.value.bands ??= []).push({ from, to: slot.value.max, color: 'caution' });
}
function removeBand(index: number) { slot.value.bands?.splice(index, 1); void restoreEditorFocus('[aria-label="Add display band"]'); }
function move(direction: number) { const to = selected.value + direction; if (to < 0 || to >= draft.value.length) return; [draft.value[selected.value], draft.value[to]] = [draft.value[to], draft.value[selected.value]]; selected.value = to; }
function addSlot() { if (nextItem.value && draft.value.length < MAX_INSTRUMENT_SLOTS) { draft.value.push({ id: nextItem.value.id }); selected.value = draft.value.length - 1; } }
function removeSlot() {
  draft.value.splice(selected.value, 1);
  selected.value = Math.max(0, Math.min(selected.value, draft.value.length - 1));
  void restoreEditorFocus(draft.value.length ? '[aria-label="Instrument source"]' : '[aria-label="Add instrument"]');
}
function restoreDefaults() { draft.value = cloneInstrumentSlots(props.defaults); selected.value = 0; query.value = ''; }
async function restoreEditorFocus(preferred?: string) {
  await nextTick();
  const editor = dialog.value;
  if (!editor?.isConnected) return;
  const focused = document.activeElement;
  if (!preferred && editor.contains(focused) && !focused?.matches(':disabled')) return;
  const target = (preferred && editor.querySelector<HTMLElement>(`${preferred}:not(:disabled)`))
    || editor.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)');
  target?.focus();
}
function trapFocus(event: KeyboardEvent) {
  const focusable = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)') || [])];
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
onMounted(() => { document.addEventListener('fullscreenchange', fullscreenChanged); nextTick(() => dialog.value?.querySelector<HTMLElement>('select, input, button')?.focus()); });
// Removing a control or disabling an ordering/add button must not leave keyboard
// focus on the document body, outside the scrim's Escape/Tab handlers.
onUpdated(() => { void restoreEditorFocus(); });
onBeforeUnmount(() => { document.removeEventListener('fullscreenchange', fullscreenChanged); if(priorFocus?.isConnected)priorFocus.focus(); });
</script>
<style scoped>
.instrument-editor-scrim{position:fixed;inset:0;z-index:260;display:flex;justify-content:flex-end;background:#0008;padding:12px;font-family:Arial,sans-serif;color:#edf6fb;text-align:left;overflow:auto}.instrument-editor{width:420px;max-width:100%;max-height:100%;overflow:auto;align-self:flex-start;background:#0b202c;border:1px solid #7896a6;border-radius:4px;padding:16px;box-sizing:border-box;box-shadow:0 8px 36px #000b}.instrument-editor header{display:flex;align-items:center;gap:10px;justify-content:space-between}.instrument-editor h2{margin:0;font-size:19px}.instrument-editor button,.instrument-editor input,.instrument-editor select{min-height:44px;min-width:44px;border:1px solid #718d9d;border-radius:3px;padding:8px;color:#f3f8fc;background:#153342;font:inherit;font-size:14px;box-sizing:border-box}.instrument-editor button{cursor:pointer}.instrument-editor button:disabled{opacity:.4;cursor:default}.instrument-editor :is(button,input,select):focus-visible{outline:2px solid #9fe3ff;outline-offset:2px}.instrument-editor label{display:grid;gap:6px;margin:12px 0;font-size:13px;min-width:0}.instrument-editor select,.instrument-editor input{width:100%;background:#041721;font-size:16px}.slot-tabs{display:flex;gap:4px;margin:12px 0;flex-wrap:wrap}.slot-tabs [aria-pressed=true]{background:#176486;border-color:#84dbff}.editor-preview{height:165px;background:#030708;padding:5px}.source-detail,.display-note{font-size:12px;line-height:1.5;color:#bed4e1;overflow-wrap:anywhere}.display-note{border-left:2px solid #6b8b9e;padding-left:10px}.instrument-editor fieldset{border:1px solid #536c7b;margin:16px 0;padding:10px}.instrument-editor legend{font-size:13px}.editor-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}.editor-pair label{margin:0 0 8px}.band-editor{display:grid;grid-template-columns:1fr 1fr;gap:5px;border-top:1px solid #405866;margin:8px 0}.band-editor label{margin:8px 0 0}.band-editor button{align-self:end}.editor-order{display:flex;gap:6px;flex-wrap:wrap}.editor-order button{flex:1}.instrument-editor footer{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;padding-top:10px;border-top:1px solid #536c7b}.instrument-editor footer button:first-child{margin-right:auto}.instrument-editor .apply-button{border-color:#7ad7f8;background:#23607c}.instrument-editor [role=alert]{color:#ffd18d;font-size:13px}
@media(max-width:480px){.instrument-editor-scrim{padding:5px}.instrument-editor{padding:12px;width:100%}}
</style>
