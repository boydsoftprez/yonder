// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveInputSet, writeInputSetManifest } from './input-set.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'yonder-input-set-'));
  await mkdir(join(root, 'apt'));
  await mkdir(join(root, 'payload'));
  await mkdir(join(root, 'builder'));
  const files = {
    'base.img.xz': 'base',
    'apt/capture.json': '{"kind":"apt"}\n',
    'payload/payload-input.json': '{"kind":"payload"}\n',
    'builder/builder-input.json': '{"kind":"builder"}\n',
  };
  for (const [path, value] of Object.entries(files)) await writeFile(join(root, path), value);
  const manifest = {
    schemaVersion: 1,
    kind: 'yonder-image-input-set',
    target: 'radxa-zero3w',
    base: { path: 'base.img.xz', sha256: sha(files['base.img.xz']) },
    apt: { path: 'apt', manifest: 'capture.json', manifestSha256: sha(files['apt/capture.json']) },
    payload: { path: 'payload', manifest: 'payload-input.json', manifestSha256: sha(files['payload/payload-input.json']) },
    builder: { path: 'builder', manifest: 'builder-input.json', manifestSha256: sha(files['builder/builder-input.json']) },
  };
  await writeFile(join(root, 'input-set.json'), JSON.stringify(manifest));
  return { root, manifest };
}

test('input set resolves only target-bound, hashed, relative components', async () => {
  const { root } = await fixture();
  try {
    const result = await resolveInputSet(root, 'radxa-zero3w');
    assert.equal(result.base, join(root, 'base.img.xz'));
    assert.equal(result.aptInput, join(root, 'apt'));
    assert.equal(result.payloadInput, join(root, 'payload'));
    assert.equal(result.builderInput, join(root, 'builder'));
    await assert.rejects(resolveInputSet(root, 'rpi'), /target/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('input set refuses tampered manifests and symlink components', async () => {
  const first = await fixture();
  try {
    await writeFile(join(first.root, 'apt/capture.json'), 'tampered');
    await assert.rejects(resolveInputSet(first.root, 'radxa-zero3w'), /hash/);
  } finally { await rm(first.root, { recursive: true, force: true }); }

  const second = await fixture();
  try {
    await rm(join(second.root, 'payload'), { recursive: true });
    await symlink('/tmp', join(second.root, 'payload'));
    await assert.rejects(resolveInputSet(second.root, 'radxa-zero3w'), /directory/);
  } finally { await rm(second.root, { recursive: true, force: true }); }
});

test('capture writes a relocatable manifest only after all four inputs exist', async () => {
  const { root } = await fixture();
  try {
    await rm(join(root, 'input-set.json'));
    const manifest = await writeInputSetManifest(root, 'radxa-zero3w', sha('base'));
    assert.equal(manifest.payload.manifestSha256, sha('{"kind":"payload"}\n'));
    assert.equal((await resolveInputSet(root, 'radxa-zero3w')).manifest.kind,
      'yonder-image-input-set');
    await assert.rejects(writeInputSetManifest(root, 'radxa-zero3w', sha('base')), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
