// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, open, realpath, rm, readdir, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {OfficialTerrainStore} from './store.js';
import {TerrainPreparationService} from './preparation.js';
import {HGT_TILE_BYTES} from './storage.js';
import type {PreparedArea, TileRecord} from './types.js';

const roots: string[] = [];
const probe = async () => ({persistent: true, writable: true, freeBytes: 8 * 1024 ** 3, filesystem: 'test-ext4', reason: null});
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'official-store-'))); roots.push(root);
  const options = {root, quotaBytes: 2 * 1024 ** 3, reserveBytes: 1024 ** 3, probe};
  return {root, options, store: await OfficialTerrainStore.open(options)};
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });
async function staged(store: OfficialTerrainStore, height = 123, tile = 'N35W084'): Promise<TileRecord & {path: string}> {
  const path = join(store.stagingDirectory, `${randomUUID()}.hgt`), handle = await open(path, 'wx');
  const chunk = Buffer.alloc(64 * 1024), hash = createHash('sha256');
  for (let i = 0; i < chunk.length; i += 2) chunk.writeInt16BE(height, i);
  try {
    for (let bytes = 0; bytes < HGT_TILE_BYTES;) {
      const next = chunk.subarray(0, Math.min(chunk.length, HGT_TILE_BYTES - bytes));
      await handle.writeFile(next); hash.update(next); bytes += next.length;
    }
    await handle.sync();
  } finally { await handle.close(); }
  return {path, tile, sha256: hash.digest('hex'), archiveSha256: 'a'.repeat(64), bytes: HGT_TILE_BYTES as 25934402,
    sourceUrl: `https://terrain.ardupilot.org/SRTM1/${tile}.hgt.zip`, retrievedAt: new Date().toISOString()};
}
function area(record: TileRecord): PreparedArea {
  return {id: randomUUID(), name: 'Test area', pinned: true, revision: 'test-revision', createdAt: new Date().toISOString(),
    kind: 'manual', objects: [{tile: record.tile, sha256: record.sha256}], complete: true, reasons: []};
}
const key = {latE7: 356985340, lonE7: -833616470, spacingM: 30 as const};

