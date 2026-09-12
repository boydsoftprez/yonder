// SPDX-License-Identifier: GPL-3.0-or-later
// R-HW-04/R-SEC-07/R-CFG-15: draft image releases preserve identity and omit credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  GhApiClient,
  MAX_ASSET_BYTES,
  orchestrateDraft,
  parseArgs,
  validateDraftInput,
} from './draft.mjs';
import { generateInputBundles } from './input-bundles.mjs';
import { makeAcceptedInputSet } from './test-fixture.mjs';

const VERSION = '2026.9.0';
const SOURCE = '0123456789abcdef0123456789abcdef01234567';
const TARGETS = ['rpi', 'radxa-zero3w', 'radxa-rock5c'];

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function put(root, relativePath, value) {
  const path = join(root, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, value);
  return { path: relativePath, sha256: digest(value) };
}

async function makeTarget(root, target, retained) {
  const stem = `yonder-${VERSION}-${target}-arm64`;
  const imageBytes = Buffer.from(`compressed image for ${target}`);
  const image = await put(root, `${stem}.img.xz`, imageBytes);
  const checksum = await put(
    root,
    `${stem}.sha256`,
    `${image.sha256}  ${basename(image.path)}\n`,
  );
  const sourceSnapshotSha256 = digest(`source:${target}`);
  const c = retained.components;
  const inputSetId = digest(`${c.base.sha256}\n${c.apt.sha256SumsSha256}\n${c.payload.manifestSha256}\n${c.builder.manifestSha256}\n${sourceSnapshotSha256}\n`);
  const buildManifestValue = `${JSON.stringify({
    schemaVersion: 1,
    kind: 'release-image',
    target,
    version: VERSION,
    sourceRevision: SOURCE,
    sourceHasUncommittedChanges: false,
    protectedStorage: true,
    temporaryBenchSsh: false,
    base: { sha256: c.base.sha256 },
    inputSetId,
    inputs: { aptSha256Sums: c.apt.sha256SumsSha256,
      payloadManifestSha256: c.payload.manifestSha256,
      builderManifestSha256: c.builder.manifestSha256, sourceSnapshotSha256 },
    builderImageId: c.builder.imageId,
    buildTools: c.payload.buildTools,
    image: { fileName: basename(image.path), sha256: image.sha256 },
  }, null, 2)}\n`;
  const buildManifest = await put(root, `${stem}.build.json`, buildManifestValue);
  const packages = await put(root, `${stem}.packages.tsv`, 'package\tversion\nfoo\t1.0\n');
  const verificationValue = `${JSON.stringify({
    schemaVersion: 1,
    kind: 'yonder-image-verification',
    target,
    version: VERSION,
    sourceRevision: SOURCE,
    imageSha256: image.sha256,
    checks: {
      credentialMaterialAbsent: true,
      temporaryBenchAccessAbsent: true,
      protectedStorage: true,
    },
  }, null, 2)}\n`;
  const verification = await put(root, `${stem}.verification.json`, verificationValue);

  return {
    status: 'success',
    buildManifest: buildManifest.path,
    assets: [
      { role: 'image', ...image },
      { role: 'checksum', ...checksum },
      { role: 'build-manifest', ...buildManifest },
      { role: 'packages', ...packages },
      { role: 'verification', ...verification },
    ],
  };
}

async function makeFixture({ status = 'complete', failedTarget, candidateId = 'test-run' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'yonder-release-test-'));
  const inputSets = join(root, 'input-sets');
  await mkdir(inputSets);
  for (const target of TARGETS) await makeAcceptedInputSet(inputSets, target, SOURCE);
  const generatedIndex = await generateInputBundles({ inputRoot: inputSets, output: join(root, 'inputs'),
    version: VERSION, sourceCommit: SOURCE,
    targets: TARGETS.filter(target => target !== failedTarget) });
  await rm(inputSets, { recursive: true, force: true });
  const targets = {};
  for (const target of TARGETS) {
    targets[target] = target === failedTarget
      ? { status: 'failed', reason: 'builder failed' }
      : await makeTarget(root, target, generatedIndex.targets.find(entry => entry.target === target));
  }
  const indexBytes = await readFile(join(root, 'inputs/input-index.json'));
  const inputIndex = { path: 'inputs/input-index.json', sha256: digest(indexBytes) };
  const bundles = generatedIndex.targets.flatMap(entry => entry.archive.parts).map(part => ({
    path: `inputs/${part.fileName}`, sha256: part.sha256,
  }));

  const manifest = {
    schemaVersion: 1,
    kind: 'yonder-image-release-set',
    version: VERSION,
    sourceCommit: SOURCE,
    status,
    ...(candidateId ? { candidateId } : {}),
    targets,
    retainedInputs: [
      { role: 'input-index', ...inputIndex },
      ...bundles.map((bundle) => ({ role: 'input-bundle', ...bundle })),
    ],
  };
  const manifestPath = join(root, 'release-set.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifest, manifestPath };
}

