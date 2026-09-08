<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <section class="instrumentation-panel" aria-label="Aircraft systems and readings">
    <header class="systems-header"><nav aria-label="Instrumentation pages"><button type="button" :aria-pressed="activeView === 'systems'" @click="activeView = 'systems'">Systems</button><button type="button" :aria-pressed="activeView === 'inspector'" @click="openInspector">Inspector</button></nav><span>{{ availableCount }} / {{ items.length }} reporting</span></header>
    <div v-if="activeView === 'inspector'" class="systems-search inspector-source-search">
      <input v-model="query" aria-label="Search telemetry sources" type="search" placeholder="Find a reading or source" />
      <select :value="currentId || ''" aria-label="Telemetry source" :disabled="!items.length" @change="selectItem(($event.target as HTMLSelectElement).value)">
        <option value="" disabled>Select a reading</option>
        <option v-if="selectedItem && !matchingItems.some(item => item.id === selectedItem.id)" :value="selectedItem.id">{{ selectedItem.label }} · {{ selectedItem.source || selectedItem.id }}</option>
        <option v-for="item in matchingItems" :key="item.id" :value="item.id">{{ item.label }} · {{ item.source || item.id }}</option>
      </select>
      <p v-if="!matchingItems.length" class="inspector-search-empty">{{ items.length ? 'No readings match this search.' : 'Waiting for the instrumentation catalog.' }}</p>
    </div>
    <div class="systems-content" :class="{ 'inspector-only': activeView === 'inspector' }">
      <section v-if="activeView === 'systems'" class="systems-catalog" aria-label="Received telemetry catalog">
        <div class="systems-search"><input v-model="query" aria-label="Search readings" type="search" placeholder="Search readings or sources" /><select v-model="category" aria-label="Reading category"><option value="">All systems</option><option v-for="name in categories" :key="name" :value="name">{{ name }}</option></select></div>
        <section v-if="!query.trim() && bankConfig.length" class="systems-overview" aria-label="Pinned instruments overview">
          <button type="button" class="overview-toggle" aria-label="Pinned instruments" :aria-expanded="overviewOpen" @click="overviewOpen = !overviewOpen"><span aria-hidden="true">{{ overviewOpen ? '▾' : '▸' }}</span> Pinned instruments <small>{{ bankConfig.length }}</small></button>
          <InstrumentBank v-show="overviewOpen" :items="items" :config="bankConfig" placement="mfd" @select="selectItem" @update:config="emit('update:bankConfig', $event)" />
        </section>
        <section v-for="group in groups" :key="group.name" class="systems-group"><h3>{{ group.name }}</h3>
          <button v-for="item in group.items" :key="item.id" type="button" class="system-reading" :data-reading-id="item.id" :aria-pressed="currentId === item.id" :aria-label="`Inspect ${item.label}, ${item.source || item.id}`" @click="selectItem(item.id)">
            <span class="report-mark" :class="{ reporting: instrumentAvailable(item), partial: item.quality === 'partial' }" aria-hidden="true" /><span class="reading-name">{{ item.label }}<small>{{ item.source || item.id }}</small></span><span class="reading-value">{{ formatInstrumentValue(item) }} <small>{{ instrumentDisplayUnit(item) }}</small></span><span v-if="!instrumentAvailable(item)" class="reading-reason">{{ item.reason || 'Data unavailable' }}</span>
          </button>
        </section>
        <p v-if="!groups.length" class="catalog-empty">{{ items.length ? 'No readings match this search.' : 'Waiting for the instrumentation catalog.' }}</p>
      </section>
      <section v-if="selectedItem" class="reading-inspector" aria-label="Selected reading inspector">
        <h3>{{ selectedItem.label }}</h3>
        <div class="inspector-face"><InstrumentGauge :item="selectedItem" :settings="bankConfig.find(slot => slot.id === selectedItem.id)" /></div>
        <p v-if="!instrumentAvailable(selectedItem)" class="inspector-unavailable">{{ selectedItem.reason || 'Data unavailable' }}</p>
        <p v-else-if="selectedItem.reason" class="inspector-note">{{ selectedItem.reason }}</p>
        <dl><dt>Source</dt><dd>{{ selectedItem.source || 'Not yet reported' }}</dd><dt>Field</dt><dd>{{ selectedItem.id }}</dd><dt>Age</dt><dd>{{ ageLabel }}</dd><dt>Quality</dt><dd>{{ selectedItem.quality || (instrumentAvailable(selectedItem) ? 'reported' : 'unavailable') }}</dd><dt>{{ selectedItem.quality === 'calculated' ? 'Calculated value' : selectedItem.quality === 'partial' ? 'Observed value' : 'Reported value' }}</dt><dd>{{ instrumentAvailable(selectedItem) ? selectedItem.value : '—' }} {{ selectedItem.unit }}</dd></dl>
        <div class="inspector-pin-actions"><button type="button" :aria-label="bankPinned ? 'Remove from instruments' : 'Pin to instruments'" :disabled="!bankPinned && bankConfig.length >= MAX_INSTRUMENT_SLOTS" @click="pin('bank')">{{ bankPinned ? 'Remove from instruments' : 'Pin to instruments' }}</button><button type="button" :aria-label="topPinned ? 'Remove from navigation fields' : 'Pin to navigation fields'" :disabled="!topPinned && topConfig.length >= MAX_INSTRUMENT_SLOTS" @click="pin('top')">{{ topPinned ? 'Remove from fields' : 'Pin to navigation fields' }}</button></div>
        <section class="instrument-trend" aria-label="Recent reading history"><header><h4>Recent history</h4><span>{{ selectedItem.unit }}</span></header>
          <svg v-if="plot.points.length" viewBox="0 0 320 116" role="img" :aria-label="`${selectedItem.label} history; gaps indicate missing samples`">
            <line x1="34" y1="14" x2="310" y2="14" class="trend-grid" /><line x1="34" y1="88" x2="310" y2="88" class="trend-grid" />
            <text x="30" y="17" text-anchor="end">{{ plot.maxLabel }}</text><text x="30" y="92" text-anchor="end">{{ plot.minLabel }}</text>
            <path v-for="(segment, index) in plot.paths" :key="index" :d="segment" data-trend-segment class="trend-line" /><circle v-for="(point, index) in plot.isolated" :key="index" :cx="point.x" :cy="point.y" r="2" class="trend-dot" />
            <text x="34" y="109">−{{ plot.spanSeconds }} s</text><text x="310" y="109" text-anchor="end">Latest sample</text>
          </svg>
          <p v-else>No numeric history received for this source.</p>
          <p class="trend-note">Up to 120 samples. Missing readings and gaps remain blank.</p>
        </section>
      </section>
      <p v-else-if="activeView === 'inspector'" class="catalog-empty">Choose a reading above to inspect its source and history.</p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import InstrumentGauge from './InstrumentGauge.vue';
