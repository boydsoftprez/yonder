// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27/28: immutable disk objects; reads never initiate downloads.
import {constants} from 'node:fs';
import {open, readdir, lstat, rename, unlink, chmod} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {decodeHgtWindow} from './hgt.js';
import {gridSampleStencil, interpolateHgt, sourceWindowFor, subgridLocations, type TerrainLocationE7} from './grid.js';
import {TerrainIndexSchema, TileRecordSchema, type PreparedArea, type TerrainIndex, type TileRecord,
  type TerrainRequestKey, type TerrainSample, type TerrainLocation} from './types.js';
import {admitTerrainBytes, ensureTerrainDirectory, HGT_TILE_BYTES, probeTerrainStorage, readTerrainMetadata,
  syncTerrainDirectory, writeTerrainMetadata, MAX_TERRAIN_METADATA_BYTES, type StorageObservation} from './storage.js';

export interface OfficialStoreOptions {
  root: string;
  quotaBytes: number;
  reserveBytes: number;
  /** Tests may inject observed temporary-filesystem persistence explicitly. */
  probe?: (root: string) => Promise<StorageObservation>;
}
export type SubgridResult = {available: true; heights: number[]; generations: string[]}
  | {available: false; reason: string};
const objectId = (record: {tile: string; sha256: string}) => `${record.tile}.${record.sha256}`;

export class OfficialTerrainStore {
  private index: TerrainIndex = {schemaVersion: 1, objects: [], areas: []};
  private active = new Map<string, number>();
  private verified = new Map<string, {mtimeMs: number; size: number}>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  readonly stagingDirectory: string;
  private constructor(private options: OfficialStoreOptions) { this.stagingDirectory = join(options.root, 'staging'); }

