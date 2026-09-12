#!/usr/bin/env node

// SPDX-License-Identifier: GPL-3.0-or-later
// R-HW-04/R-SEC-07/R-CFG-15: assemble immutable image assets into drafts only.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdtemp,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { assertBuildInputBinding, validateIndexShape } from './input-bundles.mjs';

export const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

const TARGETS = Object.freeze(['rpi', 'radxa-zero3w', 'radxa-rock5c']);
const TARGET_SET = new Set(TARGETS);
const TARGET_ROLES = Object.freeze([
  'image',
  'checksum',
  'build-manifest',
  'packages',
  'verification',
]);
const RETAINED_ROLES = new Set(['input-index', 'input-bundle', 'license', 'source-notice']);
const HASH_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^[1-9]\d{3}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;
const CANDIDATE_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FORBIDDEN_NAME_RE = /(?:^|[._-])(?:private[-_]?access|authorized[-_]?keys?|bench|prototype|bench[-_]?ssh|ssh[-_]?key|id_(?:rsa|ed25519|ecdsa)|password|credentials?|secret)(?:[._-]|$)|\.(?:pem|key|pub|p12|pfx)$/i;

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has unsupported field ${key}`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail(`${label} must be a lowercase SHA-256`);
}

function safeRelativePath(value, label) {
  requireString(value, label);
  if (
    isAbsolute(value)
    || value.includes('\\')
    || value.includes('\0')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    fail(`${label} must be a safe relative path`);
  }
  return value;
}

function isContained(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function scanStagingTree(root) {
  let visited = 0;
  async function scan(directory, depth) {
    if (depth > 24) fail('release staging directory exceeds the maximum directory depth');
    const handle = await opendir(directory);
    for await (const entry of handle) {
      visited += 1;
      if (visited > 10_000) fail('release staging directory contains too many entries');
      if (FORBIDDEN_NAME_RE.test(entry.name)) {
        fail(`forbidden private material in staging directory: ${entry.name}`);
      }
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) fail(`release staging directory contains symlink: ${entry.name}`);
      if (info.isDirectory()) await scan(path, depth + 1);
      else if (!info.isFile() || info.nlink !== 1) {
        fail(`release staging directory contains non-regular or hard-linked file: ${entry.name}`);
      }
    }
  }
  await scan(root, 0);
}

async function validateFile(root, record, label) {
  requireObject(record, label);
  requireExactKeys(record, ['role', 'path', 'sha256'], label);
  requireString(record.role, `${label}.role`);
  const relativePath = safeRelativePath(record.path, `${label}.path`);
  assertHash(record.sha256, `${label}.sha256`);
  const unresolved = resolve(root, relativePath);
  if (!isContained(root, unresolved)) fail(`${label}.path escapes the staging directory`);
  const info = await lstat(unresolved);
  if (info.isSymbolicLink()) fail(`${label}.path is a symlink`);
  if (!info.isFile()) fail(`${label}.path must be a regular file`);
  if (info.size <= 0) fail(`${label}.path must not be empty`);
  if (info.size >= MAX_ASSET_BYTES) fail(`${label}.path must be strictly smaller than 2 GiB`);
  const canonical = await realpath(unresolved);
  if (!isContained(root, canonical)) fail(`${label}.path escapes the staging directory`);
  const actualHash = await sha256File(canonical);
  if (actualHash !== record.sha256) fail(`${label}.sha256 does not match ${relativePath}`);
  return {
    role: record.role,
    relativePath,
    path: canonical,
    name: basename(relativePath),
    sha256: actualHash,
    size: info.size,
  };
}

function expectedNames(version, target) {
  const stem = `yonder-${version}-${target}-arm64`;
  return new Map([
    ['image', `${stem}.img.xz`],
    ['checksum', `${stem}.sha256`],
    ['build-manifest', `${stem}.build.json`],
    ['packages', `${stem}.packages.tsv`],
    ['verification', `${stem}.verification.json`],
  ]);
}

async function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  return requireObject(value, label);
}

function assertReleaseBuildManifest(value, { target, version, sourceCommit, image }) {
  if (value.schemaVersion !== 1) fail(`${target} build manifest schemaVersion must be 1`);
  if (value.kind !== 'release-image') fail(`${target} build manifest kind must be release-image`);
  if (value.target !== target) fail(`${target} build manifest target does not match`);
  if (value.version !== version) fail(`${target} build manifest version does not match`);
  if (value.sourceRevision !== sourceCommit) fail(`${target} build manifest sourceRevision does not match`);
  if (value.sourceHasUncommittedChanges !== false) {
    fail(`${target} build manifest sourceHasUncommittedChanges must be false`);
  }
  if (value.protectedStorage !== true) fail(`${target} build manifest protectedStorage must be true`);
  if (value.temporaryBenchSsh !== false) fail(`${target} build manifest temporaryBenchSsh must be false`);
  if (value.storagePrototype === true) fail(`${target} build manifest must not be a storage prototype`);
  const imageValue = requireObject(value.image, `${target} build manifest image`);
  if (imageValue.fileName !== image.name || imageValue.sha256 !== image.sha256) {
    fail(`${target} build manifest image identity does not match the release image`);
  }
}

function assertReleaseVerification(value, { target, version, sourceCommit, image }) {
  if (value.schemaVersion !== 1) fail(`${target} verification schemaVersion must be 1`);
  if (value.kind !== 'yonder-image-verification') fail(`${target} verification kind is invalid`);
  if (value.target !== target || value.version !== version || value.sourceRevision !== sourceCommit) {
    fail(`${target} verification identity does not match the release set`);
  }
  if (value.imageSha256 !== image.sha256) fail(`${target} verification image SHA-256 does not match`);
  const checks = requireObject(value.checks, `${target} verification checks`);
  if (checks.credentialMaterialAbsent !== true) {
    fail(`${target} verification must establish credentialMaterialAbsent`);
  }
  if (checks.temporaryBenchAccessAbsent !== true) {
    fail(`${target} verification must establish temporaryBenchAccessAbsent`);
  }
  if (checks.protectedStorage !== true) {
    fail(`${target} verification must establish protectedStorage`);
  }
}

async function validateSuccessfulTarget(root, value, context) {
  const { target, version, sourceCommit } = context;
  requireExactKeys(value, ['status', 'buildManifest', 'assets'], `targets.${target}`);
  if (value.status !== 'success') fail(`targets.${target}.status must be success`);
  safeRelativePath(value.buildManifest, `targets.${target}.buildManifest`);
  if (!Array.isArray(value.assets) || value.assets.length !== TARGET_ROLES.length) {
    fail(`targets.${target}.assets must contain the five required assets`);
  }
  const expected = expectedNames(version, target);
  const byRole = new Map();
  for (const [index, record] of value.assets.entries()) {
    if (!TARGET_ROLES.includes(record?.role)) fail(`targets.${target}.assets[${index}] has invalid role`);
    if (byRole.has(record.role)) fail(`targets.${target}.assets repeats role ${record.role}`);
    const asset = await validateFile(root, record, `targets.${target}.assets[${index}]`);
    if (asset.name !== expected.get(asset.role)) {
      fail(`${target} ${asset.role} must be named ${expected.get(asset.role)}`);
    }
    byRole.set(asset.role, { ...asset, target });
  }
  for (const role of TARGET_ROLES) {
    if (!byRole.has(role)) fail(`targets.${target}.assets is missing role ${role}`);
  }
  if (value.buildManifest !== byRole.get('build-manifest').relativePath) {
    fail(`targets.${target}.buildManifest must identify the build-manifest asset`);
  }
  const image = byRole.get('image');
  const expectedChecksum = `${image.sha256}  ${image.name}\n`;
  if (await readFile(byRole.get('checksum').path, 'utf8') !== expectedChecksum) {
    fail(`${target} checksum file must contain the exact image SHA-256 and filename`);
  }
  const buildManifest = await readJson(byRole.get('build-manifest').path, `${target} build manifest`);
  assertReleaseBuildManifest(buildManifest, {
    target,
    version,
    sourceCommit,
    image,
  });
  assertReleaseVerification(await readJson(byRole.get('verification').path, `${target} verification`), {
    target,
    version,
    sourceCommit,
    image,
  });
  return { assets: [...byRole.values()], buildManifest };
}

function validateSelection(selectedTargets) {
  if (!Array.isArray(selectedTargets) || selectedTargets.length === 0) {
    fail('at least one --target is required');
  }
  if (selectedTargets.includes('all')) {
    if (selectedTargets.length !== 1) fail('--target all cannot be combined with another target');
    return [...TARGETS];
  }
  const seen = new Set();
  for (const target of selectedTargets) {
    if (!TARGET_SET.has(target)) fail(`unsupported target: ${target}`);
    if (seen.has(target)) fail(`target selected more than once: ${target}`);
    seen.add(target);
  }
  return TARGETS.filter((target) => seen.has(target));
}

async function validateRetainedInputs(root, records, context) {
  if (!Array.isArray(records) || records.length < 2) {
    fail('retainedInputs must contain an input index and at least one input bundle');
  }
  const assets = [];
  for (const [index, record] of records.entries()) {
    if (!RETAINED_ROLES.has(record?.role)) fail(`retainedInputs[${index}] has invalid role`);
    assets.push(await validateFile(root, record, `retainedInputs[${index}]`));
  }
  const indexes = assets.filter(({ role }) => role === 'input-index');
  const bundles = assets.filter(({ role }) => role === 'input-bundle');
  if (indexes.length !== 1) fail('retainedInputs must contain exactly one input-index');
  if (bundles.length === 0) fail('retainedInputs must contain at least one input-bundle');
  const index = await readJson(indexes[0].path, 'retained input index');
  validateIndexShape(index);
  if (index.version !== context.version || index.sourceCommit !== context.sourceCommit) {
    fail('retained input index identity does not match the release set');
  }
  const indexedTargets = index.targets.map(entry => entry.target);
  for (const target of context.selectedTargets) {
    if (!indexedTargets.includes(target)) fail(`retained input index does not cover selected target ${target}`);
  }
  const expectedCoverage = TARGETS.filter((target) => context.successfulTargets.has(target));
  if (JSON.stringify(indexedTargets) !== JSON.stringify(expectedCoverage)) {
    fail('retained input index target coverage must exactly match successful targets');
  }
  const indexedParts = index.targets.flatMap(entry => entry.archive.parts);
  if (indexedParts.length !== bundles.length) {
    fail('retained input index bundles must exactly cover retained input-bundle assets');
  }
  const bundleByName = new Map(bundles.map((bundle) => [bundle.name, bundle]));
  if (bundleByName.size !== bundles.length) fail('retained input-bundle filenames must be unique');
  const indexedNames = new Set();
  for (const entry of indexedParts) {
    if (basename(entry.fileName) !== entry.fileName) fail('retained input index bundle fileName must be a basename');
    if (indexedNames.has(entry.fileName)) fail(`retained input index repeats bundle ${entry.fileName}`);
    indexedNames.add(entry.fileName);
    const asset = bundleByName.get(entry.fileName);
    if (!asset) fail(`retained input index names unknown bundle ${entry.fileName}`);
    if (asset.sha256 !== entry.sha256) fail(`retained input index bundle hash does not match ${entry.fileName}`);
  }
  for (const targetEntry of index.targets) {
    assertBuildInputBinding(context.targetBuilds.get(targetEntry.target), targetEntry, {
      version: context.version, sourceCommit: context.sourceCommit,
    });
  }
  return assets;
}

export async function validateDraftInput(manifestPath, selectedTargets) {
  requireString(manifestPath, 'manifest path');
  const selected = validateSelection(selectedTargets);
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) fail('manifest must be a regular non-symlink file');
  const canonicalManifest = await realpath(manifestPath);
  const root = await realpath(dirname(canonicalManifest));
  await scanStagingTree(root);
  const manifest = await readJson(canonicalManifest, 'release-set manifest');
  requireExactKeys(
    manifest,
    ['schemaVersion', 'kind', 'version', 'sourceCommit', 'status', 'candidateId', 'targets', 'retainedInputs'],
    'release-set manifest',
  );
  if (manifest.schemaVersion !== 1) fail('release-set manifest schemaVersion must be 1');
  if (manifest.kind !== 'yonder-image-release-set') fail('release-set manifest kind must be yonder-image-release-set');
  if (!VERSION_RE.test(manifest.version)) fail('release-set manifest version must be CalVer YYYY.M.RELEASE');
  if (!COMMIT_RE.test(manifest.sourceCommit)) fail('release-set manifest sourceCommit must be a lowercase full commit');
  if (!['partial', 'complete'].includes(manifest.status)) fail('release-set manifest status must be partial or complete');
  if (manifest.candidateId !== undefined
    && (typeof manifest.candidateId !== 'string' || !CANDIDATE_RE.test(manifest.candidateId))) {
    fail('release-set manifest requires a safe candidateId for a Git tag');
  }
  const targetValues = requireObject(manifest.targets, 'release-set manifest targets');
  requireExactKeys(targetValues, TARGETS, 'release-set manifest targets');
  const successfulTargets = new Set();
  const targetAssets = new Map();
  const declaredTargets = TARGETS.filter((target) => Object.hasOwn(targetValues, target));
  if (declaredTargets.length === 0) fail('release-set manifest targets must not be empty');
  for (const target of declaredTargets) {
    const value = requireObject(targetValues[target], `targets.${target}`);
    if (value.status === 'failed') {
      requireExactKeys(value, ['status', 'reason'], `targets.${target}`);
      requireString(value.reason, `targets.${target}.reason`);
      continue;
    }
    if (value.status !== 'success') fail(`targets.${target}.status must be success or failed`);
    successfulTargets.add(target);
    targetAssets.set(target, await validateSuccessfulTarget(root, value, {
      target,
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
    }));
  }
  const isComplete = manifest.status === 'complete';
  if (isComplete && successfulTargets.size !== TARGETS.length) {
    fail('complete manifest requires all three successful targets');
  }
  if (!isComplete && successfulTargets.size === TARGETS.length) {
    fail('partial manifest cannot contain all three successful targets');
  }
  const allSelected = selected.length === TARGETS.length && selected.every((target, index) => target === TARGETS[index]);
  if (selectedTargets[0] === 'all' && (!isComplete || successfulTargets.size !== TARGETS.length)) {
    fail('all requires a complete manifest with all three successful targets');
  }
  for (const target of selected) {
    if (!successfulTargets.has(target)) fail(`selected target ${target} did not build successfully`);
  }
  const state = allSelected && isComplete
    ? (manifest.candidateId === undefined ? 'complete' : 'candidate')
    : 'partial';
  if (state !== 'complete'
    && (typeof manifest.candidateId !== 'string' || !CANDIDATE_RE.test(manifest.candidateId))) {
    fail('candidate draft requires a safe candidateId');
  }
  const retainedAssets = await validateRetainedInputs(root, manifest.retainedInputs, {
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    successfulTargets,
    selectedTargets: selected,
    targetBuilds: new Map([...targetAssets].map(([target, value]) => [target, value.buildManifest])),
  });
  const assets = [
    ...selected.flatMap((target) => targetAssets.get(target).assets),
    ...retainedAssets,
  ];
  const names = new Set();
  for (const asset of assets) {
    if (names.has(asset.name)) fail(`release assets repeat filename ${asset.name}`);
    names.add(asset.name);
  }
  const manifestSha256 = await sha256File(canonicalManifest);
  const assetSetSha256 = sha256Bytes(JSON.stringify(assets.map(({ name, sha256, size }) => ({ name, sha256, size }))));
  const selectionSlug = selected.join('.');
  const tag = state === 'complete'
    ? `v${manifest.version}`
    : `v${manifest.version}-candidate-${selectionSlug}-${manifest.sourceCommit.slice(0, 12)}-${manifest.candidateId}`;
  return {
    schemaVersion: 1,
    kind: 'yonder-draft-release-plan',
    manifestPath: canonicalManifest,
    manifestSha256,
    assetSetSha256,
    version: manifest.version,
    sourceCommit: manifest.sourceCommit,
    state,
    tag,
    selectedTargets: selected,
    candidateId: manifest.candidateId,
    assets,
  };
}

function releaseBody(plan, state) {
  return [
    `Yonder image ${plan.version} draft candidate.`,
    '',
    `State: ${state}`,
    `Source commit: ${plan.sourceCommit}`,
    `Targets: ${plan.selectedTargets.join(', ')}`,
    `Asset set: ${plan.assetSetSha256}`,
    '',
    'Publication requires an explicit separate decision after hardware qualification.',
  ].join('\n');
}

function releaseName(plan, state) {
  return `Yonder ${plan.version} ${state} image candidate`;
}

async function buildReleaseIndex(plan, directory) {
  const name = `yonder-${plan.version}-${plan.state}-${plan.assetSetSha256.slice(0, 16)}.release.json`;
  const path = join(directory, name);
  const value = {
    schemaVersion: 1,
    kind: 'yonder-draft-release-index',
    version: plan.version,
    tag: plan.tag,
    sourceCommit: plan.sourceCommit,
    state: plan.state,
    selectedTargets: plan.selectedTargets,
    manifestSha256: plan.manifestSha256,
    assetSetSha256: plan.assetSetSha256,
    assets: plan.assets.map(({ name: assetName, role, target, sha256, size }) => ({
      name: assetName,
      role,
      ...(target ? { target } : {}),
      sha256,
      size,
    })),
  };
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, bytes, { mode: 0o600 });
  return {
    role: 'release-index',
    path,
    relativePath: name,
    name,
    sha256: sha256Bytes(bytes),
    size: Buffer.byteLength(bytes),
  };
}

async function downloadAndHash(github, { repo, releaseId, asset }, directory) {
  const destination = join(directory, 'download.asset');
  await github.downloadAsset({ repo, releaseId, asset, destination });
  const actual = await sha256File(destination);
  await rm(destination, { force: true });
  return actual;
}

export async function orchestrateDraft({ manifestPath, repo, selectedTargets, apply = false, github }) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) fail('repo must be OWNER/REPO');
  const plan = await validateDraftInput(manifestPath, selectedTargets);
  if (!apply) return { ...plan, applied: false };
  if (!github) fail('a GitHub client is required with --apply');
  const scratch = await mkdtemp(join(tmpdir(), 'yonder-draft-release-'));
  try {
    const releaseIndex = await buildReleaseIndex(plan, scratch);
    const plannedAssets = [...plan.assets, releaseIndex];
    let release = await github.getReleaseByTag({ repo, tag: plan.tag });
    if (release && release.draft !== true) fail(`refusing to mutate published release ${plan.tag}`);
    if (release) {
      const resolved = await github.resolveCommit({ repo, ref: release.target_commitish });
      if (resolved !== plan.sourceCommit) {
        fail(`release target ${release.target_commitish} resolves to ${resolved}; expected ${plan.sourceCommit}`);
      }
    } else {
      release = await github.createDraft({
        repo,
        tag: plan.tag,
        targetCommitish: plan.sourceCommit,
        name: releaseName(plan, 'assembling'),
        body: releaseBody(plan, 'assembling'),
        draft: true,
      });
      if (release?.draft !== true) fail('GitHub did not create a draft release');
    }
    const remoteAssets = await github.listAssets({ repo, releaseId: release.id });
    const plannedNames = new Set(plannedAssets.map(({ name }) => name));
    const remoteByName = new Map();
    for (const asset of remoteAssets) {
      if (remoteByName.has(asset.name)) fail(`draft release repeats asset name ${asset.name}`);
      if (!plannedNames.has(asset.name)) fail(`draft release contains unmanifested asset ${asset.name}`);
      remoteByName.set(asset.name, asset);
    }
    const assertStillDraft = async () => {
      const current = await github.getReleaseByTag({ repo, tag: plan.tag });
      if (!current || current.id !== release.id || current.draft !== true) {
        fail(`release ${plan.tag} is no longer a draft; refusing further mutation`);
      }
      const resolved = await github.resolveCommit({ repo, ref: current.target_commitish });
      if (resolved !== plan.sourceCommit) {
        fail(`release target ${current.target_commitish} resolves to ${resolved}; expected ${plan.sourceCommit}`);
      }
      return current;
    };

    for (const planned of plannedAssets) {
      const existing = remoteByName.get(planned.name);
      if (!existing) continue;
      const actual = await downloadAndHash(github, {
        repo,
        releaseId: release.id,
        asset: existing,
      }, scratch);
      if (actual !== planned.sha256) {
        fail(`immutable asset ${planned.name} has a different SHA-256; refusing overwrite`);
      }
    }

    const missing = plannedAssets.filter(({ name }) => !remoteByName.has(name));
    if (missing.length > 0 && (
      release.body !== releaseBody(plan, 'assembling')
      || release.name !== releaseName(plan, 'assembling')
    )) {
      await assertStillDraft();
      release = await github.updateDraft({
        repo,
        releaseId: release.id,
        name: releaseName(plan, 'assembling'),
        body: releaseBody(plan, 'assembling'),
        draft: true,
      });
      if (release?.draft !== true) fail('GitHub draft update returned a non-draft release');
    }
    for (const planned of missing) {
      await assertStillDraft();
      const uploaded = await github.uploadAsset({
        repo,
        releaseId: release.id,
        path: planned.path,
        name: planned.name,
        contentType: contentType(planned.name),
      });
      if (uploaded?.name !== planned.name) fail(`GitHub renamed uploaded asset ${planned.name}`);
      const actual = await downloadAndHash(github, {
        repo,
        releaseId: release.id,
        asset: uploaded,
      }, scratch);
      if (actual !== planned.sha256) fail(`downloaded asset ${planned.name} SHA-256 mismatch`);
    }
    await assertStillDraft();
    release = await github.updateDraft({
      repo,
      releaseId: release.id,
      name: releaseName(plan, plan.state),
      body: releaseBody(plan, plan.state),
      draft: true,
    });
    if (release?.draft !== true) fail('GitHub draft update returned a non-draft release');
    return {
      ...plan,
      assets: plannedAssets,
      applied: true,
      releaseId: release.id,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function contentType(name) {
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.tsv')) return 'text/tab-separated-values';
  if (name.endsWith('.sha256') || name.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

function ghRun(args, { input, outputPath, allowNotFound = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const output = outputPath ? createWriteStream(outputPath, { mode: 0o600 }) : null;
    const child = spawn('gh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    if (output) child.stdout.pipe(output);
    else child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', async (code) => {
      if (output) {
        try {
          await finished(output);
        } catch (error) {
          return reject(error);
        }
      }
      const errorText = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        if (allowNotFound && /HTTP 404|not found/i.test(errorText)) return resolvePromise(null);
        return reject(new Error(`gh ${args[0]} failed (${code}): ${errorText.trim()}`));
      }
      resolvePromise(outputPath ? Buffer.alloc(0) : Buffer.concat(stdout));
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

async function ghJson(args, options) {
  const output = await ghRun(args, options);
  if (output === null) return null;
  try {
    return JSON.parse(output.toString('utf8'));
  } catch (error) {
    fail(`gh returned invalid JSON: ${error.message}`);
  }
}

export class GhApiClient {
  constructor({ json = ghJson, run = ghRun } = {}) {
    this.json = json;
    this.run = run;
  }

  async getReleaseByTag({ repo, tag }) {
    return this.json(['api', `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`], { allowNotFound: true });
  }

  async resolveCommit({ repo, ref }) {
    const value = await this.json(['api', `repos/${repo}/commits/${encodeURIComponent(ref)}`]);
    if (!COMMIT_RE.test(value?.sha)) fail(`GitHub did not resolve commit ref ${ref}`);
    return value.sha;
  }

  async createDraft({ repo, tag, targetCommitish, name, body, draft }) {
    return this.json(['api', '--method', 'POST', `repos/${repo}/releases`, '--input', '-'], {
      input: JSON.stringify({ tag_name: tag, target_commitish: targetCommitish, name, body, draft }),
    });
  }

  async listAssets({ repo, releaseId }) {
    const pages = await this.json([
      'api', '--paginate', '--slurp', `repos/${repo}/releases/${releaseId}/assets?per_page=100`,
    ]);
    if (!Array.isArray(pages)) fail('GitHub release asset response is invalid');
    return pages.flat();
  }

  async uploadAsset({ repo, releaseId, path, name, contentType: type }) {
    return this.json([
      'api', '--method', 'POST',
      '--hostname', 'uploads.github.com',
      '-H', `Content-Type: ${type}`,
      '--input', path,
      `repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    ]);
  }

  async downloadAsset({ repo, asset, destination }) {
    await this.run([
      'api', '-H', 'Accept: application/octet-stream',
      `repos/${repo}/releases/assets/${asset.id}`,
    ], { outputPath: destination });
  }

  async updateDraft({ repo, releaseId, name, body, draft }) {
    return this.json(['api', '--method', 'PATCH', `repos/${repo}/releases/${releaseId}`, '--input', '-'], {
      input: JSON.stringify({ name, body, draft }),
    });
  }
}

export function parseArgs(argv) {
  const result = { manifestPath: undefined, repo: undefined, selectedTargets: [], apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      result.apply = true;
    } else if (argument === '--manifest' || argument === '--repo' || argument === '--target') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
      index += 1;
      if (argument === '--manifest') result.manifestPath = value;
      if (argument === '--repo') result.repo = value;
      if (argument === '--target') result.selectedTargets.push(value);
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  if (!result.manifestPath) fail('--manifest is required');
  if (!result.repo) fail('--repo is required');
  validateSelection(result.selectedTargets);
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await orchestrateDraft({
    ...options,
    github: options.apply ? new GhApiClient() : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, (key, value) => key === 'path' ? undefined : value, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`draft release failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
