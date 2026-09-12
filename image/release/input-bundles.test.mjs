// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateInputBundles, verifyIndexedArchive } from './input-bundles.mjs';
import { makeAcceptedInputSet } from './test-fixture.mjs';

const TARGET = 'rpi';
const VERSION = '2026.9.0';
const SOURCE = 'a'.repeat(40);

test('generator creates deterministic, split, verifiable archives bound to component identities', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yonder-input-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeAcceptedInputSet(root, TARGET, SOURCE);
  const one = join(root, 'one');
  const two = join(root, 'two');
  const first = await generateInputBundles({ inputRoot: root, output: one, version: VERSION,
    sourceCommit: SOURCE, targets: [TARGET], maximumPartBytes: 192 });
  const second = await generateInputBundles({ inputRoot: root, output: two, version: VERSION,
    sourceCommit: SOURCE, targets: [TARGET], maximumPartBytes: 192 });
  assert.ok(first.targets[0].archive.parts.length > 1);
  assert.deepEqual(first, second);
  assert.ok(first.targets[0].archive.parts.every(part => part.bytes < 193));
  assert.equal(first.rebuildability.status, 'incomplete');
  assert.match(first.targets[0].components.builder.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.targets[0].components.payload.sourceCommit, SOURCE);
  await verifyIndexedArchive(one, first.targets[0]);
});

test('archive verification rejects altered parts and generator rejects unsafe input trees', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yonder-input-bundle-negative-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { input } = await makeAcceptedInputSet(root, TARGET, SOURCE);
  const output = join(root, 'release');
  const index = await generateInputBundles({ inputRoot: root, output, version: VERSION,
    sourceCommit: SOURCE, targets: [TARGET], maximumPartBytes: 512 });
  await writeFile(join(output, index.targets[0].archive.parts[0].fileName), 'tampered');
  await assert.rejects(verifyIndexedArchive(output, index.targets[0]), /part hash/);

  const identityOutput = join(root, 'identity-release');
  const identityIndex = await generateInputBundles({ inputRoot: root, output: identityOutput,
    version: VERSION, sourceCommit: SOURCE, targets: [TARGET] });
  identityIndex.targets[0].components.base.sha256 = 'f'.repeat(64);
  await assert.rejects(verifyIndexedArchive(identityOutput, identityIndex.targets[0]),
    /archived component identity/);

  const unsafeRoot = join(root, 'unsafe-root');
  await mkdir(unsafeRoot);
  const { input: unsafeInput } = await makeAcceptedInputSet(unsafeRoot, TARGET, SOURCE);
  await writeFile(join(unsafeInput, 'payload/private_key'), 'forbidden');
  await assert.rejects(generateInputBundles({ inputRoot: unsafeRoot, output: join(root, 'unsafe-output'),
    version: VERSION, sourceCommit: SOURCE, targets: [TARGET] }), /private input name/);
});

test('generator preserves safe relative symlinks and rejects escaping symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yonder-input-bundle-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeAcceptedInputSet(root, TARGET, SOURCE, { linkTarget: 'file.bin' });
  const output = join(root, 'release');
  const index = await generateInputBundles({ inputRoot: root, output, version: VERSION,
    sourceCommit: SOURCE, targets: [TARGET] });
  const entries = await verifyIndexedArchive(output, index.targets[0]);
  assert.deepEqual(entries.find(entry => entry.path.endsWith('/file-link')),
    { path: 'rpi/payload/files/file-link', type: 'symlink', mode: 0o755, linkTarget: 'file.bin' });

  const badRoot = join(root, 'bad-root');
  await mkdir(badRoot);
  await makeAcceptedInputSet(badRoot, TARGET, SOURCE, { linkTarget: '../../../../outside' });
  await assert.rejects(generateInputBundles({ inputRoot: badRoot, output: join(root, 'bad-release'),
    version: VERSION, sourceCommit: SOURCE, targets: [TARGET] }), /escaping symlink/);
});

test('deterministic archive round-trips paths that require PAX metadata', async t => {
  const root = await mkdtemp(join(tmpdir(), 'yonder-input-bundle-pax-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await makeAcceptedInputSet(root, TARGET, SOURCE, { longPath: true });
  const output = join(root, 'release');
  const index = await generateInputBundles({ inputRoot: root, output, version: VERSION,
    sourceCommit: SOURCE, targets: [TARGET] });
  const entries = await verifyIndexedArchive(output, index.targets[0]);
  assert.ok(entries.some(entry => entry.path.endsWith('/long-file') && entry.path.length > 255));
});
