// SPDX-License-Identifier: GPL-3.0-or-later
/** Local presentation only: these limits are never aircraft parameters (R-UI-09). */
export type InstrumentKind = 'number' | 'timer' | 'bearing' | 'status' | 'arc' | 'horizontal' | 'vertical';
export type InstrumentBand = { from: number; to: number; color: 'neutral' | 'normal' | 'caution' | 'warning' };
export interface InstrumentSlot {
  id: string;
  kind?: InstrumentKind;
  min?: number;
  max?: number;
  bands?: InstrumentBand[];
}
export interface InstrumentItem {
  id: string;
  label: string;
  shortLabel?: string;
  category: string;
  value: number | string | boolean | null;
  unit: string;
  available: boolean;
  source?: string;
  ageMs?: number | null;
  reason?: string;
  quality?: 'reported' | 'calculated' | 'partial' | 'unavailable';
  kind?: InstrumentKind;
  min?: number;
  max?: number;
  bands?: InstrumentBand[];
  secondary?: string;
  displayValue?: string;
}
export type InstrumentSample = { t: number; v: number | null };
export const instrumentKinds: InstrumentKind[] = ['number', 'arc', 'horizontal', 'vertical', 'timer', 'bearing', 'status'];
export const instrumentColors = { neutral: '#73868f', normal: '#00cf52', caution: '#ffff00', warning: '#ff3333' };
export const MAX_INSTRUMENT_SLOTS = 16;

