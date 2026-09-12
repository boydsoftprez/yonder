// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs, productionSourceEntries, validateBuilderInput,
  stageCapturedApplication, validatePayloadAptBinding } from './build.mjs';

test('production builder requires one target and explicit frozen inputs', () => {
  assert.deepEqual(parseArgs(['--target', 'radxa-zero3w', '--base', '/base', '--apt-input', '/apt',
    '--payload-input', '/payload', '--builder-input', '/builder', '--output', '/out']), {
    target: 'radxa-zero3w', base: '/base', aptInput: '/apt', payloadInput: '/payload',
    builderInput: '/builder', output: '/out',
  });
  for (const args of [
    ['--target', 'radxa-zero3w', '--output', '/out'],
    ['--target', 'other', '--base', '/base', '--apt-input', '/apt', '--payload-input', '/payload', '--builder-input', '/builder', '--output', '/out'],
    ['--target', 'rpi', '--base', '/base', '--apt-input', '/apt', '--payload-input', '/payload', '--builder-input', '/builder', '--output', '/out', '--output', '/other'],
  ]) assert.throws(() => parseArgs(args), /Usage:/);
});

test('production snapshot contains the finalizer, offline adapter and target storage backend', () => {
  for (const target of ['rpi', 'radxa-zero3w', 'radxa-rock5c']) {
    const entries = productionSourceEntries(target);
    for (const required of ['image/finalize.sh', 'image/verify-finalized.sh',
      'image/bases.lock.json', 'image/build.mjs', 'image/inspection',
      'image/lib/input-set.mjs', 'image/inputs/install-captured-apt.sh',
      'image/inputs/payload-inventory.py', 'image/package-sets.sh', 'image/storage']) {
      assert.ok(entries.includes(required), `${target} missing ${required}`);
    }
    assert.ok(entries.includes(target === 'rpi' ? 'image/pi' : 'image/prototype'));
    assert.equal(entries.some(entry => entry.startsWith('vendor/')), false,
      `${target} must receive vendor bytes from the retained payload input`);
    assert.equal(entries.some(entry => entry === 'packages' || entry.startsWith('packages/')), false,
      `${target} must receive first-party packages from the captured application bundle`);
  }
});

test('captured first-party packages must match the exact image source revision', multifn);

async function multifn() {
  const root = await mkdtemp(join(tmpdir(), 'yonder-application-binding-test-'));
  try {
    const vendor = join(root, 'vendor');
    const application = join(vendor, 'application');
    await mkdir(join(application, 'packages', 'yonder-core', 'dist'), { recursive: true });
    const sourceRevision = 'a'.repeat(40);
    await writeFile(join(application, 'application-bundle.json'), JSON.stringify({
      schemaVersion: 1, kind: 'yonder-first-party-application', sourceKind: 'git-archive',
      sourceCommit: sourceRevision, platform: 'linux/arm64',
    }));
    await writeFile(join(application, 'packages', 'yonder-core', 'dist', 'server.js'), 'built');
    const packages = stageCapturedApplication(vendor, root, sourceRevision);
    assert.equal(await readFile(join(packages, 'yonder-core', 'dist', 'server.js'), 'utf8'), 'built');
    await assert.rejects(stat(application), error => error.code === 'ENOENT');

    const other = join(root, 'other');
    await mkdir(join(other, 'application', 'packages'), { recursive: true });
    await writeFile(join(other, 'application', 'application-bundle.json'), JSON.stringify({
      schemaVersion: 1, kind: 'yonder-first-party-application', sourceKind: 'git-archive',
      sourceCommit: 'b'.repeat(40), platform: 'linux/arm64',
    }));
    assert.throws(() => stageCapturedApplication(other, join(root, 'second'), sourceRevision),
      /source revision/);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('frozen builder manifest binds every retained regular file and rejects extras', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yonder-builder-input-test-'));
  try {
    await writeFile(join(root, 'builder.docker.tar'), 'frozen-image');
    await writeFile(join(root, 'oci-inspect.json'), '{}');
    const crypto = await import('node:crypto');
    const record = (path, data) => ({ path, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: Buffer.byteLength(data) });
    const manifest = { schemaVersion: 1, kind: 'yonder-builder-input', platform: 'linux/arm64',
      baseRuntime: 'debian@sha256:' + 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64),
      files: [record('builder.docker.tar', 'frozen-image'), record('oci-inspect.json', '{}')] };
    await writeFile(join(root, 'builder-input.json'), JSON.stringify(manifest));
    assert.equal((await validateBuilderInput(root)).imageId, manifest.imageId);
    await mkdir(join(root, 'unexpected'));
    await writeFile(join(root, 'unexpected', 'file'), 'not indexed');
    await assert.rejects(validateBuilderInput(root), /inventory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('APT and application payload bind the identical ZeroTier package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yonder-input-binding-test-'));
  try {
    const apt = join(root, 'apt');
    const payload = join(root, 'vendor');
    await mkdir(join(payload, 'zerotier'), { recursive: true });
    await mkdir(apt);
    const bytes = 'zerotier package';
    await writeFile(join(payload, 'zerotier', 'zerotier-one_1_arm64.deb'), bytes);
    const crypto = await import('node:crypto');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(apt, 'packages.tsv'),
      `repo/zerotier.deb\tzerotier-one\t1\tarm64\tzerotier-one\t1\t${digest}\t${bytes.length}\n`);
    await validatePayloadAptBinding(apt, payload);
    await writeFile(join(payload, 'zerotier', 'zerotier-one_1_arm64.deb'), 'different');
    await assert.rejects(validatePayloadAptBinding(apt, payload), /ZeroTier/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
