// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { backendArgsFor, parseArgs, sourceEntriesFor, targetFacts } from './build.mjs';

const repo = new URL('../../', import.meta.url);
const readJson = async path => JSON.parse(await readFile(new URL(path, repo), 'utf8'));

test('builder defaults the legacy --output form to ROCK 5C', () => {
  assert.deepEqual(parseArgs(['--output', 'image/out/rock5c']), {
    help: false,
    output: 'image/out/rock5c',
    target: 'radxa-rock5c',
    storagePrototype: false
  });
});

test('builder selects each explicit board target and refuses invalid selections', () => {
  for (const target of ['rpi', 'radxa-zero3w', 'radxa-rock5c']) {
    assert.equal(parseArgs(['--target', target, '--output', 'image/out/candidate']).target, target);
  }
  assert.deepEqual(parseArgs(['--target', 'radxa-zero3w', '--storage-prototype', '--output', 'image/out/candidate']), {
    help: false, output: 'image/out/candidate', target: 'radxa-zero3w', storagePrototype: true
  });
  assert.equal(parseArgs(['--target', 'radxa-rock5c', '--storage-prototype', '--output', 'image/out/candidate']).storagePrototype, true);
  assert.deepEqual(parseArgs(['--target', 'rpi', '--storage-prototype', '--output', 'image/out/candidate']), {
    help: false, output: 'image/out/candidate', target: 'rpi', storagePrototype: true
  });
  for (const args of [
    ['--output', 'image/out/candidate', '--target', 'other-board'],
    ['--target', 'radxa-zero3w'],
    ['--output', 'a', '--output', 'b'],
    ['--target', 'radxa-zero3w', '--storage-prototype', '--storage-prototype', '--output', 'image/out/candidate']
  ]) assert.throws(() => parseArgs(args), /Usage:/);
});

test('Pi inputs preserve its inspected MBR and FAT identity and omit Rockchip payloads', async () => {
  const lock = await readJson('image/bases.lock.json');
  const inspection = await readJson('image/inspection/rpi.json');
  const facts = targetFacts(lock, inspection, 'rpi');
  assert.equal(facts.mbrDiskId, '0x041bba91');
  assert.equal(facts.bootFilesystemUuid, 'B2F0-82D2');
  assert.equal(facts.rootStartSector, 1064960);
  const entries = sourceEntriesFor('rpi');
  const prototypeEntries = sourceEntriesFor('rpi', true);
  assert.ok(entries.includes('image/pi'));
  assert.ok(prototypeEntries.includes('image/pi'));
  assert.ok(prototypeEntries.includes('image/storage'));
  assert.ok(!entries.includes('image/storage'));
  assert.ok(!prototypeEntries.includes('image/prototype'));
  assert.ok(!entries.includes('vendor/gst-rockchip'));
  assert.ok(!entries.includes('vendor/seekerhd'));
  assert.ok(sourceEntriesFor('radxa-zero3w', true).includes('vendor/seekerhd'));
  assert.ok(sourceEntriesFor('radxa-zero3w', true).includes('image/storage'));
  for (const mutate of [value => { value.partitions[0].startSector += 1; },
    value => { value.compressedSha256 = '0'.repeat(64); },
    value => { value.partitions[1].filesystem.uuid = '0'.repeat(36); }]) {
    const changed = structuredClone(inspection); mutate(changed);
    assert.throws(() => targetFacts(lock, changed, 'rpi'), /does not match/);
  }
});

test('outer builder routes each Pi mode without changing Radxa defaults', () => {
  assert.deepEqual(backendArgsFor('rpi', false), ['private-test']);
  assert.deepEqual(backendArgsFor('rpi', true), ['storage-prototype']);
  assert.deepEqual(backendArgsFor('radxa-zero3w', false), ['radxa-zero3w', 'bench']);
  assert.deepEqual(backendArgsFor('radxa-rock5c', true), ['radxa-rock5c', 'storage-prototype']);
  assert.throws(() => backendArgsFor('other-board', true), /Unknown backend target/);
});

test('ZERO 3W facts come from its locked inspection record', async () => {
  const lock = await readJson('image/bases.lock.json');
  const inspection = await readJson('image/inspection/radxa-zero3w.json');
  assert.deepEqual(targetFacts(lock, inspection, 'radxa-zero3w'), {
    target: 'radxa-zero3w',
    label: 'Radxa ZERO 3W',
    slug: 'zero3w',
    rawSha256: 'a78367cc5d099872cfc0664c0e18215ce4538931205a35b4cfef960220bb0dc8',
    opaqueGapSha256: 'e6d47fa7c4cd09b09004cb71f579d135107c86d6bd9fad5c4d854fcf68653269',
    rootStartSector: 32768,
    rootPartitionUuid: 'f77549c4-759d-497f-a3e2-11033bff595f',
    rootTypeGuid: 'b921b045-1df0-41c3-af44-4c6f280d3fae',
    rootFilesystemUuid: '2bae8c0f-7897-4388-a83a-f7f375d59dd1'
  });

  const mismatch = structuredClone(inspection);
  mismatch.target = 'radxa-rock5c';
  assert.throws(() => targetFacts(lock, mismatch, 'radxa-zero3w'), /does not match/);
});