class FakeGithub {
  constructor(release = null) {
    this.release = release;
    this.assets = new Map();
    this.calls = [];
    this.corruptDownloads = false;
    this.publishOnReleaseRead = null;
    this.releaseReads = 0;
  }

  async getReleaseByTag({ tag }) {
    this.calls.push(['getReleaseByTag', tag]);
    this.releaseReads += 1;
    if (this.releaseReads === this.publishOnReleaseRead && this.release) this.release.draft = false;
    return this.release?.tag_name === tag ? this.release : null;
  }

  async resolveCommit({ ref }) {
    this.calls.push(['resolveCommit', ref]);
    if (ref === 'wrong-branch') return 'f'.repeat(40);
    return ref === 'main' ? SOURCE : ref;
  }

  async createDraft(args) {
    this.calls.push(['createDraft', args]);
    this.release = {
      id: 7,
      draft: args.draft,
      tag_name: args.tag,
      target_commitish: args.targetCommitish,
      body: args.body,
      name: args.name,
    };
    return this.release;
  }

  async listAssets() {
    this.calls.push(['listAssets']);
    return [...this.assets.values()].map(({ bytes: _bytes, ...asset }) => asset);
  }

  async uploadAsset({ path, name }) {
    this.calls.push(['uploadAsset', name]);
    const asset = {
      id: this.assets.size + 1,
      name,
      bytes: await readFile(path),
    };
    this.assets.set(name, asset);
    return { id: asset.id, name: asset.name };
  }

  async downloadAsset({ asset, destination }) {
    this.calls.push(['downloadAsset', asset.name]);
    const stored = this.assets.get(asset.name);
    await writeFile(destination, this.corruptDownloads ? 'corrupt' : stored.bytes);
  }

  async updateDraft(args) {
    this.calls.push(['updateDraft', args]);
    this.release = { ...this.release, ...args, draft: args.draft };
    return this.release;
  }
}

test('parseArgs keeps validation as the default and accepts repeated targets', () => {
  assert.deepEqual(parseArgs([
    '--manifest', '/tmp/release-set.json',
    '--repo', 'owner/repo',
    '--target', 'rpi',
    '--target', 'radxa-rock5c',
  ]), {
    manifestPath: '/tmp/release-set.json',
    repo: 'owner/repo',
    selectedTargets: ['rpi', 'radxa-rock5c'],
    apply: false,
  });
});

test('GhApiClient exposes injectable gh API transport for release and binary calls', async () => {
  const jsonCalls = [];
  const runCalls = [];
  const transport = {
    json: async (args, options) => {
      jsonCalls.push([args, options]);
      if (args.includes('--slurp')) return [[{ id: 3, name: 'asset' }]];
      return { id: 4, name: 'image.img.xz', sha: SOURCE };
    },
    run: async (args, options) => {
      runCalls.push([args, options]);
      return Buffer.alloc(0);
    },
  };
  const client = new GhApiClient(transport);

  assert.deepEqual(await client.listAssets({ repo: 'owner/repo', releaseId: 4 }), [{ id: 3, name: 'asset' }]);
  await client.uploadAsset({
    repo: 'owner/repo',
    releaseId: 4,
    path: '/tmp/image.img.xz',
    name: 'image.img.xz',
    contentType: 'application/octet-stream',
  });
  await client.downloadAsset({
    repo: 'owner/repo',
    asset: { id: 3 },
    destination: '/tmp/download',
  });

  assert.ok(jsonCalls[1][0].includes('uploads.github.com'));
  assert.equal(jsonCalls[1][0].at(-1), 'repos/owner/repo/releases/4/assets?name=image.img.xz');
  assert.equal(runCalls[0][1].outputPath, '/tmp/download');
});

test('validates a complete release set and derives the release tag', async () => {
  const { manifestPath } = await makeFixture({ candidateId: null });
  const plan = await validateDraftInput(manifestPath, ['all']);

  assert.equal(plan.state, 'complete');
  assert.equal(plan.tag, `v${VERSION}`);
  assert.deepEqual(plan.selectedTargets, TARGETS);
  assert.equal(plan.assets.filter((asset) => asset.role === 'image').length, 3);
});

