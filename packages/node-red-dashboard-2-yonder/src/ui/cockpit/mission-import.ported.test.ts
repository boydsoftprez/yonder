// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {test} from 'vitest';
import { fileURLToPath } from 'node:url';

import { isPositionItem, normalizeMission, parseMission } from './mission-import.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFile(join(here, 'fixtures', name), 'utf8');

test('QuadPlane payload placement is a navigation point while ROI is an action location',()=>{
 const p={frame:3,lat:35.96,lon:-83.36,alt:20};
 assert.equal(isPositionItem({...p,command:94}),true);
 assert.equal(isPositionItem({...p,command:195}),false);
});

test('imports Mission Planner WPL home and preserves non-contiguous mission sequences', async () => {
  const mission = parseMission(await fixture('coastal-mission.waypoints'), 'coastal-mission.waypoints');

  assert.equal(mission.name, 'coastal-mission');
  assert.equal(mission.source, 'Mission Planner QGC WPL 110');
  assert.deepEqual(mission.home, { lat: 35.2368, lon: -120.642, alt: 70 });
  assert.deepEqual(mission.items.map(({ seq }) => seq), [1, 2, 7, 9]);
  assert.match(mission.warnings[0], /sequence 0.*home/i);
});

test('preserves WPL navigation, loiter, action, and unknown-frame fields', async () => {
  const mission = parseMission(await fixture('coastal-mission.waypoints'));

  assert.deepEqual(mission.items[1], {
    seq: 2,
    command: 18,
    frame: 3,
    params: [2, 0, 35, 0],
    lat: 35.245,
    lon: -120.612,
    alt: 130,
    current: false,
    autocontinue: true,
  });
  assert.equal(mission.items[2].command, 183);
  assert.deepEqual(mission.items[2].params, [9, 1750, 0, 0]);
  assert.equal(mission.items[3].frame, 99);
  assert.match(mission.warnings.join('\n'), /frame 99/i);
});

test('preserves a sequence-zero item that is not a Mission Planner home record', () => {
  const wpl = [
    'QGC WPL 110',
    '0\t1\t3\t22\t15\t0\t0\t0\t0\t0\t80\t1',
    '1\t0\t3\t16\t0\t0\t0\t0\t35\t-120\t100\t1',
  ].join('\n');

  const mission = parseMission(wpl);
  assert.equal(mission.home, null);
  assert.deepEqual(mission.items.map(({ seq, command }) => ({ seq, command })), [
    { seq: 0, command: 22 },
    { seq: 1, command: 16 },
  ]);
  assert.match(mission.warnings.join('\n'), /sequence 0.*not.*home.*preserved/i);
});

test('rejects duplicate sequence zero before extracting a Mission Planner home record', () => {
  const wpl = [
    'QGC WPL 110',
    '0\t1\t0\t16\t0\t0\t0\t0\t35\t-120\t50\t1',
    '0\t0\t3\t16\t0\t0\t0\t0\t35.1\t-120.1\t100\t1',
  ].join('\n');

  assert.throws(() => parseMission(wpl), /duplicate sequence 0/i);
});

test('imports QGroundControl SimpleItems using doJumpId and preserves DO_JUMP null position parameters', async () => {
  const mission = parseMission(await fixture('coastal-mission.plan'), 'coastal-mission.plan');

  assert.equal(mission.name, 'coastal-mission');
  assert.equal(mission.source, 'QGroundControl Plan');
  assert.deepEqual(mission.home, { lat: 35.2368, lon: -120.642, alt: 68.5 });
  assert.deepEqual(mission.items.map(({ seq }) => seq), [1, 4, 8]);
  assert.deepEqual(mission.items[2], {
    seq: 8,
    command: 177,
    frame: 2,
    params: [4, 2, 0, 0],
    lat: null,
    lon: null,
    alt: null,
    current: false,
    autocontinue: true,
  });
});

