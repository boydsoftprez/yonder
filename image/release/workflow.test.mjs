// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { assembleWorkflowRelease } from './assemble-workflow.mjs';
import { validateDraftInput } from './draft.mjs';
import { generateInputBundles } from './input-bundles.mjs';
import { makeAcceptedInputSet } from './test-fixture.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TARGETS = ['rpi', 'radxa-zero3w', 'radxa-rock5c'];
const VERSION = '2026.9.0';
const COMMIT = 'a'.repeat(40);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function put(path, bytes) {
  await writeFile(path, bytes);
  return { bytes: Buffer.byteLength(bytes), sha256: sha(bytes) };
}

async function targetOutput(root, target, retained) {
  const directory = join(root, target);
  await mkdir(directory);
  const stem = `yonder-${VERSION}-${target}-arm64`;
  const image = await put(join(directory, `${stem}.img.xz`), `image:${target}`);
  await put(join(directory, `${stem}.sha256`), `${image.sha256}  ${stem}.img.xz\n`);
  const sourceSnapshotSha256 = sha(`source:${target}`);
  const c = retained.components;
  const inputSetId = sha(`${c.base.sha256}\n${c.apt.sha256SumsSha256}\n${c.payload.manifestSha256}\n${c.builder.manifestSha256}\n${sourceSnapshotSha256}\n`);
  await put(join(directory, `${stem}.build.json`), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'release-image',
    version: VERSION,
    target,
    sourceRevision: COMMIT,
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
    image: { fileName: `${stem}.img.xz`, sha256: image.sha256 },
  })}\n`);
  await put(join(directory, `${stem}.packages.tsv`), 'fixture\t1\n');
  await put(join(directory, `${stem}.verification.json`), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'yonder-image-verification',
    version: VERSION,
    target,
    sourceRevision: COMMIT,
    imageSha256: image.sha256,
    checks: {
      credentialMaterialAbsent: true,
      temporaryBenchAccessAbsent: true,
      protectedStorage: true,
    },
  })}\n`);
}

async function fixture(selected = ['rpi'], event = 'workflow_dispatch') {
  const root = await mkdtemp(join(tmpdir(), 'yonder-workflow-release-'));
  const builds = join(root, 'builds');
  const inputs = join(root, 'inputs');
  const inputSets = join(root, 'input-sets');
  const sourcePath = join(root, 'source.json');
  await mkdir(builds);
  await mkdir(inputSets);
  for (const target of TARGETS) await makeAcceptedInputSet(inputSets, target);
  const index = await generateInputBundles({ inputRoot: inputSets, output: inputs,
    version: VERSION, sourceCommit: COMMIT, targets: TARGETS });
  for (const target of selected) {
    await targetOutput(builds, target, index.targets.find(entry => entry.target === target));
  }
  await put(sourcePath, `${JSON.stringify({
    schemaVersion: 1,
    version: VERSION,
    tag: `v${VERSION}`,
    sourceRevision: COMMIT,
    targets: selected,
    fullRelease: selected.length === TARGETS.length,
    trigger: {
      event,
      ref: event === 'push' ? `refs/tags/v${VERSION}` : 'refs/heads/main',
      signedTagVerified: event === 'push',
    },
  })}\n`);
  return { root, builds, inputs, sourcePath, output: join(root, 'staging') };
}

test('workflow assembler emits a draft-valid partial set and derives a selected retained-input index', async t => {
  const value = await fixture(['rpi']);
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const manifest = await assembleWorkflowRelease({
    sourcePath: value.sourcePath,
    inputRelease: value.inputs,
    buildRoot: value.builds,
    output: value.output,
    candidate: 'github-42-1',
  });
  assert.equal(manifest.status, 'partial');
  assert.equal(manifest.targets.rpi.status, 'success');
  assert.equal(manifest.targets['radxa-zero3w'].status, 'failed');
  const index = JSON.parse(await readFile(join(value.output, 'inputs/input-index.json'), 'utf8'));
  assert.deepEqual(index.targets.map(entry => entry.target), ['rpi']);
  assert.equal((await validateDraftInput(join(value.output, 'release-set.json'), ['rpi'])).state, 'partial');
});