test('manual all-target build keeps a candidate tag when it has a candidate identity', async () => {
  const { manifestPath } = await makeFixture({ candidateId: 'github-4812-1' });
  const plan = await validateDraftInput(manifestPath, ['all']);

  assert.equal(plan.state, 'candidate');
  assert.equal(plan.tag,
    `v${VERSION}-candidate-${TARGETS.join('.')}-${SOURCE.slice(0, 12)}-github-4812-1`);
});

test('dry-run orchestration never calls the injected GitHub dependency', async () => {
  const { manifestPath } = await makeFixture();
  const github = new FakeGithub();
  const result = await orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    github,
  });

  assert.equal(result.applied, false);
  assert.deepEqual(github.calls, []);
});

test('partial selection uses a candidate-specific tag and cannot claim complete', async () => {
  const { manifestPath } = await makeFixture({
    status: 'partial',
    failedTarget: 'radxa-rock5c',
    candidateId: 'run-4812',
  });
  const plan = await validateDraftInput(manifestPath, ['rpi']);

  assert.equal(plan.state, 'partial');
  assert.equal(plan.tag, `v${VERSION}-candidate-rpi-${SOURCE.slice(0, 12)}-run-4812`);
  assert.deepEqual(plan.selectedTargets, ['rpi']);
});

test('partial selection rejects an unsafe candidate identity', async () => {
  const { manifestPath } = await makeFixture({ candidateId: 'bad/identity' });
  await assert.rejects(validateDraftInput(manifestPath, ['rpi']), /safe candidateId/);
});