test('position helper accepts supported global navigation items and excludes action commands', () => {
  const waypoint = { command: 16, frame: 3, lat: 35, lon: -120 };
  const localWaypoint = { command: 16, frame: 1, lat: 35, lon: -120 };
  const action = { command: 177, frame: 2, lat: null, lon: null };

  assert.equal(isPositionItem(waypoint), true);
  assert.equal(isPositionItem(localWaypoint), false);
  assert.equal(isPositionItem(action), false);
});

test('position helper treats zero-coordinate takeoff and land as current-location commands', () => {
  assert.equal(isPositionItem({ command: 22, frame: 3, lat: 0, lon: 0 }), false);
  assert.equal(isPositionItem({ command: 21, frame: 0, lat: 0, lon: 0 }), false);
  assert.equal(isPositionItem({ command: 84, frame: 10, lat: 0, lon: 0 }), false);
  assert.equal(isPositionItem({ command: 85, frame: 11, lat: 0, lon: 0 }), false);
  assert.equal(isPositionItem({ command: 22, frame: 3, lat: 35, lon: -120 }), true);
});

test('rejects QGroundControl ComplexItems instead of dropping their geometry', () => {
  const plan = {
    fileType: 'Plan', version: 1,
    mission: {
      version: 2,
      plannedHomePosition: [35, -120, 10],
      items: [{ type: 'ComplexItem', complexItemType: 'survey', doJumpId: 1 }],
    },
  };

  assert.throws(() => parseMission(JSON.stringify(plan)), /ComplexItem.*survey.*unsupported/i);
});

test('rejects duplicate WPL sequences and duplicate QGC doJumpIds', () => {
  const wpl = [
    'QGC WPL 110',
    '1\t0\t3\t16\t0\t0\t0\t0\t35\t-120\t100\t1',
    '1\t0\t3\t16\t0\t0\t0\t0\t36\t-121\t100\t1',
  ].join('\n');
  const plan = {
    fileType: 'Plan', version: 1,
    mission: { version: 2, items: [
      { type: 'SimpleItem', doJumpId: 2, command: 16, frame: 3, params: [0, 0, 0, 0, 35, -120, 100], autoContinue: true },
      { type: 'SimpleItem', doJumpId: 2, command: 16, frame: 3, params: [0, 0, 0, 0, 36, -121, 100], autoContinue: true },
    ] },
  };

  assert.throws(() => parseMission(wpl), /duplicate sequence 1/i);
  assert.throws(() => parseMission(JSON.stringify(plan)), /duplicate sequence 2/i);
});

test('rejects invalid and non-finite geospatial coordinates', () => {
  const badLatitude = 'QGC WPL 110\n1\t0\t3\t16\t0\t0\t0\t0\t91\t-120\t100\t1';
  const badLongitude = 'QGC WPL 110\n1\t0\t3\t16\t0\t0\t0\t0\t35\t-181\t100\t1';
  const nonFinite = 'QGC WPL 110\n1\t0\t3\t16\t0\t0\t0\t0\tNaN\t-120\t100\t1';

  assert.throws(() => parseMission(badLatitude), /latitude.*91/i);
  assert.throws(() => parseMission(badLongitude), /longitude.*-181/i);
  assert.throws(() => parseMission(nonFinite), /latitude.*finite/i);
});

test('does not coerce null QGC action coordinates to zero', () => {
  const plan = {
    fileType: 'Plan', version: 1,
    mission: { version: 2, items: [
      { type: 'SimpleItem', doJumpId: 1, command: 183, frame: 2, params: [9, 1750, null, null, null, null, null], autoContinue: false },
    ] },
  };

  const [item] = parseMission(JSON.stringify(plan)).items;
  assert.deepEqual(item.params, [9, 1750, null, null]);
  assert.equal(item.lat, null);
  assert.equal(item.lon, null);
  assert.equal(item.alt, null);
});