import InstrumentBank from './InstrumentBank.vue';
import { cloneInstrumentSlots, defaultBankConfig, defaultTopConfig, formatInstrumentValue, instrumentAvailable, instrumentDisplayUnit, MAX_INSTRUMENT_SLOTS, trendSegments, type InstrumentItem, type InstrumentSample, type InstrumentSlot } from './instrument-settings';
const props = withDefaults(defineProps<{ items: InstrumentItem[]; history?: Record<string, InstrumentSample[]>; selectedId?: string | null; bankConfig?: InstrumentSlot[]; topConfig?: InstrumentSlot[]; view?: 'systems' | 'inspector' }>(), { history: () => ({}), selectedId: null, bankConfig: defaultBankConfig, topConfig: defaultTopConfig, view: 'systems' });
const emit = defineEmits<{ select: [id: string]; 'update:bankConfig': [config: InstrumentSlot[]]; 'update:topConfig': [config: InstrumentSlot[]] }>();
const query = ref(''), category = ref(''), currentId = ref(props.selectedId), activeView = ref(props.view);
const overviewOpen = ref(true);
watch(() => props.selectedId, id => { currentId.value = id; if (id) activeView.value = 'inspector'; });
watch(() => props.view, view => { activeView.value = view; });
const categories = computed(() => [...new Set(props.items.map(item => item.category))]);
const availableCount = computed(() => props.items.filter(instrumentAvailable).length);
const selectedItem = computed(() => props.items.find(item => item.id === currentId.value));
const matchingItems = computed(() => {
  const q = query.value.toLowerCase().trim();
  return props.items.filter(item => `${item.label} ${item.shortLabel || ''} ${item.id} ${item.source || ''} ${item.reason || ''} ${item.category}`.toLowerCase().includes(q));
});
const groups = computed(() => categories.value.filter(name => !category.value || name === category.value).map(name => ({ name, items: matchingItems.value.filter(item => item.category === name) })).filter(group => group.items.length));
function selectItem(id: string) { currentId.value = id; activeView.value = 'inspector'; emit('select', id); }
function openInspector() { activeView.value = 'inspector'; }
const ageLabel = computed(() => typeof selectedItem.value?.ageMs === 'number' && Number.isFinite(selectedItem.value.ageMs) ? `${Math.max(0, selectedItem.value.ageMs / 1000).toFixed(1)} s` : 'Not available');
const bankPinned = computed(() => props.bankConfig.some(slot => slot.id === currentId.value));
const topPinned = computed(() => props.topConfig.some(slot => slot.id === currentId.value));
function pin(target: 'bank' | 'top') {
  if (!selectedItem.value) return;
  const config = cloneInstrumentSlots(target === 'bank' ? props.bankConfig : props.topConfig), index = config.findIndex(slot => slot.id === currentId.value);
  if (index >= 0) config.splice(index, 1); else if (config.length < MAX_INSTRUMENT_SLOTS) config.push({ id: selectedItem.value.id }); else return;
  if (target === 'bank') emit('update:bankConfig', config); else emit('update:topConfig', config);
}
const plot = computed(() => {
  const samples = (props.history[currentId.value || ''] || []).slice(-120);
  const segments = trendSegments(samples), points = segments.flat();
  // Null samples occupy real time at either edge as well as between valid readings.
  const values = points.map(point => point.v), times = samples.filter(sample => sample && Number.isFinite(sample.t)).map(sample => sample.t);
  const min = points.length ? Math.min(...values) : 0, max = points.length ? Math.max(...values) : 1;
  const first = times.length ? Math.min(...times) : 0, last = times.length ? Math.max(...times) : 1;
  const x = (t: number) => 34 + 276 * (t - first) / Math.max(1000, last - first), y = (v: number) => max === min ? 51 : 88 - 74 * (v - min) / (max - min);
  return { points, paths: segments.map(segment => segment.map((point, i) => `${i ? 'L' : 'M'}${x(point.t).toFixed(2)} ${y(point.v).toFixed(2)}`).join(' ')), isolated: segments.filter(segment => segment.length === 1).map(segment => ({ x: x(segment[0].t), y: y(segment[0].v) })), minLabel: min.toLocaleString('en-US', { maximumFractionDigits: 1 }), maxLabel: max.toLocaleString('en-US', { maximumFractionDigits: 1 }), spanSeconds: Math.round((last - first) / 1000) };
});
</script>
<style scoped>
.instrumentation-panel{display:flex;flex-direction:column;height:100%;min-height:0;min-width:0;background:#06121a;color:#f0f7fc;font:14px Arial,sans-serif;container-type:inline-size;container-name:instrumentation}.systems-header{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #587484;background:#112b3b;padding:5px 8px}.systems-header nav{display:flex;gap:5px}.systems-header>span{font-size:11px;color:#aac8d8}.instrumentation-panel button,.instrumentation-panel input,.instrumentation-panel select{font:inherit;color:inherit;min-height:44px;border:1px solid #557585;border-radius:3px;background:#123446;padding:7px;box-sizing:border-box}.instrumentation-panel button{cursor:pointer}.instrumentation-panel button:disabled{opacity:.4;cursor:default}.instrumentation-panel :is(button,input,select):focus-visible{outline:2px solid #9fe3ff;outline-offset:-2px}.systems-header [aria-pressed=true]{background:#185b7b;border-color:#81d6f5}.systems-content{min-height:0;flex:1;overflow:auto;display:flex;flex-direction:column}.systems-search{display:grid;grid-template-columns:1fr;padding:8px;gap:6px;background:#0a1c27;position:sticky;top:0;z-index:1}.systems-search :is(input,select){width:100%;min-width:0;background:#04131c;font-size:14px}.systems-group h3{font-size:12px;padding:9px 10px;margin:0;background:#152e3c;color:#d1e7f3;font-weight:600;border-block:1px solid #2e4c5e}.systems-group .system-reading{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:3px 7px;align-items:center;min-height:52px;width:100%;border:0;border-bottom:1px solid #29424f;border-radius:0;padding:8px 10px;background:transparent;text-align:left}.systems-group .system-reading:hover,.systems-group .system-reading[aria-pressed=true]{background:#173d51}.reading-name{min-width:0;font-size:13px}.reading-name small{display:block;color:#91afc0;font-size:10px;overflow-wrap:anywhere;margin-top:3px}.reading-value{font-variant-numeric:tabular-nums;max-width:150px;overflow-wrap:anywhere;font-size:16px;text-align:right}.reading-value small{font-size:10px;color:#aac6d6}.report-mark{width:6px;height:6px;border:1px solid #8a7f7c;border-radius:50%}.report-mark.reporting{background:#8fcedd;border-color:#8fcedd}.report-mark.partial{background:#ebc783;border-color:#ebc783}.reading-reason{grid-column:2/-1;color:#d8b4ac;font-size:11px;line-height:1.35}.reading-inspector{padding:14px;border-top:1px solid #648191;background:#0a1d29;min-width:0}.reading-inspector h3{font-size:17px;line-height:1.3;margin:0 0 10px}.inspector-face{height:160px;background:#030708;padding:5px;margin-bottom:10px}.reading-inspector dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px 10px;font-size:12px;line-height:1.45;margin:14px 0}.reading-inspector dt{color:#9ebccd}.reading-inspector dd{margin:0;overflow-wrap:anywhere}.inspector-unavailable{font-size:13px;color:#efc5be;line-height:1.4}.inspector-note{font-size:12px;color:#c1d4de;line-height:1.4}.inspector-pin-actions{display:flex;flex-wrap:wrap;gap:6px}.inspector-pin-actions button{font-size:12px;flex:1}.instrument-trend{border-top:1px solid #3d5d6e;margin-top:18px;padding-top:10px}.instrument-trend header{display:flex;justify-content:space-between;align-items:center}.instrument-trend h4{font-size:13px;margin:0}.instrument-trend header span{font-size:12px;color:#c2dae8}.instrument-trend svg{width:100%;display:block;margin-top:8px;overflow:visible}.instrument-trend svg text{fill:#acc7d6;font-size:10px}.trend-grid{stroke:#365260;stroke-width:1}.trend-line{fill:none;stroke:#77d4f4;stroke-width:2;vector-effect:non-scaling-stroke}.trend-dot{fill:#77d4f4}.instrument-trend p{font-size:12px;line-height:1.4;color:#abc6d5}.instrument-trend .trend-note{font-size:10px}.catalog-empty{padding:14px;font-size:13px;color:#bdd2de}
.inspector-source-search{flex:none;border-bottom:1px solid #3d5d6e}.inspector-search-empty{grid-column:1/-1;font-size:12px;line-height:1.4;color:#bdd2de;margin:2px 0}
.systems-overview{background:#030708;border-bottom:1px solid #587484}.systems-overview .overview-toggle{display:flex;align-items:center;gap:7px;width:100%;min-height:44px;border:0;border-block:1px solid #385260;border-radius:0;background:#10232e;padding:8px 10px;text-align:left;font-size:13px;font-weight:600}.overview-toggle small{margin-left:auto;color:#aac8d8;font-size:11px;font-weight:400}
@container instrumentation (min-width:650px){.systems-content:not(.inspector-only){display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,.8fr)}.systems-catalog{overflow:auto;min-height:0}.reading-inspector{overflow:auto;border-top:0;border-left:1px solid #648191}.systems-content:not(:has(.reading-inspector)){grid-template-columns:1fr}.systems-search{grid-template-columns:minmax(0,1fr) 155px}.inspector-source-search{grid-template-columns:minmax(0,1fr) minmax(0,1.3fr)}}
</style>