test('workflow assembler emits a complete three-target set and fails closed on altered retained bytes', async t => {
  const value = await fixture(TARGETS, 'push');
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const manifest = await assembleWorkflowRelease({
    sourcePath: value.sourcePath,
    inputRelease: value.inputs,
    buildRoot: value.builds,
    output: value.output,
  });
  assert.equal(manifest.status, 'complete');
  assert.equal(Object.hasOwn(manifest, 'candidateId'), false);
  assert.equal((await validateDraftInput(join(value.output, 'release-set.json'), ['all'])).state, 'complete');

  const manual = await fixture(TARGETS);
  t.after(() => rm(manual.root, { recursive: true, force: true }));
  await assembleWorkflowRelease({
    sourcePath: manual.sourcePath,
    inputRelease: manual.inputs,
    buildRoot: manual.builds,
    output: manual.output,
    candidate: 'github-43-2',
  });
  const manualPlan = await validateDraftInput(join(manual.output, 'release-set.json'), ['all']);
  assert.equal(manualPlan.state, 'candidate');
  assert.match(manualPlan.tag, /-candidate-rpi\.radxa-zero3w\.radxa-rock5c-/);

  const changed = await fixture(['rpi']);
  t.after(() => rm(changed.root, { recursive: true, force: true }));
  const changedIndex = JSON.parse(await readFile(join(changed.inputs, 'input-index.json'), 'utf8'));
  await writeFile(join(changed.inputs, changedIndex.targets[0].archive.parts[0].fileName), 'altered');
  await assert.rejects(assembleWorkflowRelease({
    sourcePath: changed.sourcePath,
    inputRelease: changed.inputs,
    buildRoot: changed.builds,
    output: changed.output,
    candidate: 'github-44-1',
  }), /hash or size does not match/);
  assert.equal((await readdir(changed.root)).includes('staging'), false);
});

test('workflow assembler rejects extra decrypted build files before release validation', async t => {
  const value = await fixture(['rpi']);
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.builds, 'rpi', 'unexpected'), 'unexpected');
  await assert.rejects(assembleWorkflowRelease({
    sourcePath: value.sourcePath,
    inputRelease: value.inputs,
    buildRoot: value.builds,
    output: value.output,
    candidate: 'github-45-1',
  }), /exactly five/);
  assert.equal((await readdir(value.root)).includes('staging'), false);
});

