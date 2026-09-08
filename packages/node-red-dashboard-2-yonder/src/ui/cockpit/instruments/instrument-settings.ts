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
export const instrumentColors = { neutral: '#73868f', normal: '#4ad47c', caution: '#f4cb43', warning: '#ef5a53' };
export const MAX_INSTRUMENT_SLOTS = 16;

export function defaultBankConfig(): InstrumentSlot[] {
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
