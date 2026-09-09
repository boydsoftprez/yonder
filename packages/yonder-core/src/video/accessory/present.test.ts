// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { accessoryControls } from './present.js';
import { CameraStateStore } from './state.js';
import { decodeDuml, encodeDuml } from './duml.js';

function measuredState() {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/pocket2-state.json', import.meta.url), 'utf8')).cases.find((c: { name: string }) => c.name === 'baseline');
  const store = new CameraStateStore();
  for (const [id, payload] of Object.entries(fixture.payloads)) store.update(decodeDuml(encodeDuml({ sender: 1, senderIndex: 0, commandSet: 2, commandId: parseInt(id, 16), payload: Buffer.from(payload as string, 'hex') }))!, 100);
  return store.read(100, 500);
}

describe('native control readbacks', () => {
  it.each([320, null])('shows Auto ISO with observed ISO %s while retaining only measured write choices', (actualIso) => {
    const state = measuredState();
    const iso = accessoryControls({ ...state, exposure: { ...state.exposure!, isoCode: 0, actualIso, exposureModeCode: 1 } }).find(c => c.key === 'iso')!;
    expect(iso).toMatchObject({ value: '0', currentLabel: actualIso === null ? 'Auto · ISO unknown' : 'Auto · ISO 320', state: 'gated', readback: actualIso });
    expect(iso.options.map(o => o.value)).toEqual(['3','4','5','6','7','8','9']);
    expect(iso.options.some(o => o.command.value === 0)).toBe(false);
  });
  it('formats EV thirds for reading without changing their native command codes', () => {
    const ev = accessoryControls(measuredState()).find(c => c.key === 'ev')!;
    expect(ev.options.find(o => o.value === '11')).toMatchObject({ label: '-1.67', command: { kind: 'ev', value: 11 } });
    expect(ev.options.find(o => o.value === '17')).toMatchObject({ label: '0.33', command: { kind: 'ev', value: 17 } });
  });
});