describe('OfficialTerrainStore', () => {
  it('serves prepared data after reopening without an acquisition dependency', async () => {
    const {store, options} = await setup();
    const record = await store.commitObject(await staged(store)); await store.saveArea(area(record));
    await store.close();
    const reopened = await OfficialTerrainStore.open(options);
    expect(await reopened.readSubgrid(key, 0)).toMatchObject({available: true, heights: Array(16).fill(123)});
    expect(await reopened.readSubgrid(key, 55)).toMatchObject({available: true, heights: Array(16).fill(123)});
    expect(await reopened.readSubgrid({...key, latE7: 0, lonE7: 0}, 0)).toEqual({available: false, reason: 'tile-not-prepared'});
    await reopened.close();
  });
  it('retains shared pinned objects until the final referencing area is removed', async () => {
    const {store, root} = await setup(); const record = await store.commitObject(await staged(store));
    const first = area(record), second = area(record); await store.saveArea(first); await store.saveArea(second);
    await store.discardUnreferenced([{tile: record.tile, sha256: record.sha256}]); expect(store.records()).toHaveLength(1);
    await store.removeArea(first.id); expect(store.records()).toHaveLength(1);
    expect(await store.readSubgrid(key, 0)).toMatchObject({available: true});
    await store.removeArea(second.id); expect(store.records()).toHaveLength(0);
    expect(await readdir(join(root, 'objects'))).toEqual([]); await store.close();
  });
  it('defers job-object cleanup while a reader holds the generation', async () => {
    const {store, root} = await setup(); const record = await store.commitObject(await staged(store));
    const id = `${record.tile}.${record.sha256}`;
    (store as unknown as {active: Map<string, number>}).active.set(id, 1);
    await store.discardUnreferenced([{tile: record.tile, sha256: record.sha256}]);
    expect(store.records()).toHaveLength(1); expect(await readdir(join(root, 'objects'))).toEqual([`${id}.hgt`]);
    expect((store as unknown as {deferredDiscard: Map<string, unknown>}).deferredDiscard.has(id)).toBe(true);
    (store as unknown as {active: Map<string, number>}).active.delete(id);
    await store.discardUnreferenced([{tile: record.tile, sha256: record.sha256}]);
    expect(store.records()).toHaveLength(0); expect(await readdir(join(root, 'objects'))).toEqual([]);
    expect((store as unknown as {deferredDiscard: Map<string, unknown>}).deferredDiscard.has(id)).toBe(false); await store.close();
  });
  it.each(['failed', 'cancelled'] as const)('restores storage after a multi-tile preparation is %s', async outcome => {
    const {store, root} = await setup(); const retained = await store.commitObject(await staged(store, 123, 'N34W084'));
    await store.saveArea(area(retained));
    const before = await store.status(), records = store.records(), areas = store.areas();
    const objects = await readdir(join(root, 'objects'));
    const service = new TerrainPreparationService({store,
      context: () => ({generation: 'test', connected: true, armed: false, missionRevision: null, homeRevision: null, rallyRevision: null}),
      policy: () => ({enabled: true, provider: 'ardupilot-srtm1', quotaMiB: 2048}),
      acquire: (tile, options) => {
        if (store.records().length === records.length) return staged(store, 456, tile);
        if (outcome === 'failed') return Promise.reject(new Error('source unavailable'));
        return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), {once: true}));
      }});
    const preview = await service.preview({kind: 'manual', name: 'Two tiles', bufferM: 100,
      bounds: {south: 35.6, north: 36.1, west: -83.4, east: -83.3}});
    expect(preview.coverage.tiles).toHaveLength(2);
    const job = service.prepare(preview.id, 'session');
    if (outcome === 'cancelled') {
      await vi.waitFor(() => expect(store.records()).toHaveLength(records.length + 1));
      await service.cancel(job.id, 'session');
    } else await service.settled();
    expect(service.snapshot()?.state).toBe(outcome);
    expect(store.records()).toEqual(records); expect(store.areas()).toEqual(areas);
    expect(await readdir(join(root, 'objects'))).toEqual(objects);
    expect((await store.status()).usedBytes).toBe(before.usedBytes);
    await service.close(); await store.close();
  });
  it('withholds nodata and rejects changed object content', async () => {
    const {store, root} = await setup(); const record = await store.commitObject(await staged(store, -32768)); await store.saveArea(area(record));
    expect(await store.readSubgrid(key, 0)).toEqual({available: false, reason: 'source-nodata'});
    expect(record.nodataSamples).toBe(3601 * 3601);
    const preparation = new TerrainPreparationService({store,
      context: () => ({generation:'test', connected:true, armed:false, missionRevision:null, homeRevision:null, rallyRevision:null}),
      policy: () => ({enabled:true, provider:'ardupilot-srtm1', quotaMiB:2048})});
    const preview = await preparation.preview({kind:'manual',name:'Void area',bufferM:100,
      bounds:{south:35.6,north:35.7,west:-83.4,east:-83.3}});
    preparation.prepare(preview.id,'session'); await preparation.settled();
    expect(preparation.snapshot()?.state).toBe('partial');
    expect(store.areas().at(-1)).toMatchObject({complete:false,coverage:{bufferM:100,bounds:{south:35.6,north:35.7,west:-83.4,east:-83.3}}});
    expect(preparation.prepare(preview.id,'session').id).toBe(preparation.snapshot()?.id);
    await preparation.close();
    const path = join(root, 'objects', `${record.tile}.${record.sha256}.hgt`);
    await chmod(path, 0o600); await writeFile(path, 'corrupt');
    expect(await store.readSubgrid(key, 0)).toEqual({available: false, reason: 'Terrain object changed'}); await store.close();
  });
  it('rejects corrupt generations without replacing prior usable metadata', async () => {
    const {store, options} = await setup(); const record = await store.commitObject(await staged(store));
    await store.saveArea(area(record));
    const corrupt = await staged(store, 456); corrupt.sha256 = 'b'.repeat(64);
    await expect(store.commitObject(corrupt)).rejects.toThrow('integrity');
    expect(await store.readSubgrid(key, 0)).toMatchObject({available: true, heights: Array(16).fill(123)});
    await store.close(); const reopened = await OfficialTerrainStore.open(options);
    expect(reopened.records()).toHaveLength(1); await reopened.close();
  });
  it('removes interrupted staging and unreferenced published objects on restart', async () => {
    const {store, root, options} = await setup(); await store.commitObject(await staged(store));
    await writeFile(join(store.stagingDirectory, 'interrupted.zip'), 'partial'); await store.close();
    const reopened = await OfficialTerrainStore.open(options); expect(await readdir(reopened.stagingDirectory)).toEqual([]);
    expect(reopened.records()).toEqual([]); expect(await readdir(join(root, 'objects'))).toEqual([]); await reopened.close();
  });
  it('refuses unknown manifest versions', async () => {
    const {store, root, options} = await setup(); await store.close();
    await writeFile(join(root, 'index.json'), '{"schemaVersion":2,"objects":[],"areas":[]}');
    await expect(OfficialTerrainStore.open(options)).rejects.toThrow();
  });
});

it('admits the full replacement metadata before changing a pin at the reserve boundary', async () => {
  const {store, options} = await setup(); const record = await store.commitObject(await staged(store));
  const selected = area(record); await store.saveArea(selected); await store.close();
  let freeBytes = 8 * 1024 ** 3;
  const reopened = await OfficialTerrainStore.open({...options,probe:async()=>({...await probe(),freeBytes})});
  freeBytes = options.reserveBytes;
  await expect(reopened.setPinned(selected.id,false)).rejects.toThrow('reserve');
  expect(reopened.areas()[0].pinned).toBe(true); await reopened.close();
});
