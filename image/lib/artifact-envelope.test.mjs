// SPDX-License-Identifier: GPL-3.0-or-later
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsset, sealAsset } from './artifact-envelope.mjs';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'yonder-transfer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('large and empty files round-trip privately with a fresh envelope each time', async t => {
  const dir = await fixture(t);
  for (const bytes of [Buffer.alloc(0), randomBytes(2 * 1024 * 1024 + 27)]) {
    const suffix = String(bytes.length);
    const original = join(dir, `input-${suffix}`);
    const sealed = join(dir, `sealed-${suffix}`);
    const second = join(dir, `second-${suffix}`);
    const opened = join(dir, `opened-${suffix}`);
    await writeFile(original, bytes);
    await sealAsset(original, sealed, keys.publicKey);
    await sealAsset(original, second, keys.publicKey);
    assert.notDeepEqual(await readFile(sealed), await readFile(second));
    await openAsset(sealed, opened, keys.privateKey);
    assert.deepEqual(await readFile(opened), bytes);
    assert.equal((await stat(opened)).mode & 0o777, 0o600);
  }
});
test('tampered header, ciphertext, tag and truncated transfers expose no completed plaintext', async t => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'input'), Buffer.alloc(10000, 77));
  await sealAsset(join(dir, 'input'), join(dir, 'sealed'), keys.publicKey);
  const original = await readFile(join(dir, 'sealed'));
  for (const index of [0, 30, 500, original.length - 1, -1]) {
    const damaged = Buffer.from(original);
    if (index >= 0) damaged[index] ^= 1;
    await writeFile(join(dir, 'bad'), index < 0 ? damaged.subarray(0, 30) : damaged);
    await assert.rejects(openAsset(join(dir, 'bad'), join(dir, 'out'), keys.privateKey));
    assert.equal((await readdir(dir)).some(name => name === 'out' || name.includes('.partial')), false);
  }
});
test('wrong recipient key, symlinks and existing outputs are refused', async t => {
  const dir = await fixture(t);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(join(dir, 'input'), 'private image contents');
  await sealAsset(join(dir, 'input'), join(dir, 'sealed'), keys.publicKey);
  await assert.rejects(openAsset(join(dir, 'sealed'), join(dir, 'out'), other.privateKey));
  await symlink(join(dir, 'input'), join(dir, 'link'));
  await assert.rejects(sealAsset(join(dir, 'link'), join(dir, 'out'), keys.publicKey));
  await assert.rejects(sealAsset(join(dir, 'input'), join(dir, 'sealed'), keys.publicKey));
  await assert.rejects(openAsset(join(dir, 'sealed'), join(dir, 'input'), keys.privateKey));
  assert.equal(await readFile(join(dir, 'input'), 'utf8'), 'private image contents');
});
