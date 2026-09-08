// SPDX-License-Identifier: GPL-3.0-or-later
import { cameraControlDescriptors } from './controls.js';
import type { CameraState } from './state.js';

/** Source readbacks and measured choices, converted once for every console surface. */
export function accessoryControls(state: CameraState) {
  const e = state.exposure, s = state.status, f = state.focus;
  const values: Record<string, unknown> = { mode: s?.modeCode, 'exposure-mode': e?.exposureModeCode, iso: e?.isoCode,
    ev: e?.evCode, shutter: e?.actualShutter ? { reciprocal: e.actualShutter.reciprocal, integer: e.actualShutter.integer, decimal: e.actualShutter.decimal } : null,
    'focus-mode': f?.modeCode, 'focus-point': f?.point, 'photo-size': e?.photoSizeCode, 'record-format': e?.recordRateCode,
    'white-balance': e?.whiteBalanceCode === 0 ? 0 : e?.whiteBalanceCode === 6 ? e.temperatureRaw : null };
  const labels: Record<string, Record<number, string>> = { mode: { 0: 'Photo', 1: 'Video' }, 'exposure-mode': { 1: 'Program', 2: 'Shutter priority', 4: 'Manual' }, 'focus-mode': { 1: 'Single', 2: 'Continuous' } };
  const group: Record<string, string> = { mode: 'capture', 'photo-size': 'capture', 'record-format': 'capture', 'focus-mode': 'optics', 'focus-point': 'optics', zoom: 'optics', colour: 'colour', filter: 'colour', 'live-format': 'stream' };
  return cameraControlDescriptors().map(d => {
    const common = { key: d.key, label: d.label, group: group[d.key] ?? 'exposure' };
    if (d.kind === 'unavailable') return { ...common, state: 'not-offered', reason: d.reason, value: null, options: [] };
    let reason: string | null = !s ? 'Waiting for fresh camera state' : s.recordPhase !== 'idle' || s.storing ? 'Camera capture is busy' : null;
    if (!reason && ['iso', 'shutter'].includes(d.key) && e?.exposureModeCode !== 4) reason = 'Manual exposure has this control';
    if (!reason && d.key === 'ev' && ![1,2].includes(e?.exposureModeCode ?? -1)) reason = 'Program or shutter priority exposure has this control';
    if (!reason && d.key === 'photo-size' && s?.mode !== 'photo') reason = 'Photo mode has this control';
    if (!reason && d.key === 'record-format' && s?.mode !== 'video') reason = 'Video mode has this control';
    const options = d.kind === 'menu' ? d.values.map(value => ({ value: String(value), label: d.labels?.[value] ?? labels[d.key]?.[value] ?? String(d.toDisplay(value)),
      command: { kind: d.key, value: d.key === 'record-format' ? { format: 16, rate: value } : value } }))
      : d.values.map(value => ({ value: JSON.stringify(value), label: d.kind === 'shutter' ? `1/${value.integer} s` : `${value.x}, ${value.y}`, command: { kind: d.key, value } }));
    const value = values[d.key];
    return { ...common, unit: d.unit, state: reason ? 'gated' : 'present', reason,
      value: value == null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value), options,
      readback: d.key === 'iso' ? e?.actualIso ?? null : d.key === 'ev' ? e?.ev ?? null : null };
  });
}
