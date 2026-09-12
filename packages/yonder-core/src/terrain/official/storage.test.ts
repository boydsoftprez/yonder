// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {admitTerrainBytes, containingMount, ensureTerrainDirectory, MAX_TERRAIN_METADATA_BYTES,
  readTerrainMetadata, writeTerrainMetadata} from './storage.js';

const roots: string[] = [];
async function temporary(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'terrain-storage-')));
  roots.push(root); return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive: true, force: true}))); });

describe('persistent terrain storage boundaries', () => {
  it('selects the deepest mount, preserving bind read-only and escaped path semantics', () => {
    const mounts = '1 0 0:1 / / rw - overlay overlay rw\n'
      + '2 1 8:1 /app /var/lib/yonder rw - ext4 /dev/mmcblk0p3 rw\n'
      + '3 2 0:2 / /var/lib/yonder/terrain ro - tmpfs tmpfs rw\n'
      + '4 1 8:2 / /with\\040space rw - ext4 /dev/sdb1 ro\n';
    expect(containingMount('/var/lib/yonder/state', mounts)).toEqual({filesystem: 'ext4', readOnly: false});
    expect(containingMount('/var/lib/yonder/terrain/objects', mounts)).toEqual({filesystem: 'tmpfs', readOnly: true});
    expect(containingMount('/with space/data', mounts)).toEqual({filesystem: 'ext4', readOnly: true});
    expect(containingMount('/var/lib/yonder-other', mounts)?.filesystem).toBe('overlay');
  });

  it('refuses the observed image-mule headroom without lowering the shared reserve', () => {
    const observed = {persistent: true, writable: true, freeBytes: 450 * 1024 ** 2, filesystem: 'ext4', reason: null};
    expect(() => admitTerrainBytes(observed, 0, 35 * 1024 ** 2, 2048 * 1024 ** 2, 1024 * 1024 ** 2)).toThrow('storage-reserve');
    expect(() => admitTerrainBytes({...observed, freeBytes: 3 * 1024 ** 3}, 0, 35 * 1024 ** 2,
      2048 * 1024 ** 2, 1024 * 1024 ** 2)).not.toThrow();
    expect(() => admitTerrainBytes(observed, 100, 11, 110, 0)).toThrow('quota');
    expect(() => admitTerrainBytes({...observed, persistent: false}, 0, 1, 100, 0)).toThrow('persistent');
  });

  it('rejects symlink storage parents and metadata', async () => {
    const root = await temporary();
    await symlink(root, join(root, 'alias'));
    await expect(ensureTerrainDirectory(join(root, 'alias', 'terrain'))).rejects.toThrow('symlink');
    await writeFile(join(root, 'real.json'), '{}');
    await symlink(join(root, 'real.json'), join(root, 'metadata.json'));
    await expect(readTerrainMetadata(join(root, 'metadata.json'))).rejects.toThrow();
    await expect(ensureTerrainDirectory(join(root, 'safe', 'terrain'))).resolves.toBe(join(root, 'safe', 'terrain'));
  });

  it.each(['written', 'synced'] as const)('preserves previous metadata after failure at %s', async stage => {
    const path = join(await temporary(), 'index.json');
    await writeTerrainMetadata(path, {generation: 'old'});
    await expect(writeTerrainMetadata(path, {generation: 'new'}, point => {
      if (point === stage) throw new Error('power-cut');
    })).rejects.toThrow('power-cut');
    expect(await readTerrainMetadata(path)).toEqual({generation: 'old'});
  });

  it('has a complete new document after rename even if directory sync is interrupted', async () => {
    const path = join(await temporary(), 'index.json');
    await writeTerrainMetadata(path, {generation: 'old'});
    await expect(writeTerrainMetadata(path, {generation: 'new'}, stage => {
      if (stage === 'renamed') throw new Error('power-cut');
    })).rejects.toThrow('power-cut');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({generation: 'new'});
  });

  it('bounds metadata before read allocation and before replacement', async () => {
    const path = join(await temporary(), 'index.json');
    await writeTerrainMetadata(path, {generation: 'old'});
    await expect(writeTerrainMetadata(path, 'x'.repeat(MAX_TERRAIN_METADATA_BYTES))).rejects.toThrow('limit');
    expect(await readTerrainMetadata(path)).toEqual({generation: 'old'});
    await writeFile(path, 'x'.repeat(MAX_TERRAIN_METADATA_BYTES + 1));
    await expect(readTerrainMetadata(path)).rejects.toThrow('limit');
  });
});
