// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { packInstruments } from './instrumentation-wire.js';
import { unpackInstruments } from '../../../node-red-dashboard-2-yonder/src/ui/cockpit/instrumentation-client.mjs';
import type { InstrumentationSnapshot } from '../mav/instrumentation-types.js';
import { AircraftInstrumentation } from '../mav/instrumentation.js';
import { HostInstruments, CockpitInstruments } from './host-instruments.js';
import { ardupilotmega as ap, common, minimal, type MavLinkData } from 'node-mavlink';

const sample: InstrumentationSnapshot = { at: 1000, generation: 'flight-one', connected: true, fields: {
  'battery.0.voltageV': { value: 22.1, unit: 'V', source: 'FC 1:1 BATTERY_STATUS', ageMs: 500, ttlMs: 3000, quality: 'reported' },
  'host.cpuPercent': { value: null, unit: '%', source: 'Companion /proc/stat', ageMs: null, ttlMs: 3000, quality: 'unavailable', reason: 'Waiting for two CPU samples' },
} };
it('round-trips sources, units, nulls and quality in a separate dictionary/row wire', () => {
  const wire = packInstruments(sample);
  expect(wire).toMatchObject({ v: 1, at: 1000, g: 'flight-one', c: true });
  expect(wire).not.toHaveProperty('fields');
  expect(unpackInstruments(JSON.parse(JSON.stringify(wire)))).toMatchObject(sample);
});
it('bounds field count and wire bytes while reporting omitted readings', () => {
  const fields: InstrumentationSnapshot['fields'] = {};
  for (let i = 0; i < 1000; i++) fields[`esc.${i}.temperatureC`] = { value: i, unit: '°C', source: 'FC 1:1 ESC_TELEMETRY_1_TO_4', ageMs: 0, ttlMs: 5000, quality: 'reported' };
  const wire = packInstruments({ ...sample, fields });
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(128 * 1024);
  expect(Object.keys(unpackInstruments(wire).fields)).toHaveLength(512);
  expect(unpackInstruments(wire).truncated).toBe(488);
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(40000);
});
it('bounds worst-case Unicode payloads by bytes and reports their omitted rows', () => {
  const fields: InstrumentationSnapshot['fields'] = {};
  for (let i = 0; i < 512; i++) fields[`camera.${i}.name`] = { value: '✈'.repeat(256), unit: '', source: `FC ${i} ${'✈'.repeat(100)}`, ageMs: 0, ttlMs: 5000, quality: 'partial', reason: '✈'.repeat(256) };
  const wire = packInstruments({ ...sample, fields });
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(128 * 1024);
  const decoded = unpackInstruments(wire);
  expect(decoded.truncated).toBeGreaterThan(0);
  expect(Object.keys(decoded.fields).length + decoded.truncated).toBe(512);
});
it('preserves all flight counters in a full aircraft collector plus eight companion cameras, independent of input order', async () => {
  const identity = { system: 42, component: 1, autopilot: 3, vehicleType: 1, generation: 'full-aircraft' };
  const collector = new AircraftInstrumentation(); collector.select(identity, false);
  const feed = (data: MavLinkData) => collector.receive({ system: 42, component: 1, id: (data.constructor as { MSG_ID: number }).MSG_ID, data }, 1000, identity);
  feed(Object.assign(new minimal.Heartbeat(), { baseMode: 128, customMode: 10 }));
  feed(Object.assign(new common.SystemTime(), { timeBootMs: 10000 }));
  feed(Object.assign(new common.ExtendedSysState(), { landedState: 2, vtolState: 4 }));
  for (let id = 0; id < 8; id++) {
    feed(Object.assign(new common.BatteryStatus(), { id, voltages: Array(10).fill(4000), voltagesExt: Array(4).fill(0), currentBattery: 100, batteryRemaining: 70 }));
    feed(Object.assign(new common.EfiStatus(), { ecuIndex: id, rpm: 1200 }));
  }
  for (const Message of [ap.EscTelemetry1To4, ap.EscTelemetry5To8, ap.EscTelemetry9To12, ap.EscTelemetry13To16, ap.EscTelemetry17To20, ap.EscTelemetry21To24, ap.EscTelemetry25To28, ap.EscTelemetry29To32]) {
    feed(Object.assign(new Message(), { count: [1, 1, 1, 1], temperature: [30, 30, 30, 30], voltage: [2400, 2400, 2400, 2400] }));
  }
  for (let id = 0; id < 8; id++) feed(Object.assign(new common.DistanceSensor(), { id, minDistance: 10, maxDistance: 1000, currentDistance: 200, signalQuality: 80 }));
  const host = new HostInstruments({ now: () => 1000, media: async () => Array.from({ length: 8 }, (_, id) => ({ id: `cam${id}`, run: null, recorder: null })) });
  await host.snapshot();
  await new Promise<void>(resolve => setImmediate(resolve));
  const vehicle = { instrumentation: () => collector.snapshot(1000, true, identity) };
  expect(Object.keys(vehicle.instrumentation().fields)).toHaveLength(450);
  expect(Object.keys(await host.snapshot())).toHaveLength(63);
  const merged = await new CockpitInstruments({ now: () => 1000, host, vehicle }).snapshot();
  expect(Object.keys(merged.fields)).toHaveLength(513);
  const wire = packInstruments(merged), decoded = unpackInstruments(wire);
  expect(decoded.fields['flight.bootSeconds']).toMatchObject({ value: 10 });
  expect(decoded.fields['flight.armedSeconds']).toBeDefined();
  expect(decoded.fields['flight.airborneSeconds']).toBeDefined();
  expect(decoded.fields['flight.autoSeconds']).toMatchObject({ value: 0, unit: 's' });
  expect(decoded.fields['fc.instrumentationTruncated']).toMatchObject({ value: true });
  expect(decoded.truncated).toBe(1);
  expect(Object.keys(decoded.fields)).toHaveLength(512);
  expect(packInstruments({ ...merged, fields: Object.fromEntries(Object.entries(merged.fields).reverse()) })).toEqual(wire);
});
it('reserves AUTO time when diagnostic rows exhaust the wire bound', () => {
  const fields: InstrumentationSnapshot['fields'] = {};
  for (let i = 0; i < 512; i++) fields[`battery.extra${i}.voltageV`] = sample.fields['battery.0.voltageV'];
  fields['flight.autoSeconds'] = { value: 24, unit: 's', source: 'Observed autopilot AUTO', ageMs: 100, ttlMs: 3000, quality: 'partial' };
  const decoded = unpackInstruments(packInstruments({ ...sample, fields }));
  expect(decoded.fields['flight.autoSeconds']).toMatchObject({ value: 24, ageMs: 100, quality: 'partial' });
  expect(Object.keys(decoded.fields)).toHaveLength(512);
  expect(decoded.truncated).toBe(1);
});
it.each([
  (w: any) => { w.v = 8; },
  (w: any) => { w.r[0][3] = 10000; },
  (w: any) => { w.r[0][1] = Infinity; },
  (w: any) => { w.r[0][4] = -1; },
  (w: any) => { w.r[0][5] = 0; },
  (w: any) => { w.r[0][6] = 99; },
  (w: any) => { w.k[0] = '__proto__'; },
  (w: any) => { w.r.push(w.r[0]); },
  (w: any) => { w.k = Array(513).fill('x'); },
  (w: any) => { w.s[0] = 'x'.repeat(1000); },
])('rejects malformed instrumentation frames rather than inventing readings', mutate => {
  const wire = structuredClone(packInstruments(sample)); mutate(wire);
  expect(() => unpackInstruments(wire)).toThrow(/instrument/i);
});
