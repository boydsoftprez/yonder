// SPDX-License-Identifier: GPL-3.0-or-later
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { transferDirectory, validateTransferIndex } from './transfer-directory.mjs';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
test('flat handoff round-trips and a corrupted later asset leaves no staged release directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'yonder-directory-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const source = join(dir, 'source');
  await mkdir(source);
  await writeFile(join(source, 'a.img.xz'), 'compressed image fixture');
  await writeFile(join(source, 'b.build.json'), '{"fixture":true}');
  const sealed = join(dir, 'sealed');
  await transferDirectory('seal', source, sealed, keys.publicKey);
  const plain = join(dir, 'plain');
  await transferDirectory('open', sealed, plain, keys.privateKey);
  assert.deepEqual(await readdir(plain), ['a.img.xz', 'b.build.json']);
  assert.equal(await readFile(join(plain, 'a.img.xz'), 'utf8'), 'compressed image fixture');
  await writeFile(join(sealed, 'asset-001.sealed'), 'broken');
  await assert.rejects(transferDirectory('open', sealed, join(dir, 'failed'), keys.privateKey));
  assert.equal((await readdir(dir)).includes('failed'), false);
});
test('untrusted transfer index cannot escape staging, duplicate files or allocate oversized output', () => {
  const entry = { name: 'a.img.xz', blob: 'asset-000.sealed', bytes: 10, sha256: 'a'.repeat(64) };
  const index = files => ({ format: 'yonder-private-transfer', version: 1, files });
  for (const changed of [{ name: '../outside' }, { name: '/absolute' }, { blob: '../outside' },
    { name: 'transfer-index.json' }, { bytes: 2 ** 31 }, { bytes: -1 }, { sha256: 'wrong' }]) {
    assert.throws(() => validateTransferIndex(index([{ ...entry, ...changed }])));
  }
  assert.throws(() => validateTransferIndex(index([entry, entry])));
  assert.throws(() => validateTransferIndex(index([])));
});
