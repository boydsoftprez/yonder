// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireBase, readLock, validateLock } from './bases.mjs';
const original = await readLock(new URL('../bases.lock.json', import.meta.url));
const bytes = Buffer.from('a disposable compressed-image stand-in');
function fixture() {
  const lock = structuredClone(original);
  lock.targets.rpi.sha256 = createHash('sha256').update(bytes).digest('hex');
  return lock;
}
async function inCache(fn) { const cache = await mkdtemp(join(tmpdir(), 'yonder-base-test-')); try { await fn(cache); } finally { await rm(cache, { recursive: true, force: true }); } }
test('rejects changed architecture, latest alias, missing target and traversal before download', () => {
  for (const mutate of [l => { l.targets.rpi.architecture = 'amd64'; }, l => { l.targets.rpi.url = 'https://example.com/latest'; }, l => { delete l.targets['radxa-rock5c']; }, l => { l.targets.rpi.fileName = '../escape.img.xz'; }]) {
    const lock = fixture(); mutate(lock); assert.throws(() => validateLock(lock));
  }
});
test('publishes verified bytes and reuses cache only after hashing', async () => inCache(async cache => {
  const lock = fixture(); let calls = 0;
  const fetcher = async url => { assert.equal(url, lock.targets.rpi.url); calls++; return new Response(bytes); };
  const path = await acquireBase(lock, 'rpi', cache, { fetcher });
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(await acquireBase(lock, 'rpi', cache, { fetcher }), path);
  assert.equal(calls, 1);
  await writeFile(path, 'damaged');
  await assert.rejects(acquireBase(lock, 'rpi', cache, { fetcher }), /Cached base checksum mismatch/);
  assert.equal(calls, 1);
}));
test('mismatch, oversized body and HTTP failure never publish a base or retain partials', async () => inCache(async cache => {
  for (const options of [{ fetcher: async () => new Response('wrong') }, { fetcher: async () => new Response(bytes), maxBytes: 2 }, { fetcher: async () => new Response('unavailable', { status: 503 }) }]) {
    await assert.rejects(acquireBase(fixture(), 'rpi', cache, options));
    assert.deepEqual(await readdir(cache), []);
  }
}));
test('a stream interrupted mid-transfer leaves no published or partial image', async () => inCache(async cache => {
  const fetcher = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 5)); controller.error(new Error('connection lost')); } }));
  await assert.rejects(acquireBase(fixture(), 'rpi', cache, { fetcher }), /connection lost/);
  assert.deepEqual(await readdir(cache), []);
}));

// A lock refresh must carry fresh evidence for every selected target.
test('committed inspection and source evidence match every locked base', async () => {
  const root = new URL('../inspection/', import.meta.url);
  const source = JSON.parse(await readFile(new URL('source-verification.json', root), 'utf8'));
  const targets = Object.keys(original.targets).sort();
  assert.deepEqual(Object.keys(source.targets).sort(), targets);
  assert.deepEqual((await readdir(root)).filter(n => n !== 'source-verification.json').sort(), targets.map(t => `${t}.json`).sort());
  for (const target of targets) {
    const report = JSON.parse(await readFile(new URL(`${target}.json`, root), 'utf8'));
    assert.equal(report.target, target);
    assert.equal(report.compressedSha256, original.targets[target].sha256);
    assert.equal(source.targets[target].compressedSha256, original.targets[target].sha256);
    assert.equal(source.targets[target].qualification, original.targets[target].qualification);
    assert.equal(source.targets[target].checksumVerified, true);
  }
});