test('a manual partial manifest may omit targets that were not selected', async () => {
  const { root, manifest, manifestPath } = await makeFixture({ candidateId: 'manual-22' });
  manifest.status = 'partial';
  delete manifest.targets['radxa-zero3w'];
  delete manifest.targets['radxa-rock5c'];
  manifest.retainedInputs = manifest.retainedInputs.filter(({ path }) => (
    !path.includes('radxa-zero3w.inputs.tar.zst.part') && !path.includes('radxa-rock5c.inputs.tar.zst.part')
  ));
  const indexAsset = manifest.retainedInputs.find(({ role }) => role === 'input-index');
  const index = JSON.parse(await readFile(join(root, indexAsset.path), 'utf8'));
  index.targets = index.targets.filter(({ target }) => target === 'rpi');
  const indexBytes = `${JSON.stringify(index)}\n`;
  await writeFile(join(root, indexAsset.path), indexBytes);
  indexAsset.sha256 = digest(indexBytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  const plan = await validateDraftInput(manifestPath, ['rpi']);
  assert.equal(plan.state, 'partial');
  assert.deepEqual(plan.selectedTargets, ['rpi']);
});

test('all selection refuses a failed target', async () => {
  const { manifestPath } = await makeFixture({
    status: 'partial',
    failedTarget: 'radxa-zero3w',
    candidateId: 'failed-run',
  });

  await assert.rejects(
    validateDraftInput(manifestPath, ['all']),
    /all requires a complete manifest with all three successful targets/,
  );
});

test('rejects private bench and storage prototype build manifests', async () => {
  const { root, manifest, manifestPath } = await makeFixture();
  const buildPath = join(root, manifest.targets['radxa-zero3w'].buildManifest);
  const privateManifest = {
    schemaVersion: 1,
    kind: 'private-hardware-test',
    target: 'radxa-zero3w',
    version: VERSION,
    sourceRevision: SOURCE,
    sourceHasUncommittedChanges: true,
    protectedStorage: false,
    storagePrototype: true,
    temporaryBenchSsh: true,
    image: { fileName: 'bench.img.xz', sha256: '0'.repeat(64) },
  };
  await writeFile(buildPath, `${JSON.stringify(privateManifest)}\n`);
  manifest.targets['radxa-zero3w'].assets.find(({ role }) => role === 'build-manifest').sha256 =
    digest(`${JSON.stringify(privateManifest)}\n`);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(validateDraftInput(manifestPath, ['all']), /release-image/);
});

test('rejects forbidden private-access files anywhere in the staging directory', async () => {
  const { root, manifestPath } = await makeFixture();
  await writeFile(join(root, 'PRIVATE-ACCESS.txt'), 'credentials');

  await assert.rejects(validateDraftInput(manifestPath, ['all']), /forbidden private material/);
});

test('rejects symlinks and paths escaping the staging directory', async (t) => {
  await t.test('symlink', async () => {
    const { root, manifestPath } = await makeFixture();
    await symlink('release-set.json', join(root, 'alias.json'));
    await assert.rejects(validateDraftInput(manifestPath, ['all']), /symlink/);
  });

  await t.test('escaping path', async () => {
    const { manifest, manifestPath } = await makeFixture();
    manifest.retainedInputs[0].path = '../outside.json';
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(validateDraftInput(manifestPath, ['all']), /safe relative path/);
  });
});

test('rejects an asset at the GitHub two-GiB limit before hashing it', async () => {
  const { root, manifest, manifestPath } = await makeFixture();
  const image = manifest.targets.rpi.assets.find(({ role }) => role === 'image');
  await truncate(join(root, image.path), MAX_ASSET_BYTES);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(validateDraftInput(manifestPath, ['rpi']), /strictly smaller than 2 GiB/);
});

test('verifies retained input index hashes and selected-target coverage', async (t) => {
  await t.test('bundle digest', async () => {
    const { root, manifest, manifestPath } = await makeFixture();
    const index = manifest.retainedInputs.find(({ role }) => role === 'input-index');
    const value = JSON.parse(await readFile(join(root, index.path), 'utf8'));
    value.targets[0].archive.parts[0].sha256 = 'f'.repeat(64);
    const bytes = `${JSON.stringify(value)}\n`;
    await writeFile(join(root, index.path), bytes);
    index.sha256 = digest(bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(validateDraftInput(manifestPath, ['rpi']), /input index bundle hash/);
  });

  await t.test('target coverage', async () => {
    const { root, manifest, manifestPath } = await makeFixture();
    const index = manifest.retainedInputs.find(({ role }) => role === 'input-index');
    const value = JSON.parse(await readFile(join(root, index.path), 'utf8'));
    value.targets = value.targets.filter(({ target }) => target !== 'rpi');
    const bytes = `${JSON.stringify(value)}\n`;
    await writeFile(join(root, index.path), bytes);
    index.sha256 = digest(bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(validateDraftInput(manifestPath, ['rpi']), /does not cover selected target rpi/);
  });

  await t.test('cross-target builder identity', async () => {
    const { root, manifest, manifestPath } = await makeFixture();
    const index = manifest.retainedInputs.find(({ role }) => role === 'input-index');
    const value = JSON.parse(await readFile(join(root, index.path), 'utf8'));
    const pi = value.targets.find(({ target }) => target === 'rpi');
    const rock = value.targets.find(({ target }) => target === 'radxa-rock5c');
    pi.components.builder = rock.components.builder;
    const bytes = `${JSON.stringify(value)}\n`;
    await writeFile(join(root, index.path), bytes);
    index.sha256 = digest(bytes);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(validateDraftInput(manifestPath, ['rpi']), /does not match its retained input archive/);
  });
});

test('requires verification to assert credential and bench-access absence with exact booleans', async () => {
  const { root, manifest, manifestPath } = await makeFixture();
  const asset = manifest.targets.rpi.assets.find(({ role }) => role === 'verification');
  const verification = JSON.parse(await readFile(join(root, asset.path), 'utf8'));
  verification.checks.credentialMaterialAbsent = 'true';
  const bytes = `${JSON.stringify(verification)}\n`;
  await writeFile(join(root, asset.path), bytes);
  asset.sha256 = digest(bytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(validateDraftInput(manifestPath, ['rpi']), /must establish credentialMaterialAbsent/);
});

test('creates only a draft, verifies downloaded assets, then marks its body complete', async () => {
  const { manifestPath } = await makeFixture({ candidateId: null });
  const github = new FakeGithub();
  const result = await orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    apply: true,
    github,
  });

  assert.equal(result.state, 'complete');
  assert.equal(github.release.draft, true);
  assert.match(github.release.body, /State: complete/);
  const create = github.calls.find(([name]) => name === 'createDraft')[1];
  const update = github.calls.find(([name]) => name === 'updateDraft')[1];
  assert.equal(create.draft, true);
  assert.match(create.name, /assembling/);
  assert.equal(update.draft, true);
  assert.match(update.name, /complete/);
  assert.ok(github.calls.some(([name]) => name === 'downloadAsset'));
  assert.equal(
    [...github.assets.keys()].filter((name) => name.endsWith('.release.json')).length,
    1,
  );
});

test('refuses mutation of a published release', async () => {
  const { manifestPath } = await makeFixture({ candidateId: null });
  const github = new FakeGithub({
    id: 9,
    tag_name: `v${VERSION}`,
    target_commitish: SOURCE,
    draft: false,
  });

  await assert.rejects(orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    apply: true,
    github,
  }), /published release/);
  assert.equal(github.calls.some(([name]) => name === 'uploadAsset'), false);
});

