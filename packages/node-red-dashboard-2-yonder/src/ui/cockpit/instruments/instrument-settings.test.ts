// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
const path = './instrument-settings';
const settings = await import(/* @vite-ignore */ path).catch(() => null);
const api = () => { expect(settings).not.toBeNull(); return settings!; };

describe('local instrument settings', () => {
  const legacy = () => [
    { id: 'battery.0.remainingPercent', kind: 'arc', min: 0, max: 100 },
    { id: 'battery.0.currentA', kind: 'arc', min: 0, max: 60 },
    { id: 'battery.0.consumedMah', kind: 'horizontal', min: 0, max: 10000 },
    { id: 'modem.rsrpDbm', kind: 'horizontal', min: -140, max: -40 },
    { id: 'host.cpuPercent', kind: 'horizontal', min: 0, max: 100 },
    { id: 'link.telemetryAgeSeconds', kind: 'horizontal', min: 0, max: 5 },
  ];
  it('loads the approved mixed graphical bank with editable colored starter scales', () => {
    const bank = api().defaultBankConfig();
    expect(bank.map(slot => slot.kind)).toEqual(['arc', 'vertical', 'horizontal', 'horizontal', 'arc', 'horizontal']);
    expect(bank.every(slot => slot.bands?.some(b => b.color === 'normal') && slot.bands?.some(b => b.color === 'warning'))).toBe(true);
    expect(api().instrumentSlotsError(bank)).toBeNull();
    bank[0].bands[0].to = 1;
    expect(api().defaultBankConfig()[0].bands[0].to).toBe(22);
  });
  it('upgrades only the untouched gray starter bank, preserving saved custom scales, bands and order', () => {
    expect(api().restoreBankConfig(legacy())).toEqual(api().defaultBankConfig());
    for (const change of [
      slots => { slots[0].bands = []; },
      slots => { slots[0].max = 90; },
      slots => { slots.reverse(); },
      slots => { slots[0].kind = 'vertical'; },
      slots => { slots[0].bands = [{ from: 10, to: 80, color: 'normal' }]; },
    ]) {
      const custom = legacy(); change(custom);
      expect(api().restoreBankConfig(custom)).toEqual(custom);
    }
    expect(api().restoreBankConfig([])).toEqual([]);
    expect(api().restoreBankConfig(null)).toEqual(api().defaultBankConfig());
  });
  it('rejects a corrupted saved range as a whole and clones the fallback', () => {
    const fallback = [{ id: 'battery.0.currentA', kind: 'arc', min: 0, max: 40 }];
    const result = api().validateInstrumentSlots([{ ...fallback[0], max: -1 }], fallback);
    expect(result).toEqual(fallback);
    result[0].min = -20;
    expect(fallback[0].min).toBe(0);
  });
  it('retains valid source instances, order, explicit empty selection, and neutral bands', () => {
    const slots = [{ id: 'battery.2.voltageV', kind: 'vertical', min: 0, max: 60, bands: [{ from: 12, to: 48, color: 'neutral' }] }, { id: 'flight.airborneSeconds', kind: 'timer' }];
    expect(api().validateInstrumentSlots(slots, [])).toEqual(slots);
    expect(api().validateInstrumentSlots([], slots)).toEqual([]);
  });
  it.each([
    [{ id: 'a', kind: 'script' }], [{ id: 'a', min: 0 }], [{ id: 'a' }, { id: 'a' }],
    [{ id: 'a', min: NaN, max: 2 }], [{ id: 'a', min: 0, max: 10, bands: [{ from: 5, to: 15, color: 'warning' }] }],
    [{ id: 'a', min: 0, max: 10, bands: [{ from: 1, to: 3, color: '#00ff00' }] }],
    Array.from({ length: 17 }, (_, i) => ({ id: `a.${i}` })),
  ])('falls back for invalid or unbounded profile %#', (...input) => {
    const fallback = [{ id: 'nav.distance' }];
    // Vitest expands each array as the arguments of this case.
    expect(api().validateInstrumentSlots(input, fallback)).toEqual(fallback);
  });
  it('renders unavailable and invalid readings as missing while preserving real zero', () => {
    const base = { id: 'current', label: 'Current', category: 'Electrical', value: 0, unit: 'A', available: true, quality: 'reported' };
    expect(api().formatInstrumentValue(base)).toBe('0');
    expect(api().formatInstrumentValue({ ...base, available: false })).toBe('—');
    expect(api().formatInstrumentValue({ ...base, value: NaN })).toBe('—');
    expect(api().formatInstrumentValue({ ...base, quality: 'unavailable' })).toBe('—');
    expect(api().formatInstrumentValue({ ...base, value: 3661, unit: 's', kind: 'timer' })).toBe('1:01:01');
  });
  it('omits a seconds suffix on preformatted timers and labels ordinary clock formatting accurately', () => {
    const base = { id: 'nav.ete', label: 'ETE', category: 'Navigation', value: 125, unit: 's', available: true, quality: 'reported', kind: 'timer' };
    for (const displayValue of ['02:05', '07:00*']) {
      const item = { ...base, displayValue };
      expect(api().formatInstrumentValue(item)).toBe(displayValue);
      expect(api().instrumentDisplayUnit(item)).toBe('');
      expect(item.unit).toBe('s');
    }
    expect(api().formatInstrumentValue(base)).toBe('0:02:05');
    expect(api().instrumentDisplayUnit(base)).toBe('h:mm:ss');
    expect(api().instrumentDisplayUnit({ ...base, kind: 'number' })).toBe('s');
  });
  it('bounds timeline samples and breaks paths across nulls and telemetry gaps', () => {
    const result = api().trendSegments([{ t: 0, v: 1 }, { t: 1000, v: 2 }, { t: 2000, v: null }, { t: 3000, v: 4 }, { t: 8000, v: 6 }, { t: 9000, v: 7 }]);
    expect(result.map((s: any[]) => s.map(p => p.t))).toEqual([[0, 1000], [3000], [8000, 9000]]);
    const bounded = api().trendSegments(Array.from({ length: 1000 }, (_, i) => ({ t: i * 1000, v: i })));
    expect(bounded.flat()).toHaveLength(120);
    expect(bounded.flat()[0].t).toBe(880000);
  });
});
