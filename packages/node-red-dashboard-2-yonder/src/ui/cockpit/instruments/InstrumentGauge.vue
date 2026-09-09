<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<template>
  <div class="instrument-gauge" :class="[`instrument-gauge-${kind}`, { 'instrument-unavailable': !valid }]" :data-instrument-id="item.id" :title="description">
    <span v-if="!graphical" class="instrument-label">{{ item.shortLabel || item.label }}</span>
    <svg v-if="graphical" class="instrument-face" :viewBox="`0 0 190 ${faceHeight}`" role="img" :aria-label="description">
      <title>{{ description }}</title>
      <text x="95" y="17" class="instrument-label">{{ item.shortLabel || item.label }}</text>
      <g transform="translate(0 20)">
      <template v-if="kind === 'arc'">
        <path :d="arc(0, 1)" class="scale-back" />
        <path v-for="(band, i) in bands" :key="i" :d="arc(fraction(band.from), fraction(band.to))" :stroke="instrumentColors[band.color]" class="scale-band" :data-band="band.color" />
        <g v-for="tick in ticks" :key="tick">
          <line :x1="point(fraction(tick), 54).x" :y1="point(fraction(tick), 54).y" :x2="point(fraction(tick), 64).x" :y2="point(fraction(tick), 64).y" class="scale-tick" />
          <text :x="point(fraction(tick), 76).x" :y="fraction(tick) === .5 ? 32 : point(fraction(tick), 76).y + 4" class="scale-label">{{ tickText(tick) }}</text>
        </g>
        <g v-if="numeric" transform="translate(95 71)"><path data-instrument-pointer d="M-6 -49 L0 -70 L6 -49Z" class="instrument-pointer" :transform="`rotate(${-112 + 224 * fraction(Number(item.value))})`" /></g>
        <text x="95" y="74" class="instrument-number" :fill="tone">{{ display }}</text>
        <text x="95" y="93" class="instrument-unit">{{ displayUnit }}</text>
      </template>
      <template v-else-if="kind === 'vertical'">
        <rect x="89" y="12" width="12" height="65" class="scale-back-fill" />
        <rect v-for="(band, i) in bands" :key="i" x="89" :y="77 - 65 * fraction(band.to)" width="12" :height="65 * (fraction(band.to) - fraction(band.from))" :fill="instrumentColors[band.color]" :data-band="band.color" />
        <g v-for="tick in ticks" :key="tick"><line x1="83" x2="106" :y1="77 - 65 * fraction(tick)" :y2="77 - 65 * fraction(tick)" class="scale-tick" /><text x="72" :y="81 - 65 * fraction(tick)" text-anchor="end" class="scale-label">{{ tickText(tick) }}</text></g>
        <path v-if="numeric" data-instrument-pointer :d="`M112 ${77 - 65 * fraction(Number(item.value))}l16 -6v12Z`" class="instrument-pointer" />
        <text x="95" y="105" class="instrument-number" :fill="tone">{{ display }}<tspan class="instrument-unit"> {{ displayUnit }}</tspan></text>
      </template>
      <template v-else-if="kind === 'horizontal'">
        <rect x="17" y="24" width="156" height="9" class="scale-back-fill" />
        <rect v-for="(band, i) in bands" :key="i" :x="17 + 156 * fraction(band.from)" y="24" :width="156 * (fraction(band.to) - fraction(band.from))" height="9" :fill="instrumentColors[band.color]" :data-band="band.color" />
        <g v-for="tick in ticks" :key="tick"><line :x1="17 + 156 * fraction(tick)" :x2="17 + 156 * fraction(tick)" y1="22" y2="37" class="scale-tick" /><text :x="17 + 156 * fraction(tick)" y="53" class="scale-label">{{ tickText(tick) }}</text></g>
        <path v-if="numeric" data-instrument-pointer :d="`M${17 + 156 * fraction(Number(item.value))} 24l-6 -17h12Z`" class="instrument-pointer" />
        <text x="95" y="86" class="instrument-number" :fill="tone">{{ display }}<tspan class="instrument-unit"> {{ displayUnit }}</tspan></text>
      </template>
      <template v-else-if="kind === 'bearing'">
        <circle cx="95" cy="48" r="35" fill="none" class="compass-circle" />
        <text x="95" y="10" class="scale-label">{{ bearingLabels[0] }}</text><text x="139" y="52" class="scale-label">{{ bearingLabels[1] }}</text><text x="95" y="93" class="scale-label">{{ bearingLabels[2] }}</text><text x="51" y="52" class="scale-label">{{ bearingLabels[3] }}</text>
        <path v-if="numeric" data-instrument-pointer d="M95 18 L101 59 L95 54 L89 59Z" class="instrument-pointer" :transform="`rotate(${Number(item.value)} 95 48)`" />
        <text x="95" y="120" class="instrument-number" :fill="tone">{{ display }}<tspan class="instrument-unit"> {{ displayUnit }}</tspan></text>
      </template>
      <path v-if="!valid" d="M44 8L146 100M146 8L44 100" class="missing-cross" />
      </g>
      <text v-if="faceDetail" x="95" :y="faceHeight - 5" class="instrument-detail">{{ faceDetail }}</text>
    </svg>
    <div v-else class="instrument-plain" :class="{ 'instrument-status': kind === 'status' }">
      <span v-if="kind === 'status'" class="status-mark" :style="{ background: valid && item.value !== false ? tone : 'transparent' }" aria-hidden="true" />
      <strong :style="{ color: tone }">{{ display }}</strong><span class="plain-unit">{{ displayUnit }}</span>
    </div>
    <span v-if="!graphical&&!valid" class="instrument-detail instrument-reason">{{ item.reason || 'Data unavailable' }}</span>
    <span v-else-if="!graphical&&(item.secondary || item.quality === 'partial')" class="instrument-detail">{{ item.secondary || 'Partial history' }}</span>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { formatInstrumentValue, instrumentAvailable, instrumentDisplayUnit, instrumentColors, type InstrumentItem, type InstrumentSlot } from './instrument-settings';
