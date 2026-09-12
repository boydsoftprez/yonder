// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-27, R-STO-03: disk admission and durable, bounded terrain metadata.
import {constants} from 'node:fs';
import {access, lstat, mkdir, open, readFile, realpath, rename, statfs, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join, parse, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export const HGT_TILE_BYTES = 3601 * 3601 * 2;
export const MAX_TERRAIN_METADATA_BYTES = 1024 * 1024;
export interface StorageObservation {
  persistent: boolean;
  writable: boolean;
  freeBytes: number;
  filesystem: string | null;
  reason: string | null;
}

function unescapeMount(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/** Select the actual containing mount, including nested bind mounts. */
export function containingMount(path: string, mountinfo: string): {filesystem: string; readOnly: boolean} | null {
  let selected: {length: number; filesystem: string; readOnly: boolean} | null = null;
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = left.split(' '), after = right.split(' ');
    if (fields.length < 6 || after.length < 3) continue;
    const mount = unescapeMount(fields[4]);
    if (path !== mount && !path.startsWith(mount === '/' ? '/' : `${mount}/`)) continue;
    if (selected && mount.length < selected.length) continue;
    selected = {length: mount.length, filesystem: after[0],
      readOnly: fields[5].split(',').includes('ro') || after[2].split(',').includes('ro')};
  }
  return selected && {filesystem: selected.filesystem, readOnly: selected.readOnly};
}

/** Reject symlinks in every component, including existing parents. */
export async function ensureTerrainDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Terrain storage path must be absolute');
  const normalized = resolve(path);
  let current = parse(normalized).root;
  for (const component of normalized.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, component);
    try { await mkdir(current, {mode: 0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Terrain storage requires real directories without symlinks');
  }
  if (await realpath(normalized) !== normalized) throw new Error('Terrain storage path changed');
  return normalized;
}

export async function probeTerrainStorage(path: string, verifyWrite = false): Promise<StorageObservation> {
  try {
    const root = await realpath(path);
    if (root !== resolve(path) || !(await lstat(root)).isDirectory()) throw new Error('Terrain storage path changed');
    const mount = containingMount(root, await readFile('/proc/self/mountinfo', 'utf8'));
    const persistent = !!mount && ['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'zfs'].includes(mount.filesystem);
    if (!persistent || mount?.readOnly) return {persistent, writable: false, freeBytes: 0,
      filesystem: mount?.filesystem ?? null, reason: mount?.readOnly ? 'storage-read-only' : 'persistent-storage-unverified'};
    const medium = await statfs(root, {bigint: true});
    const free = medium.bavail * medium.bsize;
    const freeBytes = Number(free > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : free);
    await access(root, constants.W_OK);
    if (verifyWrite) {
    const probe = join(root, `.write-probe-${randomUUID()}`);
    const handle = await open(probe, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile('terrain'); await handle.sync(); }
    finally { await handle.close(); await unlink(probe); }
    }
    return {persistent: true, writable: true, freeBytes, filesystem: mount!.filesystem, reason: null};
  } catch (error) {
    return {persistent: false, writable: false, freeBytes: 0, filesystem: null,
      reason: `storage-unavailable: ${error instanceof Error ? error.message : String(error)}`};
  }
}

export function admitTerrainBytes(observation: StorageObservation, usedBytes: number, additionalBytes: number,
  quotaBytes: number, reserveBytes: number): void {
  if (![usedBytes, additionalBytes, quotaBytes, reserveBytes, observation.freeBytes].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('Invalid terrain storage accounting');
  }
  if (!observation.persistent || !observation.writable) throw new Error(observation.reason ?? 'persistent-storage-unavailable');
  if (additionalBytes > quotaBytes - usedBytes) throw new Error('terrain-quota-exceeded');
  if (additionalBytes > observation.freeBytes - reserveBytes) throw new Error('storage-reserve-reached');
}

export async function readTerrainMetadata(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_TERRAIN_METADATA_BYTES) throw new Error('Terrain metadata exceeds limit');
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) throw new Error('Truncated terrain metadata');
      offset += read.bytesRead;
    }
    if ((await handle.stat()).size !== info.size) throw new Error('Terrain metadata changed while reading');
    return JSON.parse(buffer.toString('utf8'));
  } finally { await handle.close(); }
}

export async function syncTerrainDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Fault hooks exercise crash boundaries without replacing filesystem semantics. */
export async function writeTerrainMetadata(path: string, value: unknown,
  checkpoint?: (stage: 'written' | 'synced' | 'renamed') => void | Promise<void>): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > MAX_TERRAIN_METADATA_BYTES) throw new Error('Terrain metadata exceeds limit');
  const temp = join(dirname(path), `.metadata-${randomUUID()}`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await checkpoint?.('written');
    await handle.sync();
    await checkpoint?.('synced');
  } catch (error) {
    await handle.close(); await unlink(temp).catch(() => {}); throw error;
  }
  await handle.close();
  try {
    await rename(temp, path);
    await checkpoint?.('renamed');
    await syncTerrainDirectory(dirname(path));
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