test('resolves and rejects an existing release target commit mismatch', async () => {
  const { manifestPath } = await makeFixture({ candidateId: null });
  const github = new FakeGithub({
    id: 9,
    tag_name: `v${VERSION}`,
    target_commitish: 'wrong-branch',
    draft: true,
  });

  await assert.rejects(orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    apply: true,
    github,
  }), /resolves to .* expected/);
});

test('refuses to mix an existing draft asset set with unmanifested assets', async () => {
  const { manifestPath } = await makeFixture();
  const github = new FakeGithub({
    id: 9,
    tag_name: `v${VERSION}`,
    target_commitish: SOURCE,
    draft: true,
  });
  github.assets.set('old-candidate.img.xz', {
    id: 1,
    name: 'old-candidate.img.xz',
    bytes: Buffer.from('old'),
  });

  await assert.rejects(orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    apply: true,
    github,
  }), /unmanifested asset old-candidate.img.xz/);
  assert.equal(github.calls.some(([name]) => name === 'uploadAsset'), false);
});

test('retry reuses byte-identical assets and refuses immutable-name mismatch', async (t) => {
  await t.test('reuse', async () => {
    const { manifestPath } = await makeFixture();
    const github = new FakeGithub();
    await orchestrateDraft({ manifestPath, repo: 'owner/repo', selectedTargets: ['all'], apply: true, github });
    github.calls = [];
    await orchestrateDraft({ manifestPath, repo: 'owner/repo', selectedTargets: ['all'], apply: true, github });
    assert.equal(github.calls.some(([name]) => name === 'uploadAsset'), false);
    assert.ok(github.calls.some(([name]) => name === 'downloadAsset'));
  });

  await t.test('mismatch', async () => {
    const { manifestPath } = await makeFixture();
    const github = new FakeGithub();
    await orchestrateDraft({ manifestPath, repo: 'owner/repo', selectedTargets: ['all'], apply: true, github });
    const first = github.assets.values().next().value;
    first.bytes = Buffer.from('changed remotely');
    github.calls = [];
    await assert.rejects(
      orchestrateDraft({ manifestPath, repo: 'owner/repo', selectedTargets: ['all'], apply: true, github }),
      /immutable asset .* has a different SHA-256/,
    );
    assert.equal(github.calls.some(([name]) => name === 'uploadAsset'), false);
  });
});

test('download corruption leaves a new draft in assembling state', async () => {
  const { manifestPath } = await makeFixture();
  const github = new FakeGithub();
  github.corruptDownloads = true;

  await assert.rejects(orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    apply: true,
    github,
  }), /downloaded asset .* SHA-256 mismatch/);
  assert.match(github.release.body, /State: assembling/);
  assert.match(github.release.name, /assembling/);
  assert.equal(github.calls.some(([name]) => name === 'updateDraft'), false);
});

test('restores both assembling title and body before repairing a missing asset', async () => {
  const { manifestPath } = await makeFixture();
  const github = new FakeGithub();
  github.corruptDownloads = true;
  await assert.rejects(orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    apply: true,
    github,
  }));
  github.assets.clear();
  github.release.name = `Yonder ${VERSION} complete image candidate`;
  github.calls = [];

  await assert.rejects(orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    apply: true,
    github,
  }), /downloaded asset .* SHA-256 mismatch/);
  assert.match(github.release.name, /assembling/);
  assert.ok(github.calls.some(([name]) => name === 'updateDraft'));
});

test('stops uploading when an operator publishes the release between assets', async () => {
  const { manifestPath } = await makeFixture();
  const github = new FakeGithub();
  github.publishOnReleaseRead = 3;

  await assert.rejects(orchestrateDraft({
    manifestPath,
    repo: 'owner/repo',
    selectedTargets: ['all'],
    apply: true,
    github,
  }), /is no longer a draft/);
  assert.equal(github.calls.filter(([name]) => name === 'uploadAsset').length, 1);
  assert.equal(github.calls.some(([name]) => name === 'updateDraft'), false);
  assert.equal(github.release.draft, false);
});

test('manifest permissions do not affect validation', async () => {
  const { manifestPath } = await makeFixture();
  await chmod(manifestPath, 0o400);
  const plan = await validateDraftInput(manifestPath, ['rpi']);
  assert.equal(plan.state, 'partial');
});
