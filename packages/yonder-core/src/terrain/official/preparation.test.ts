// SPDX-License-Identifier: GPL-3.0-or-later
import {describe, expect, it, vi} from 'vitest';
import {TerrainPreparationService, type PreparationContext} from './preparation.js';
import type {OfficialTerrainStore} from './store.js';
import type {TileRecord} from './types.js';

const manual = {kind: 'manual' as const, name: 'Bench', bounds: {south: 35.6, north: 35.7, west: -83.4, east: -83.3}, bufferM: 100};
const record: TileRecord = {tile: 'N35W084', sha256: 'a'.repeat(64), archiveSha256: 'b'.repeat(64), bytes: 25934402, nodataSamples: 0,
  sourceUrl: 'https://terrain.ardupilot.org/SRTM1/N35W084.hgt.zip', retrievedAt: '2026-09-11T00:00:00.000Z'};
function setup() {
  const context: PreparationContext = {generation: 'first', connected: true, armed: false,
    missionRevision: null, homeRevision: null, rallyRevision: null};
  const saveArea = vi.fn(async (_area, guard) => { guard?.(); });
  const commitObject = vi.fn(async (_record, guard) => { guard?.(); return record; });
  const records = vi.fn((): TileRecord[] => []);
  const stub = {stagingDirectory: '/unused', status: async () => ({}), records, admit: async () => {}, saveArea, commitObject};
  const acquire = vi.fn(async () => ({...record, path: '/unused/verified.hgt'}));
  const service = new TerrainPreparationService({store: stub as unknown as OfficialTerrainStore, context: () => context,
    policy: () => ({enabled: true, provider: 'ardupilot-srtm1', quotaMiB: 2048}), acquire});
  return {service, context, acquire, saveArea, commitObject, records};
}
describe('operator terrain preparation', () => {
  it('deduplicates repeated prepare actions and continues without a browser', async () => {
    const {service, acquire, saveArea} = setup(); const preview = await service.preview(manual);
    const first = service.prepare(preview.id, 'session'); const duplicate = service.prepare(preview.id, 'session');
    expect(first.id).toBe(duplicate.id); await service.settled();
    expect(acquire).toHaveBeenCalledTimes(1); expect(saveArea).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toMatchObject({state: 'complete', completed: 1});
    expect(service.prepare(preview.id, 'session').id).toBe(first.id); await service.close();
  });
  it('refuses stale-generation previews and armed or unknown arm state', async () => {
    const {service, context} = setup(); const preview = await service.preview(manual);
    context.generation = 'reconnected'; expect(() => service.prepare(preview.id, 'session')).toThrow('Context changed');
    context.armed = true; await expect(service.preview(manual)).rejects.toThrow('disarmed');
    context.armed = null; await expect(service.preview(manual)).rejects.toThrow('disarmed'); await service.close();
  });
  it('withholds publication when aircraft state changes during acquisition', async () => {
    const {service, context, acquire, commitObject, saveArea} = setup();
    acquire.mockImplementation(async () => { context.armed = true; return {...record, path: '/unused/verified.hgt'}; });
    const preview = await service.preview(manual); service.prepare(preview.id, 'session'); await service.settled();
    expect(commitObject).not.toHaveBeenCalled(); expect(saveArea).not.toHaveBeenCalled();
    expect(service.snapshot()?.state).not.toBe('complete'); await service.close();
  });
  it('cancels active work without an area publication', async () => {
    const {service, acquire, saveArea} = setup();
    acquire.mockImplementation((_tile?: unknown, options?: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
    }) as any);
    const preview = await service.preview(manual), job = service.prepare(preview.id, 'session');
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled()); await service.cancel(job.id, 'session');
    expect(service.snapshot()?.state).toBe('cancelled'); expect(saveArea).not.toHaveBeenCalled(); await service.close();
  });
});

it('binds cached source hashes into the reviewed preview', async () => {
  const {service, records, acquire} = setup(); records.mockReturnValue([record]);
  const preview = await service.preview(manual);
  records.mockReturnValue([{...record,sha256:'c'.repeat(64)}]);
  expect(() => service.prepare(preview.id,'session')).toThrow('source generation changed');
  expect(acquire).not.toHaveBeenCalled(); await service.close();
});
