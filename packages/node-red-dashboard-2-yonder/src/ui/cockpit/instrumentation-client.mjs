// SPDX-License-Identifier: GPL-3.0-or-later
const qualities = ['reported', 'calculated', 'partial', 'unavailable'];
const fail = () => { throw new Error('Invalid instrumentation frame'); };
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const key = value => /^[a-zA-Z0-9_.-]{1,128}$/.test(value) && !value.split('.').some(part => ['__proto__', 'constructor', 'prototype'].includes(part));
const nonnegative = value => Number.isFinite(value) && value >= 0;
const index = (value, dictionary) => Number.isInteger(value) && value >= 0 && value < dictionary.length;

/** Decode GET /cockpit/api/instruments. Receipt never refreshes the included sample ages. */
export function unpackInstruments(wire) {
  if (!wire || wire.v !== 1 || !nonnegative(wire.at) || typeof wire.c !== 'boolean'
    || !(wire.g === null || text(wire.g, 128)) || !Number.isSafeInteger(wire.n) || wire.n < 0) fail();
  for (const [name, max] of [['k', 128], ['u', 24], ['s', 160], ['d', 256]]) {
    if (!Array.isArray(wire[name]) || wire[name].length > 512 || !wire[name].every(value => text(value, max))) fail();
    if (new Set(wire[name]).size !== wire[name].length) fail();
  }
  if (!wire.k.every(key) || wire.s.some(value => !value) || !Array.isArray(wire.r) || wire.r.length > 512 || wire.r.length !== wire.k.length) fail();
  if (new TextEncoder().encode(JSON.stringify(wire)).byteLength > 128 * 1024) fail();
  const fields = {}, seen = new Set();
  for (const row of wire.r) {
    if (!Array.isArray(row) || (row.length !== 7 && row.length !== 8)) fail();
    const [k, value, unit, source, ageMs, ttlMs, quality, reason] = row;
    if (!index(k, wire.k) || seen.has(k) || !index(unit, wire.u) || !index(source, wire.s)
      || !(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || text(value, 256))
      || !(ageMs === null || nonnegative(ageMs)) || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 86400000
      || !index(quality, qualities) || (row.length === 8 && !index(reason, wire.d))) fail();
    seen.add(k);
    fields[wire.k[k]] = { value, unit: wire.u[unit], source: wire.s[source], ageMs, ttlMs, quality: qualities[quality], ...(reason === undefined ? {} : { reason: wire.d[reason] }) };
  }
  return { at: wire.at, generation: wire.g, connected: wire.c, fields, ...(wire.n ? { truncated: wire.n } : {}) };
}