export function defaultBankConfig(): InstrumentSlot[] {
  // Approved design-study scales: editable presentation presets, not aircraft limits.
  // Current and charge assume the study's 30 A / 8,000 mAh display ranges.
  return [
    { id: 'battery.0.currentA', kind: 'arc', min: 0, max: 30, bands: [
      { from: 0, to: 22, color: 'normal' }, { from: 22, to: 27, color: 'caution' }, { from: 27, to: 30, color: 'warning' }] },
    { id: 'battery.0.remainingPercent', kind: 'vertical', min: 0, max: 100, bands: [
      { from: 0, to: 15, color: 'warning' }, { from: 15, to: 30, color: 'caution' }, { from: 30, to: 100, color: 'normal' }] },
    { id: 'battery.0.consumedMah', kind: 'horizontal', min: 0, max: 8000, bands: [
      { from: 0, to: 5600, color: 'normal' }, { from: 5600, to: 6800, color: 'caution' }, { from: 6800, to: 8000, color: 'warning' }] },
    { id: 'modem.rsrpDbm', kind: 'horizontal', min: -125, max: -75, bands: [
      { from: -125, to: -115, color: 'warning' }, { from: -115, to: -105, color: 'caution' }, { from: -105, to: -75, color: 'normal' }] },
    { id: 'host.cpuPercent', kind: 'arc', min: 0, max: 100, bands: [
      { from: 0, to: 75, color: 'normal' }, { from: 75, to: 90, color: 'caution' }, { from: 90, to: 100, color: 'warning' }] },
    { id: 'link.telemetryAgeSeconds', kind: 'horizontal', min: 0, max: 1, bands: [
      { from: 0, to: .3, color: 'normal' }, { from: .3, to: .7, color: 'caution' }, { from: .7, to: 1, color: 'warning' }] },
  ];
}
function legacyBankConfig(): InstrumentSlot[] {
  return [
    { id: 'battery.0.remainingPercent', kind: 'arc', min: 0, max: 100 },
    { id: 'battery.0.currentA', kind: 'arc', min: 0, max: 60 },
    { id: 'battery.0.consumedMah', kind: 'horizontal', min: 0, max: 10000 },
    { id: 'modem.rsrpDbm', kind: 'horizontal', min: -140, max: -40 },
    { id: 'host.cpuPercent', kind: 'horizontal', min: 0, max: 100 },
    { id: 'link.telemetryAgeSeconds', kind: 'horizontal', min: 0, max: 5 },
  ];
}
export function defaultTopConfig(): InstrumentSlot[] {
  return [
    { id: 'nav.activeWaypoint', kind: 'number' }, { id: 'nav.distance', kind: 'number' },
    { id: 'nav.ete', kind: 'timer' }, { id: 'nav.agl', kind: 'number' },
    { id: 'nav.groundspeed', kind: 'number' }, { id: 'flight.airborneSeconds', kind: 'timer' },
  ];
}
export function cloneInstrumentSlots(slots: InstrumentSlot[]): InstrumentSlot[] {
  return slots.map(slot => ({ ...slot, ...(slot.bands ? { bands: slot.bands.map(band => ({ ...band })) } : {}) }));
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Strict validation makes a corrupt saved profile fall back rather than partially changing it. */
export function instrumentSlotsError(input: unknown): string | null {
  if (!Array.isArray(input) || input.length > MAX_INSTRUMENT_SLOTS) return `Choose up to ${MAX_INSTRUMENT_SLOTS} instruments.`;
  const seen = new Set<string>();
  for (const slot of input) {
    if (!object(slot) || typeof slot.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(slot.id)) return 'Choose a valid instrument source.';
    if (seen.has(slot.id)) return 'Each instrument source can appear once in this strip.';
    seen.add(slot.id);
    if (slot.kind !== undefined && !instrumentKinds.includes(slot.kind as InstrumentKind)) return 'Choose a supported presentation.';
    const ranged = slot.min !== undefined || slot.max !== undefined;
    if (ranged && (!finite(slot.min) || !finite(slot.max) || slot.min >= slot.max)) return 'Display minimum must be lower than display maximum; enter both values.';
    if (slot.bands !== undefined) {
      if (!Array.isArray(slot.bands) || slot.bands.length > 8) return 'Use up to eight display bands.';
      for (const band of slot.bands) {
        if (!ranged || !object(band) || !finite(band.from) || !finite(band.to) || band.from >= band.to || band.from < (slot.min as number) || band.to > (slot.max as number) || !Object.hasOwn(instrumentColors, String(band.color))) return 'Each display band must fit inside the scale and have a valid color.';
      }
      const sorted = [...slot.bands].sort((a, b) => a.from - b.from);
      if (sorted.some((band, i) => i > 0 && band.from < sorted[i - 1].to)) return 'Display bands must not overlap.';
    }
  }
  return null;
}
export function validateInstrumentSlots(input: unknown, defaults: InstrumentSlot[] = defaultBankConfig()): InstrumentSlot[] {
  if (instrumentSlotsError(input)) return cloneInstrumentSlots(defaults);
  return (input as InstrumentSlot[]).map(slot => ({ id: slot.id,
    ...(slot.kind !== undefined ? { kind: slot.kind } : {}),
    ...(slot.min !== undefined ? { min: slot.min, max: slot.max } : {}),
    ...(slot.bands !== undefined ? { bands: slot.bands.map(({ from, to, color }) => ({ from, to, color })) } : {}),
  }));
}
/** Upgrade only the exact original starter profile; explicit empty bands are a choice. */
export function restoreBankConfig(input: unknown): InstrumentSlot[] {
  const legacy = legacyBankConfig();
  if (Array.isArray(input) && input.length === legacy.length && input.every((slot, index) =>
    object(slot) && Object.keys(slot).length === 4 && Object.entries(legacy[index]).every(([key, value]) => slot[key] === value))) {
    return defaultBankConfig();
  }
  return validateInstrumentSlots(input, defaultBankConfig());
}
export function instrumentAvailable(item: InstrumentItem): boolean {
  return item.available === true && item.quality !== 'unavailable' && item.value !== null && item.value !== undefined
    && (typeof item.value !== 'number' || Number.isFinite(item.value));
}
export function formatInstrumentValue(item: InstrumentItem, kind = item.kind): string {
  if (!instrumentAvailable(item)) return '—';
  if (item.displayValue) return item.displayValue;
  if (kind === 'timer' && typeof item.value === 'number' && item.unit === 's' && item.value >= 0) {
    const seconds = Math.floor(item.value);
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  if (typeof item.value === 'number') return item.value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(item.value) < 100 ? 1 : 0 });
  if (typeof item.value === 'boolean') return item.value ? 'Yes' : 'No';
  return String(item.value);
}
export function instrumentDisplayUnit(item: InstrumentItem, kind = item.kind): string {
  if (kind === 'timer' && item.displayValue) return '';
  return kind === 'timer' && item.unit === 's' ? 'h:mm:ss' : item.unit;
}
export function itemForSlot(items: InstrumentItem[], slot: InstrumentSlot): InstrumentItem {
  return items.find(item => item.id === slot.id) ?? { id: slot.id, label: slot.id, category: 'Unavailable', value: null, unit: '', available: false, quality: 'unavailable', reason: 'This source has not reported a reading.' };
}
/** One point per supplied sample, at most 120 samples; gaps never become connecting lines. */
export function trendSegments(samples: InstrumentSample[]): { t: number; v: number }[][] {
  const segments: { t: number; v: number }[][] = [];
  let active: { t: number; v: number }[] | null = null;
  for (const sample of samples.slice(-120)) {
    if (!sample || !finite(sample.t) || !finite(sample.v)) { active = null; continue; }
    const previous = active?.[active.length - 1];
    if (!active || (previous && (sample.t - previous.t > 2500 || sample.t <= previous.t))) { active = []; segments.push(active); }
    active.push({ t: sample.t, v: sample.v });
  }
  return segments;
}