test('workflow assembler rejects stale and cross-target retained input identities', async t => {
  const stale = await fixture(['rpi']);
  t.after(() => rm(stale.root, { recursive: true, force: true }));
  const stem = `yonder-${VERSION}-rpi-arm64`;
  const manifestPath = join(stale.builds, 'rpi', `${stem}.build.json`);
  const build = JSON.parse(await readFile(manifestPath, 'utf8'));
  build.inputs.payloadManifestSha256 = 'f'.repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(build)}\n`);
  await assert.rejects(assembleWorkflowRelease({ sourcePath: stale.sourcePath,
    inputRelease: stale.inputs, buildRoot: stale.builds, output: stale.output,
    candidate: 'github-47-1' }), /does not match its retained input archive/);

  const invalidId = await fixture(['rpi']);
  t.after(() => rm(invalidId.root, { recursive: true, force: true }));
  const invalidPath = join(invalidId.builds, 'rpi', `${stem}.build.json`);
  const invalidBuild = JSON.parse(await readFile(invalidPath, 'utf8'));
  invalidBuild.inputSetId = '0'.repeat(64);
  await writeFile(invalidPath, `${JSON.stringify(invalidBuild)}\n`);
  await assert.rejects(assembleWorkflowRelease({ sourcePath: invalidId.sourcePath,
    inputRelease: invalidId.inputs, buildRoot: invalidId.builds, output: invalidId.output,
    candidate: 'github-48-1' }), /inputSetId is invalid/);
});

test('workflow assembler binds candidate identity to the recorded verified trigger', async t => {
  const manual = await fixture(['rpi']);
  t.after(() => rm(manual.root, { recursive: true, force: true }));
  await assert.rejects(assembleWorkflowRelease({
    sourcePath: manual.sourcePath,
    inputRelease: manual.inputs,
    buildRoot: manual.builds,
    output: manual.output,
  }), /manual release requires/);

  const tagged = await fixture(TARGETS, 'push');
  t.after(() => rm(tagged.root, { recursive: true, force: true }));
  await assert.rejects(assembleWorkflowRelease({
    sourcePath: tagged.sourcePath,
    inputRelease: tagged.inputs,
    buildRoot: tagged.builds,
    output: tagged.output,
    candidate: 'github-46-1',
  }), /tag-triggered release must not/);

  const unverified = await fixture(TARGETS, 'push');
  t.after(() => rm(unverified.root, { recursive: true, force: true }));
  const source = JSON.parse(await readFile(unverified.sourcePath, 'utf8'));
  source.trigger.signedTagVerified = false;
  await writeFile(unverified.sourcePath, `${JSON.stringify(source)}\n`);
  await assert.rejects(assembleWorkflowRelease({
    sourcePath: unverified.sourcePath,
    inputRelease: unverified.inputs,
    buildRoot: unverified.builds,
    output: unverified.output,
  }), /verified ref/);
});

test('images workflow has exact triggers, pinned actions, isolated permissions and encrypted handoff', async () => {
  const path = join(REPO, '.github/workflows/images.yml');
  const text = await readFile(path, 'utf8');
  const workflow = parse(text);
  const duplicate = text.replace(
    '    env:\n      IMAGE_INPUT_ROOT:',
    '    env:\n      DUPLICATE_FIXTURE: value\n    env:\n      IMAGE_INPUT_ROOT:',
  );
  assert.throws(() => parse(duplicate), /unique|duplicate/i);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.target.options, ['all', ...TARGETS]);
  assert.deepEqual(workflow.on.push.tags, ['v20*.*.*']);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['authorize', 'build', 'draft']);
  assert.deepEqual(workflow.jobs.authorize.permissions, { actions: 'read', contents: 'read' });
  assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.draft.permissions, { contents: 'write' });
  assert.equal(workflow.jobs.build['runs-on'], '${{ vars.IMAGE_RUNNER }}');
  assert.equal(workflow.jobs.draft['runs-on'], workflow.jobs.build['runs-on']);
  for (const job of [workflow.jobs.build, workflow.jobs.draft]) {
    assert.doesNotMatch(JSON.stringify(job.env ?? {}), /runner\.temp/);
  }
  assert.ok(workflow.jobs.build.steps.filter(step => step.env?.BUILD_DIR).length >= 2);
  assert.ok(workflow.jobs.draft.steps.some(step => step.env?.SOURCE_DIR && step.env?.TRANSFER_DIR));
  assert.match(text, /Require the configured native ARM64 image runner/);
  assert.equal(text.match(/process\.versions\.node[^\n]+>= 24/g)?.length, 3);
  assert.equal(workflow.jobs.build.strategy['fail-fast'], false);
  assert.equal(workflow.jobs.build.strategy.matrix.target,
    '${{ fromJSON(needs.authorize.outputs.targets) }}');
  assert.deepEqual(workflow.jobs.draft.needs, ['authorize', 'build']);
  assert.equal(workflow.concurrency['cancel-in-progress'], false);

  const actions = Object.values(workflow.jobs).flatMap(job => job.steps)
    .filter(step => step.uses).map(step => step.uses);
  assert.ok(actions.length >= 6);
  assert.ok(actions.every(action => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(action)));
  assert.deepEqual([...new Set(actions)].sort(), [
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
  ].sort());
  const buildRun = workflow.jobs.build.steps.map(step => step.run ?? '').join('\n');
  assert.match(buildRun, /uname -m/);
  assert.match(buildRun, /40 \* 1024 \* 1024 \* 1024/);
  assert.match(buildRun, /YONDER_INPUTS_ROOT/);
  assert.match(buildRun, /image\/build\.sh/);
  assert.match(buildRun, /findmnt[^\n]+-o TARGET/);
  assert.match(buildRun, /findmnt[^\n]+-o OPTIONS/);
  assert.match(buildRun, /transfer-directory\.mjs seal/);
  const buildSteps = workflow.jobs.build.steps;
  const sealStep = buildSteps.findIndex(step => step.run?.includes('transfer-directory.mjs seal'));
  const uploadStep = buildSteps.findIndex(step => step.uses?.includes('upload-artifact'));
  assert.ok(sealStep >= 0 && uploadStep > sealStep);
  assert.doesNotMatch(buildSteps[uploadStep].with.path, /BUILD_DIR/);
  assert.match(buildSteps[uploadStep].with.path, /yonder-transfer/);
  const draftRun = workflow.jobs.draft.steps.map(step => step.run ?? '').join('\n');
  assert.match(draftRun, /transfer-directory\.mjs open/);
  assert.match(draftRun, /command -v zstd/);
  assert.match(draftRun, /assemble-workflow\.mjs/);
  assert.match(draftRun, /GITHUB_EVENT_NAME.*workflow_dispatch/);
  assert.match(draftRun, /--candidate/);
  assert.match(draftRun, /draft\.mjs/);
  assert.match(draftRun, /--apply/);
  assert.doesNotMatch(text, /draft:\s*false|--draft=false|gh release/);
  assert.match(text, /IMAGE_TRANSFER_PUBLIC_KEY/);
  assert.match(text, /IMAGE_TRANSFER_PRIVATE_KEY/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /IMAGE_TRANSFER_PRIVATE_KEY/);
  assert.match(JSON.stringify(workflow.jobs.authorize), /github\.event_name == 'push'.*'all'/);
  assert.match(JSON.stringify(workflow.jobs.authorize), /signedTagVerified/);
  for (const script of Object.values(workflow.jobs).flatMap(job => job.steps)
    .map(step => step.run).filter(Boolean)) {
    const materialized = script.replace(/\$\{\{[^}]+\}\}/g, 'fixed-value');
    const checked = spawnSync('bash', ['-n'], { input: materialized, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
    if (spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0) {
      const linted = spawnSync('shellcheck', ['--shell=bash', '-'], { input: materialized, encoding: 'utf8' });
      assert.equal(linted.status, 0, linted.stdout + linted.stderr);
    }
  }
});