  static async open(options: OfficialStoreOptions): Promise<OfficialTerrainStore> {
    const store = new OfficialTerrainStore({...options, root: await ensureTerrainDirectory(options.root)});
    await ensureTerrainDirectory(join(store.options.root, 'objects'));
    await ensureTerrainDirectory(store.stagingDirectory);
    const observation = await store.probe(true);
    admitTerrainBytes(observation, 0, 0, options.quotaBytes, 0);
    try { store.index = TerrainIndexSchema.parse(await readTerrainMetadata(join(options.root, 'index.json'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // A stopped process cannot have an active preparation; staging is never read.
    for (const entry of await readdir(store.stagingDirectory, {withFileTypes: true})) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unexpected terrain staging entry');
      await unlink(join(store.stagingDirectory, entry.name));
    }
    for (const record of store.index.objects) await store.verify(record);
    await store.collectUnreferenced();
    await store.restoreMetadataHeadroom();
    return store;
  }

  private probe(verifyWrite = false): Promise<StorageObservation> { return this.options.probe ? this.options.probe(this.options.root) : probeTerrainStorage(this.options.root, verifyWrite); }
  private path(record: {tile: string; sha256: string}): string { return join(this.options.root, 'objects', `${objectId(record)}.hgt`); }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { if (this.closed) throw new Error('Terrain store closed'); return operation(); });
    this.tail = result.catch(() => {}); return result;
  }
  private async publish(index: TerrainIndex, guard?: () => void): Promise<void> {
    const validated = TerrainIndexSchema.parse(index);
    const bytes = Buffer.byteLength(JSON.stringify(validated) + '\n');
    if (bytes > MAX_TERRAIN_METADATA_BYTES) throw new Error('Terrain metadata exceeds limit');
    try { await this.admit(bytes); }
    catch (error) {
      if (!String(error).match(/quota|reserve/)) throw error;
      // Preallocated application headroom enables an atomic deletion even when
      // other writers have reached the shared reserve. Never spend the reserve.
      await unlink(join(this.options.root, '.metadata-headroom')).catch(missing => {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
      });
      await syncTerrainDirectory(this.options.root);
      await this.admit(bytes);
    }
    try { await writeTerrainMetadata(join(this.options.root, 'index.json'), validated, stage => { if (stage === 'synced') guard?.(); }); }
    catch (error) {
      // Rename may have completed before a directory-sync failure. Reconcile
      // memory with the complete on-disk generation before any later mutation.
      try { this.index = TerrainIndexSchema.parse(await readTerrainMetadata(join(this.options.root, 'index.json'))); }
      catch (readError) { if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError; }
      throw error;
    }
    this.index = validated;
    await this.restoreMetadataHeadroom();
  }
  private async restoreMetadataHeadroom(): Promise<void> {
    const path = join(this.options.root, '.metadata-headroom');
    try {
      try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid metadata headroom file'); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await this.admit(MAX_TERRAIN_METADATA_BYTES);
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(Buffer.alloc(MAX_TERRAIN_METADATA_BYTES)); await file.sync(); }
      finally { await file.close(); }
    } catch { /* Admission failure is reported by mutations; cached reads remain available. */ }
  }
  private async usedBytes(): Promise<number> {
    let used = 0, count = 0;
    for (const directory of [this.options.root, join(this.options.root, 'objects'), this.stagingDirectory]) {
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (++count > 8192) throw new Error('Terrain directory entry limit exceeded');
        if (entry.isDirectory() && directory === this.options.root && ['objects', 'staging'].includes(entry.name)) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unexpected terrain storage entry');
        used += (await lstat(join(directory, entry.name))).size;
      }
    }
    return used;
  }
  async admit(additionalBytes: number): Promise<void> {
    if (this.closed) throw new Error('Terrain store closed');
    admitTerrainBytes(await this.probe(), await this.usedBytes(), additionalBytes,
      this.options.quotaBytes, this.options.reserveBytes);
  }
  async status() {
    return {schemaVersion: 1, storage: await this.probe(), usedBytes: await this.usedBytes(),
      quotaBytes: this.options.quotaBytes, reserveBytes: this.options.reserveBytes,
      objects: this.index.objects.length, areas: structuredClone(this.index.areas)};
  }
  configure(quotaBytes: number, reserveBytes: number): void {
    if (![quotaBytes, reserveBytes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid terrain storage policy');
    this.options.quotaBytes = quotaBytes; this.options.reserveBytes = reserveBytes;
  }
  records(): TileRecord[] { return structuredClone(this.index.objects); }
  areas(): PreparedArea[] { return structuredClone(this.index.areas); }

  private async verify(record: TileRecord): Promise<void> {
    const file = await open(this.path(record), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size !== HGT_TILE_BYTES) throw new Error('Invalid terrain object length');
      const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let offset = 0, nodataSamples = 0, highByte = -1;
      while (offset < before.size) {
        const read = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!read.bytesRead) throw new Error('Truncated terrain object');
        hash.update(buffer.subarray(0, read.bytesRead));
        for (let index = 0; index < read.bytesRead; index++) {
          if ((offset + index) % 2 === 0) highByte = buffer[index];
          else if (highByte === 0x80 && buffer[index] === 0) nodataSamples++;
        }
        offset += read.bytesRead;
      }
      const after = await file.stat();
      if (hash.digest('hex') !== record.sha256 || after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
        throw new Error('Terrain object integrity failure');
      }
      if (record.nodataSamples !== undefined && record.nodataSamples !== nodataSamples) throw new Error('Terrain validity metadata mismatch');
      record.nodataSamples = nodataSamples;
      this.verified.set(objectId(record), {mtimeMs: after.mtimeMs, size: after.size});
    } finally { await file.close(); }
  }

  async commitObject(staged: TileRecord & {path: string}, guard?: () => void): Promise<TileRecord> {
    return this.serialize(async () => {
      const {path, ...metadata} = staged;
      const record = TileRecordSchema.parse(metadata);
      if (dirname(path) !== this.stagingDirectory) throw new Error('Invalid terrain staging path');
      const existing = this.index.objects.find(value => objectId(value) === objectId(record));
      if (existing) { await unlink(path); return structuredClone(existing); }
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== HGT_TILE_BYTES) throw new Error('Invalid staged terrain object');
      guard?.();
      await rename(path, this.path(record));
      await chmod(this.path(record), 0o400);
      await syncTerrainDirectory(join(this.options.root, 'objects'));
      await this.verify(record);
      await this.publish({...this.index, objects: [...this.index.objects, record]}, guard);
      return record;
    });
  }
  async saveArea(area: PreparedArea, guard?: () => void): Promise<void> {
    return this.serialize(async () => {
      await this.publish({...this.index, areas: [...this.index.areas.filter(value => value.id !== area.id), area]}, guard);
    });
  }
  async setPinned(id: string, pinned: boolean): Promise<void> {
    return this.serialize(async () => {
      if (!this.index.areas.some(area => area.id === id)) throw new Error('Unknown terrain area');
      await this.publish({...this.index, areas: this.index.areas.map(area => area.id === id ? {...area, pinned} : area)});
    });
  }
  async removeArea(id: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.index.areas.some(area => area.id === id)) throw new Error('Unknown terrain area');
      await this.publish({...this.index, areas: this.index.areas.filter(area => area.id !== id)});
      await this.collectUnreferenced(true);
    });
  }
  private async collectUnreferenced(evict = false): Promise<void> {
    // Keep indexed objects available between object publication and area publication.
    // Explicit area deletion reclaims only objects no remaining area or reader uses.
    const referenced = new Set(this.index.areas.flatMap(area => area.objects.map(objectId)));
    const removable = this.index.objects.filter(record => !referenced.has(objectId(record)) && !this.active.has(objectId(record)));
    if (evict && removable.length) {
      await this.publish({...this.index, objects: this.index.objects.filter(record => !removable.includes(record))});
    }
    const retained = new Set(this.index.objects.map(record => `${objectId(record)}.hgt`));
    for (const entry of await readdir(join(this.options.root, 'objects'), {withFileTypes: true})) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unexpected terrain object entry');
      if (!retained.has(entry.name)) await unlink(join(this.options.root, 'objects', entry.name));
    }
  }

  private select(tile: string, index = this.index): TileRecord | undefined {
    // Only an atomically published area activates a new generation. A partially
    // downloaded update cannot replace a previously prepared area's samples.
    const reference = [...index.areas].reverse().flatMap(area => area.objects).find(object => object.tile === tile);
    return reference && index.objects.find(record => record.tile === tile && record.sha256 === reference.sha256);
  }
  async sourceSample(location: TerrainLocationE7, signal?: AbortSignal, index = this.index): Promise<{height: number | null; generation: string} | null> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('Terrain store closed');
    const descriptor = sourceWindowFor(location), record = this.select(descriptor.tile, index);
    if (!record) return null;
    const id = objectId(record);
    this.active.set(id, (this.active.get(id) ?? 0) + 1);
    try {
      const file = await open(this.path(record), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat(), verified = this.verified.get(id);
        if (!verified || info.size !== verified.size || info.mtimeMs !== verified.mtimeMs) throw new Error('Terrain object changed');
        const bytes = Buffer.alloc(8);
        for (let row = 0; row < 2; row++) {
          signal?.throwIfAborted();
          const result = await file.read(bytes, row * 4, 4, ((descriptor.rowStart + row) * 3601 + descriptor.columnStart) * 2);
          if (result.bytesRead !== 4) throw new Error('Truncated terrain window');
        }
        const after = await file.stat();
        if (after.mtimeMs !== verified.mtimeMs || after.size !== verified.size) throw new Error('Terrain object changed during read');
        return {height: interpolateHgt(location, decodeHgtWindow(bytes, {tile: descriptor.tile, schemaVersion: 1,
          rowStart: descriptor.rowStart, columnStart: descriptor.columnStart, rows: 2, columns: 2})), generation: record.sha256};
      } finally { await file.close(); }
    } finally {
      const count = this.active.get(id)! - 1;
      if (count) this.active.set(id, count); else this.active.delete(id);
    }
  }
  async readSubgrid(key: TerrainRequestKey, bit: number, signal?: AbortSignal): Promise<SubgridResult> {
    try {
      const heights: number[] = [], generations = new Set<string>();
      const records = this.index;
      for (const location of subgridLocations(key, bit)) {
        const sample = await this.sourceSample(location, signal, records);
        if (!sample || sample.height === null) return {available: false, reason: sample ? 'source-nodata' : 'tile-not-prepared'};
        heights.push(Math.trunc(sample.height)); generations.add(sample.generation);
      }
      return {available: true, heights, generations: [...generations]};
    } catch (error) { return {available: false, reason: error instanceof Error ? error.message : 'terrain-read-failed'}; }
  }
  async sampleAt(location: TerrainLocation, signal?: AbortSignal): Promise<TerrainSample> {
    if (![location.lat, location.lon].every(Number.isFinite) || Math.abs(location.lat) >= 90 || Math.abs(location.lon) > 180) {
      return {available: false, reason: 'invalid-terrain-coordinate'};
    }
    try {
      const stencil = gridSampleStencil({latE7: Math.round(location.lat * 1e7), lonE7: Math.round(location.lon * 1e7)});
      const records = this.index, generations = new Set<string>();
      let heightM = 0;
      for (let index = 0; index < stencil.locations.length; index++) {
        const sample = await this.sourceSample(stencil.locations[index], signal, records);
        if (!sample || sample.height === null) return {available: false, reason: sample ? 'source-nodata' : 'tile-not-prepared'};
        heightM += Math.trunc(sample.height) * stencil.weights[index]; generations.add(sample.generation);
      }
      return {available: true, heightM, provider: 'ardupilot-srtm1', generation: [...generations].sort().join(':'),
        spacingM: 30, datum: 'MSL', datumEvidence: 'Official ArduPilot ALOS-derived SRTM1; generated 30 m grid; no additional datum correction applied'};
    } catch (error) { return {available: false, reason: error instanceof Error ? error.message : 'terrain-sample-failed'}; }
  }
  async close(): Promise<void> { this.closed = true; await this.tail; }
}