test('rejects missing positions on global geospatial commands but allows them on actions', () => {
  const plan = {
    fileType: 'Plan', version: 1,
    mission: { version: 2, items: [
      { type: 'SimpleItem', doJumpId: 1, command: 16, frame: 3, params: [0, 0, 0, 0, null, null, 100], autoContinue: true },
    ] },
  };

  assert.throws(() => parseMission(JSON.stringify(plan)), /sequence 1.*latitude.*finite/i);
});

test('preserves local and unknown frames but warns that they are unavailable for map geometry', () => {
  const mission = normalizeMission({
    name: 'local mission', source: 'backend', home: null, warnings: [],
    items: [
      { seq: 1, command: 16, frame: 1, params: [0, 0, 0, 0], lat: 10, lon: 20, alt: 30, current: false, autocontinue: true },
      { seq: 2, command: 16, frame: 250, params: [0, 0, 0, 0], lat: 35, lon: -120, alt: 40, current: false, autocontinue: true },
    ],
  });

  assert.deepEqual(mission.items.map(({ frame }) => frame), [1, 250]);
  assert.equal(isPositionItem(mission.items[0]), false);
  assert.equal(isPositionItem(mission.items[1]), false);
  assert.match(mission.warnings.join('\n'), /frame 1/i);
  assert.match(mission.warnings.join('\n'), /frame 250/i);
});

test('normalizes a valid backend snapshot without trusting its field types', () => {
  const snapshot = {
    name: 'Backend route', source: 'backend', home: { lat: 35, lon: -120, alt: 90 }, warnings: ['upstream note'],
    items: [{ seq: 4, command: 16, frame: 3, params: [0, 0, 0, 0], lat: 35.1, lon: -120.1, alt: 120, current: false, autocontinue: true }],
  };
  assert.deepEqual(normalizeMission(snapshot), snapshot);

  assert.throws(() => normalizeMission({ ...snapshot, items: [{ ...snapshot.items[0], command: '16' }] }), /command.*integer/i);
  assert.throws(() => normalizeMission({ ...snapshot, warnings: 'none' }), /warnings.*array/i);
});

test('rejects empty, header-only, malformed, and unsupported-version inputs clearly', () => {
  assert.throws(() => parseMission(''), /empty/i);
  assert.throws(() => parseMission('QGC WPL 110\n'), /no mission items/i);
  assert.throws(() => parseMission('QGC WPL 120\n1\t0'), /unsupported.*WPL/i);
  assert.throws(() => parseMission('{not json'), /invalid JSON/i);
  assert.throws(() => parseMission('not a mission'), /unsupported mission file/i);
});

test('rejects oversized text and more than 2000 items', () => {
  assert.throws(() => parseMission(`QGC WPL 110\n${' '.repeat(2 * 1024 * 1024)}`), /too large/i);

  const item = { type: 'SimpleItem', command: 183, frame: 2, params: [1, 2, 3, 4, null, null, null], autoContinue: true };
  const items = Array.from({ length: 2001 }, (_, index) => ({ ...item, doJumpId: index + 1 }));
  const plan = { fileType: 'Plan', version: 1, mission: { version: 2, items } };
  assert.throws(() => parseMission(JSON.stringify(plan)), /more than 2000/i);
});

test('rejects malformed normalized snapshots including invalid home and duplicate sequences', () => {
  const base = {
    name: 'Backend route', source: 'backend', home: null, warnings: [],
    items: [{ seq: 1, command: 183, frame: 2, params: [1, 2, 3, 4], lat: null, lon: null, alt: null, current: false, autocontinue: true }],
  };

  assert.throws(() => normalizeMission({ ...base, home: { lat: 100, lon: 0, alt: 0 } }), /home latitude/i);
  assert.throws(() => normalizeMission({ ...base, items: [...base.items, { ...base.items[0] }] }), /duplicate sequence 1/i);
  assert.throws(() => normalizeMission({ ...base, items: [{ ...base.items[0], params: [1, 2, 3] }] }), /four parameters/i);
});
