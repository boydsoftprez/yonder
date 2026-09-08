// SPDX-License-Identifier: GPL-3.0-or-later
import type { InstrumentReading, InstrumentationSnapshot } from '../mav/instrumentation-types.js';

export const MAX_INSTRUMENT_FIELDS = 512;
export const MAX_INSTRUMENT_BYTES = 128 * 1024;
const QUALITIES = ['reported', 'calculated', 'partial', 'unavailable'];
// A full aircraft + eight companion cameras can exceed 512 by one row. Preserve
// counters and the collector's own limit indicator before allocating diagnostics.
const ESSENTIAL_KEYS = new Set(['flight.bootSeconds', 'flight.armedSeconds', 'flight.airborneSeconds', 'flight.autoSeconds', 'fc.instrumentationTruncated']);
/** Key, value, unit index, source index, age, TTL, quality index, optional reason index. */
type Row = [number, InstrumentReading['value'], number, number, number | null, number, number, number?];
export interface InstrumentationWire {
  v: 1; at: number; g: string | null; c: boolean;
  k: string[]; u: string[]; s: string[]; d: string[]; r: Row[];
  /** Readings omitted by the bounded transport, never represented as a received zero. */
  n: number;
}
function keyValid(value: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(value) && !value.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part));
}
const textValid = (value: unknown, length: number): value is string => typeof value === 'string' && value.length <= length && !/[\u0000-\u001f\u007f]/.test(value);

/** Bounded, versioned diagnostic wire independent of the high-rate flight frame. */
export function packInstruments(snapshot: InstrumentationSnapshot): InstrumentationWire {
  if (!Number.isFinite(snapshot.at) || snapshot.at < 0 || typeof snapshot.connected !== 'boolean'
    || (snapshot.generation !== null && !textValid(snapshot.generation, 128))) throw Error('Invalid instrumentation snapshot');
  const wire: InstrumentationWire = { v: 1, at: snapshot.at, g: snapshot.generation, c: snapshot.connected, k: [], u: [], s: [], d: [], r: [], n: 0 };
  const entries = Object.entries(snapshot.fields).sort(([a], [b]) =>
    Number(ESSENTIAL_KEYS.has(b)) - Number(ESSENTIAL_KEYS.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
  let bytes = Buffer.byteLength(JSON.stringify(wire)) + 16;
  for (const [key, reading] of entries) {
    if (wire.r.length >= MAX_INSTRUMENT_FIELDS || !keyValid(key) || !reading
      || !textValid(reading.unit, 24) || !textValid(reading.source, 160) || !reading.source
      || (reading.reason !== undefined && !textValid(reading.reason, 256))
      || !(reading.ageMs === null || (Number.isFinite(reading.ageMs) && reading.ageMs >= 0))
      || !Number.isFinite(reading.ttlMs) || reading.ttlMs <= 0 || reading.ttlMs > 86400000
      || !QUALITIES.includes(reading.quality)
      || !(reading.value === null || typeof reading.value === 'boolean' || (typeof reading.value === 'number' && Number.isFinite(reading.value)) || textValid(reading.value, 256))) { wire.n++; continue; }
    const indexes = [wire.u.indexOf(reading.unit), wire.s.indexOf(reading.source), reading.reason === undefined ? -1 : wire.d.indexOf(reading.reason)];
    const row: Row = [wire.k.length, reading.value, indexes[0] < 0 ? wire.u.length : indexes[0], indexes[1] < 0 ? wire.s.length : indexes[1], reading.ageMs, reading.ttlMs, QUALITIES.indexOf(reading.quality)];
    if (reading.reason !== undefined) row.push(indexes[2] < 0 ? wire.d.length : indexes[2]);
    const extra = [key, ...(indexes[0] < 0 ? [reading.unit] : []), ...(indexes[1] < 0 ? [reading.source] : []), ...(reading.reason !== undefined && indexes[2] < 0 ? [reading.reason] : [])]
      .reduce((n, value) => n + Buffer.byteLength(JSON.stringify(value)) + 1, Buffer.byteLength(JSON.stringify(row)) + 1);
    if (bytes + extra > MAX_INSTRUMENT_BYTES) { wire.n++; continue; }
    bytes += extra; wire.k.push(key); wire.r.push(row);
    if (indexes[0] < 0) wire.u.push(reading.unit);
    if (indexes[1] < 0) wire.s.push(reading.source);
    if (reading.reason !== undefined && indexes[2] < 0) wire.d.push(reading.reason);
  }
  return wire;
}