const props = defineProps<{ item: InstrumentItem; settings?: InstrumentSlot }>();
const kind = computed(() => props.settings?.kind || props.item.kind || 'number');
const valid = computed(() => instrumentAvailable(props.item));
const numeric = computed(() => valid.value && typeof props.item.value === 'number' && (kind.value === 'bearing' || hasRange.value));
const display = computed(() => formatInstrumentValue(props.item, kind.value));
const displayUnit = computed(() => instrumentDisplayUnit(props.item, kind.value));
const bearingLabels = computed(() => props.item.unit === '°T' ? ['N', 'E', 'S', 'W'] : props.item.unit === '° REL' ? ['FWD', 'R', 'AFT', 'L'] : ['0', '90', '180', '270']);
const min = computed(() => props.settings?.min ?? props.item.min ?? 0);
const max = computed(() => props.settings?.max ?? props.item.max ?? 100);
const hasRange = computed(() => Number.isFinite(props.settings?.min ?? props.item.min) && Number.isFinite(props.settings?.max ?? props.item.max) && max.value > min.value);
const bands = computed(() => (props.settings?.bands ?? props.item.bands ?? []).filter(b => hasRange.value && Number.isFinite(b.from) && Number.isFinite(b.to) && b.from < b.to && Object.hasOwn(instrumentColors, b.color)));
const tone = computed(() => {
  if (!numeric.value) return '#f5f8fa';
  const matching = bands.value.filter(b => Number(props.item.value) >= b.from && Number(props.item.value) <= b.to);
  const color = (['warning', 'caution', 'normal', 'neutral'] as const).find(color => matching.some(band => band.color === color));
  return color ? instrumentColors[color] : '#f5f8fa';
});
const graphical = computed(() => ['arc', 'horizontal', 'vertical', 'bearing'].includes(kind.value));
// Title, face and secondary value share one scale, as in the approved study.
// Fixed HTML rows previously squeezed the SVG to 41 px inside a 77 px instrument.
const faceHeight = computed(() => kind.value === 'horizontal' ? 137 : kind.value === 'bearing' ? 165 : 150);
const faceDetail = computed(() => !valid.value ? 'DATA UNAVAILABLE' : kind.value !== 'bearing' && !hasRange.value ? 'Set a display scale' : props.item.secondary || (props.item.quality === 'partial' ? 'Partial history' : ''));
const description = computed(() => `${props.item.label}: ${valid.value ? `${display.value} ${displayUnit.value}` : (props.item.reason || 'Data unavailable')}${props.item.source ? `. Source: ${props.item.source}` : ''}`);
const fraction = (value: number) => hasRange.value ? Math.max(0, Math.min(1, (value - min.value) / (max.value - min.value))) : 0;
const point = (fraction: number, radius: number) => ({ x: 95 + Math.sin((-112 + 224 * fraction) * Math.PI / 180) * radius, y: 71 - Math.cos((-112 + 224 * fraction) * Math.PI / 180) * radius });
function arc(start: number, end: number) { const a = point(start, 59), b = point(end, 59); return `M${a.x} ${a.y}A59 59 0 ${224 * (end - start) > 180 ? 1 : 0} 1 ${b.x} ${b.y}`; }
const ticks = computed(() => hasRange.value ? [min.value, (min.value + max.value) / 2, max.value] : []);
const tickText = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 1, notation: Math.abs(value) >= 10000 ? 'compact' : 'standard' });
</script>
<style scoped>
.instrument-gauge{display:flex;flex-direction:column;justify-content:center;min-height:0;height:100%;min-width:0;color:#f5f8fa;font-family:Arial,sans-serif;font-variant-numeric:tabular-nums;text-align:center}
.instrument-label{display:block;font-size:clamp(11px,1.05vw,15px);font-weight:600;line-height:1.2;padding-top:3px;overflow-wrap:anywhere}
.instrument-face{display:block;flex:1;min-height:0;width:100%;height:100%;overflow:visible;text-anchor:middle}.instrument-face>.instrument-label{font-size:18px;fill:#fff}.instrument-face>.instrument-detail{font-size:14px;fill:#c3d4dd}
.scale-back{fill:none;stroke:#465158;stroke-width:9}.scale-band{fill:none;stroke-width:9}.scale-back-fill{fill:#465158}.scale-tick{stroke:#fff;stroke-width:1.4}.scale-label{font-size:11px;fill:#f8fafb;paint-order:stroke;stroke:#040b10;stroke-width:2px;stroke-linejoin:round}.instrument-number{font-size:28px;font-weight:600;paint-order:stroke;stroke:#030809;stroke-width:1.6px}.instrument-unit{font-size:14px;fill:#fff;font-weight:400}.instrument-pointer{fill:#fff;stroke:#020607;stroke-width:1.4}.missing-cross{stroke:#ef5a53;stroke-width:2.5;fill:none}.compass-circle{stroke:#73868f;stroke-width:2}
.instrument-detail{display:block;font-size:11px;line-height:1.2;color:#c3d4dd;padding-bottom:3px;overflow-wrap:anywhere}.instrument-reason{color:#f2c2be}.instrument-plain{display:flex;flex-wrap:wrap;align-content:center;align-items:center;justify-content:center;gap:5px;flex:1;min-height:44px;padding:5px}.instrument-plain strong{font-size:25px;line-height:1.15;overflow-wrap:anywhere}.plain-unit{font-size:12px}.status-mark{height:10px;width:10px;flex:none;border:1px solid #b1c6d1;border-radius:50%}.instrument-status strong{font-size:20px}
</style>
