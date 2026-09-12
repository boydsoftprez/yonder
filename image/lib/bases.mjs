// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const TARGETS = ['rpi', 'radxa-zero3w', 'radxa-rock5c'];
export function validateLock(lock) {
  if (lock?.schemaVersion !== 1 || !lock.targets || typeof lock.targets !== 'object') throw new Error('Invalid base lock schema');
  if (Object.keys(lock.targets).sort().join() !== [...TARGETS].sort().join()) throw new Error('Base lock must name exactly the three supported targets');
  for (const target of TARGETS) {
    const b = lock.targets[target];
    if (!b || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.img\.xz$/.test(b.fileName ?? '') || !/^[a-f0-9]{64}$/.test(b.sha256 ?? '')) throw new Error(`Invalid base identity: ${target}`);
    for (const field of ['url', 'sha256Url']) {
      const url = new URL(b[field]);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`Invalid base URL: ${target}`);
      if (!url.pathname.endsWith('/' + b.fileName + (field === 'sha256Url' ? (target === 'rpi' ? '.sha256' : '.sha') : ''))) throw new Error(`Base URL does not match pinned filename: ${target}`);
    }
    if (b.release !== 'trixie' || b.architecture !== 'arm64' || b.qualification !== 'unqualified') throw new Error(`Unsupported base contract: ${target}`);
    if (b.kernelFamily !== (target === 'rpi' ? 'raspberry-pi' : 'vendor')) throw new Error(`Wrong kernel family: ${target}`);
  }
  return lock;
}
export async function readLock(path) { return validateLock(JSON.parse(await readFile(path, 'utf8'))); }
export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyExisting(path, expected) {
  try {
    if (await digest(path) !== expected) throw new Error(`Cached base checksum mismatch: ${path}`);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
// Download only the pinned URL. Never resolve a latest alias or refresh the lock here.
export async function acquireBase(lock, target, cache, { fetcher = fetch, maxBytes = 4 * 1024 ** 3 } = {}) {
  validateLock(lock);
  if (!TARGETS.includes(target)) throw new Error('Unknown image target');
  const base = lock.targets[target];
  await mkdir(cache, { recursive: true });
  const destination = join(cache, `${base.sha256}-${base.fileName}`);
  if (await verifyExisting(destination, base.sha256)) return destination;
  const temporary = destination + '.partial-' + randomUUID();
  try {
    const response = await fetcher(base.url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Base download failed: HTTP ${response.status}`);
    if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('Base redirected away from HTTPS');
    const hash = createHash('sha256');
    let size = 0;
    const inspect = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      if (size > maxBytes) return done(new Error('Base download exceeds size limit'));
      hash.update(chunk); done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), inspect, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (hash.digest('hex') !== base.sha256) throw new Error('Downloaded base checksum mismatch');
    // Publish without overwriting another process's completed download.
    try { await link(temporary, destination); }
    catch (error) {
      if (error.code !== 'EEXIST' || !await verifyExisting(destination, base.sha256)) throw error;
    }
    return destination;
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
