#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Assemble a credential-free image from an exact base, frozen APT repository,
// frozen ARM64 builder and the reviewed source checkout.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceEntriesFor, targetFacts } from './bench/build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TARGETS = new Set(['rpi', 'radxa-zero3w', 'radxa-rock5c']);
const SHA = /^[a-f0-9]{64}$/;
const OCI = /^sha256:[a-f0-9]{64}$/;

export class InterruptedBuildError extends Error {
  constructor(signal) {
    super(`Production image build interrupted by ${signal}`);
    this.name = 'InterruptedBuildError';
    this.signal = signal;
    this.exitCode = signal === 'SIGINT' ? 130 : 143;
  }
}

function usage() {
  return 'Usage: node image/build.mjs --target rpi|radxa-zero3w|radxa-rock5c --base BASE.img.xz --apt-input DIRECTORY --payload-input DIRECTORY --builder-input DIRECTORY --output NEW_DIRECTORY';
}

export function parseArgs(args) {
  const names = new Map([['--target', 'target'], ['--base', 'base'], ['--apt-input', 'aptInput'],
    ['--payload-input', 'payloadInput'], ['--builder-input', 'builderInput'], ['--output', 'output']]);
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = names.get(args[index]);
    if (!key || result[key] !== undefined || index + 1 >= args.length) throw new Error(usage());
    result[key] = args[++index];
  }
  if (!TARGETS.has(result.target) || !result.base || !result.aptInput || !result.payloadInput
    || !result.builderInput || !result.output) {
    throw new Error(usage());
  }
  return result;
}

export function productionSourceEntries(target) {
  if (!TARGETS.has(target)) throw new Error('Unknown image target');
  return [...new Set([
    ...sourceEntriesFor(target, true).filter(entry => !entry.startsWith('vendor/')
      && entry !== 'packages' && !entry.startsWith('packages/')),
    'image/bases.lock.json',
    'image/build.mjs',
    'image/finalize.sh',
    'image/inspection',
    'image/verify-finalized.sh',
    'image/lib/input-set.mjs',
    'image/inputs/install-captured-apt.sh',
    'image/inputs/payload-inventory.py',
    'image/package-sets.sh',
  ])];
}

export function stageCapturedApplication(replayedVendor, scratch, sourceRevision) {
  const application = join(replayedVendor, 'application');
  assertDirectory(application, 'Replayed first-party application');
  const metadataPath = join(application, 'application-bundle.json');
  const metadataInfo = lstatSync(metadataPath);
  if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.nlink !== 1) {
    throw new Error('Replayed first-party application metadata is invalid');
  }
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (metadata.schemaVersion !== 1 || metadata.kind !== 'yonder-first-party-application'
    || metadata.sourceKind !== 'git-archive' || metadata.sourceCommit !== sourceRevision
    || metadata.platform !== 'linux/arm64') {
    throw new Error('First-party application does not match the image source revision');
  }
  const packages = join(application, 'packages');
  assertDirectory(packages, 'Replayed first-party packages');
  const destination = join(scratch, 'packages');
  if (existsSync(destination)) throw new Error('First-party package staging path already exists');
  renameSync(packages, destination);
  rmSync(application, { recursive: true, force: false });
  return destination;
}

async function sha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function inventory(root, prefix = '') {
  const values = [];
  for (const name of readdirSync(join(root, prefix)).sort()) {
    if (prefix === '' && name === 'builder-input.json') continue;
    const item = join(prefix, name);
    const path = join(root, item);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())
      || (info.isFile() && info.nlink !== 1)) {
      throw new Error('Frozen builder input contains an unsafe file');
    }
    if (info.isDirectory()) values.push(...inventory(root, item));
    else values.push({ path: item, bytes: info.size });
  }
  return values;
}

export async function validateBuilderInput(directory) {
  const root = resolve(directory);
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Builder input must be a directory');
  const manifestPath = join(root, 'builder-input.json');
  const manifestInfo = lstatSync(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 1024 * 1024) {
    throw new Error('Invalid frozen builder manifest');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'yonder-builder-input'
    || manifest.platform !== 'linux/arm64' || !OCI.test(manifest.imageId ?? '')
    || !/^debian@sha256:[a-f0-9]{64}$/.test(manifest.baseRuntime ?? '')
    || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Invalid frozen builder manifest');
  }
  const actual = inventory(root);
  const listed = [...manifest.files].sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0);
  if (actual.length !== listed.length) throw new Error('Frozen builder inventory does not match');
  for (let index = 0; index < actual.length; index += 1) {
    const have = actual[index];
    const want = listed[index];
    if (want?.path !== have.path || want.bytes !== have.bytes || !SHA.test(want.sha256 ?? '')
      || await sha(join(root, have.path)) !== want.sha256) throw new Error('Frozen builder inventory does not match');
  }
  if (!actual.some(item => item.path === 'builder.docker.tar')) throw new Error('Frozen builder image is missing');
  return { ...manifest, root };
}

function run(command, args, { capture = false, cwd = REPO } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  return capture ? result.stdout.trim() : '';
}

export async function runInterruptible(command, args, { cwd = REPO, onInterrupt = () => {} } = {}) {
  let child;
  let interruption;
  let escalation;
  const interrupt = signal => {
    if (interruption) return;
    interruption = signal;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1000);
      escalation.unref();
    }
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let result;
  try {
    try {
      result = await new Promise((resolveChild, rejectChild) => {
        child = spawn(command, args, { cwd, stdio: 'inherit' });
        child.once('error', rejectChild);
        child.once('close', (status, signal) => resolveChild({ status, signal }));
      });
    } catch (error) {
      if (!interruption) throw error;
    }
    if (interruption) {
      try { await onInterrupt(interruption); }
      catch (error) { console.error(`Interrupted build cleanup failed: ${error.message}`); }
      throw new InterruptedBuildError(interruption);
    }
    if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    if (escalation) clearTimeout(escalation);
  }
}

export function cleanupOwnedContainer(name, { spawnSyncImpl = spawnSync } = {}) {
  spawnSyncImpl('docker', ['exec', name, '/bin/sh', '-c', 'kill -TERM -1'], { stdio: 'ignore' });
  spawnSyncImpl('docker', ['exec', name, '/bin/sh', '-c', 'kill -KILL -1'], { stdio: 'ignore' });
  const clean = spawnSyncImpl('docker', ['exec', name, '/bin/bash', '/work/cleanup.sh'],
    { stdio: 'inherit' });
  if (clean.error || clean.status !== 0) {
    console.error(`Builder cleanup failed; retained container ${name} for inspection`);
    return false;
  }
  const removed = spawnSyncImpl('docker', ['rm', '-f', name], { stdio: 'ignore' });
  if (removed.error || removed.status !== 0) {
    console.error(`Builder removal failed; retained container ${name} for inspection`);
    return false;
  }
  return true;
}

function assertDirectory(path, label) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a directory`);
}

export async function validatePayloadAptBinding(aptInput, replayedVendor) {
  const zerotier = join(replayedVendor, 'zerotier');
  assertDirectory(zerotier, 'Replayed ZeroTier payload');
  const files = readdirSync(zerotier).filter(name => /^zerotier-one_.*_arm64\.deb$/.test(name));
  if (files.length !== 1) throw new Error('Payload must contain exactly one ARM64 ZeroTier package');
  const packagePath = join(zerotier, files[0]);
  const info = lstatSync(packagePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error('Payload ZeroTier package must be a regular single-link file');
  }
  const rows = readFileSync(join(aptInput, 'packages.tsv'), 'utf8').trim().split('\n')
    .map(line => line.split('\t')).filter(fields => fields[1] === 'zerotier-one');
  if (rows.length !== 1 || rows[0].length !== 8 || !SHA.test(rows[0][6])
    || await sha(packagePath) !== rows[0][6]) {
    throw new Error('APT and payload ZeroTier packages do not match');
  }
}

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  const options = parseArgs(args);
  const output = resolve(options.output);
  const basePath = resolve(options.base);
  const aptInput = resolve(options.aptInput);
  const payloadInput = resolve(options.payloadInput);
  const builder = await validateBuilderInput(options.builderInput);
  assertDirectory(aptInput, 'APT input');
  assertDirectory(payloadInput, 'Payload input');
  if (!existsSync(join(aptInput, 'SHA256SUMS')) || !existsSync(join(aptInput, 'capture.json'))) {
    throw new Error('APT input is incomplete');
  }
  const payloadManifestPath = join(payloadInput, 'payload-input.json');
  const payloadManifest = JSON.parse(readFileSync(payloadManifestPath, 'utf8'));
  if (payloadManifest.schemaVersion !== 1 || payloadManifest.kind !== 'yonder-application-payload-input'
    || payloadManifest.target !== options.target || payloadManifest.architecture !== 'linux-arm64'
    || payloadManifest.payloadReplay?.status !== 'complete') {
    throw new Error('Payload input does not match the target');
  }
  const baseInfo = lstatSync(basePath);
  if (!baseInfo.isFile() || baseInfo.isSymbolicLink()) throw new Error('Base image must be a regular file');
  if (existsSync(output)) throw new Error('Output directory already exists');
  if (output === REPO || !relative(REPO, output).startsWith('..')) {
    for (const entry of productionSourceEntries(options.target)) {
      const source = resolve(REPO, entry);
      if (output === source || output.startsWith(`${source}/`)) throw new Error('Output overlaps archived source');
    }
  }
  const lock = JSON.parse(readFileSync(join(REPO, 'image/bases.lock.json'), 'utf8'));
  const locked = lock.targets?.[options.target];
  if (!locked || await sha(basePath) !== locked.sha256) throw new Error('Base image does not match the target lock');
  const inspection = JSON.parse(readFileSync(join(REPO, `image/inspection/${options.target}.json`), 'utf8'));
  const facts = { ...targetFacts(lock, inspection, options.target), storagePrototype: true };
  const sourceRevision = run('git', ['rev-parse', 'HEAD'], { capture: true });
  if (run('git', ['status', '--porcelain', '--untracked-files=normal'], { capture: true })) {
    throw new Error('Production image source tree is not clean');
  }
  mkdirSync(output, { recursive: false, mode: 0o700 });
  const scratch = join(output, '.build');
  mkdirSync(scratch, { mode: 0o700 });
  const sourceTar = join(scratch, 'source.tar');
  const replayedVendor = join(scratch, 'vendor');
  const backend = options.target === 'rpi' ? 'image/pi' : 'image/bench';
  const sourceEntries = productionSourceEntries(options.target);
  run('python3', ['-I', join(REPO, 'image/inputs/payload-inventory.py'), 'replay',
    '--input', payloadInput, '--output', replayedVendor]);
  await validatePayloadAptBinding(aptInput, replayedVendor);
  stageCapturedApplication(replayedVendor, scratch, sourceRevision);
  run('tar', ['--no-xattrs', '-cf', sourceTar, ...sourceEntries]);
  run('tar', ['--no-xattrs', '-rf', sourceTar, '-C', scratch, 'packages']);
  run('tar', ['--no-xattrs', '-rf', sourceTar, '-C', scratch, 'vendor']);
  const sourceSha256 = await sha(sourceTar);
  const version = JSON.parse(run('tar', ['-xOf', sourceTar, 'package.json'], { capture: true })).version;
  run('tar', ['-xf', sourceTar, '-C', scratch, `${backend}/build-inside.sh`, `${backend}/cleanup.sh`]);
  const expectedSha = join(scratch, 'expected-sha');
  const factsPath = join(scratch, 'target.json');
  writeFileSync(expectedSha, `${locked.sha256}\n`, { mode: 0o600 });
  writeFileSync(factsPath, `${JSON.stringify(facts, null, 2)}\n`, { mode: 0o600 });

  const loaded = run('docker', ['load', '-i', join(builder.root, 'builder.docker.tar')], { capture: true });
  if (!loaded.includes(builder.imageId.slice(7)) && !loaded.includes(builder.imageId)) {
    // Docker may print only a tag for tagged archives, so inspect remains the authority.
    run('docker', ['image', 'inspect', builder.imageId], { capture: true });
  }
  const architecture = JSON.parse(run('docker', ['image', 'inspect', builder.imageId], { capture: true }))[0]?.Architecture;
  if (architecture !== 'arm64') throw new Error('Frozen builder image is not ARM64');
  const name = `yonder-production-${process.pid}-${randomBytes(4).toString('hex')}`;
  let created = false;
  let cleaning = false;
  const cleanup = () => {
    if (!created || cleaning) return;
    cleaning = true;
    if (cleanupOwnedContainer(name)) created = false;
    else process.exitCode = 1;
  };
  try {
    run('docker', ['run', '-d', '--name', name, '--platform', 'linux/arm64', '--network', 'none',
      '--cap-add', 'SYS_ADMIN', '--device-cgroup-rule', 'b 7:* rwm', '--device-cgroup-rule', 'b 259:* rwm',
      '--device-cgroup-rule', 'c 10:237 rwm', '--mount', `type=bind,src=${aptInput},dst=/work/apt-input,readonly`,
      '-e', 'YONDER_FROZEN_BUILD=1', builder.imageId, 'sleep', 'infinity']);
    created = true;
    run('docker', ['exec', name, 'mkdir', '-p', '/work/result']);
    for (const [source, dest] of [[basePath, 'base.img.xz'], [sourceTar, 'source.tar'],
      [expectedSha, 'expected-sha'], [factsPath, 'target.json'],
      [join(scratch, backend, 'build-inside.sh'), 'build-inside.sh'],
      [join(scratch, backend, 'cleanup.sh'), 'cleanup.sh']]) {
      run('docker', ['cp', source, `${name}:/work/${dest}`]);
    }
    const backendArgs = options.target === 'rpi' ? ['production'] : [options.target, 'production'];
    await runInterruptible('docker', ['exec', name, '/bin/bash', '/work/build-inside.sh', ...backendArgs], {
      onInterrupt: () => {
        cleanup();
        rmSync(output, { recursive: true, force: true });
      },
    });
    const stem = `yonder-${version}-${options.target}-arm64`;
    for (const [source, suffix] of [['image.img.xz', '.img.xz.partial'], ['packages.tsv', '.packages.tsv'],
      ['verification.txt', '.verification.txt']]) {
      run('docker', ['cp', `${name}:/work/result/${source}`, join(output, `${stem}${suffix}`)]);
    }
    const imagePartial = join(output, `${stem}.img.xz.partial`);
    const imageHash = await sha(imagePartial);
    const expected = run('docker', ['exec', name, 'cat', '/work/result/image.sha256'], { capture: true }).split(/\s+/)[0];
    if (imageHash !== expected) throw new Error('Copied production image checksum mismatch');
    renameSync(imagePartial, join(output, `${stem}.img.xz`));
    writeFileSync(join(output, `${stem}.sha256`), `${imageHash}  ${stem}.img.xz\n`, { mode: 0o600 });
    const aptHash = await sha(join(aptInput, 'SHA256SUMS'));
    const payloadHash = await sha(payloadManifestPath);
    const builderHash = await sha(join(builder.root, 'builder-input.json'));
    const inputSetId = createHash('sha256').update(
      `${locked.sha256}\n${aptHash}\n${payloadHash}\n${builderHash}\n${sourceSha256}\n`,
    ).digest('hex');
    const buildManifest = { schemaVersion: 1, kind: 'release-image', version, target: options.target,
      sourceRevision, sourceHasUncommittedChanges: false, hardwareQualified: false,
      protectedStorage: true, temporaryBenchSsh: false, base: locked, inputSetId,
      inputs: { aptSha256Sums: aptHash, payloadManifestSha256: payloadHash,
        builderManifestSha256: builderHash, sourceSnapshotSha256: sourceSha256 },
      buildTools: { outerBuilderSha256: await sha(join(REPO, 'image/build.mjs')),
        targetBackendSha256: await sha(join(REPO, backend, 'build-inside.sh')),
        finalizerSha256: await sha(join(REPO, 'image/finalize.sh')) },
      builderImageId: builder.imageId, image: { fileName: `${stem}.img.xz`, sha256: imageHash } };
    writeFileSync(join(output, `${stem}.build.json`), `${JSON.stringify(buildManifest, null, 2)}\n`, { mode: 0o600 });
    const verification = { schemaVersion: 1, kind: 'yonder-image-verification', version,
      target: options.target, sourceRevision, imageSha256: imageHash, hardwareQualified: false,
      checks: { credentialMaterialAbsent: true, temporaryBenchAccessAbsent: true, protectedStorage: true },
      details: readFileSync(join(output, `${stem}.verification.txt`), 'utf8') };
    writeFileSync(join(output, `${stem}.verification.json`), `${JSON.stringify(verification, null, 2)}\n`, { mode: 0o600 });
    rmSync(join(output, `${stem}.verification.txt`));
    rmSync(scratch, { recursive: true, force: true });
    cleanup();
    if (created) throw new Error(`Image built but builder cleanup failed; retained container ${name}`);
    console.log(`Production image: ${join(output, `${stem}.img.xz`)}`);
  } finally {
    cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    if (error instanceof InterruptedBuildError) process.exitCode = error.exitCode;
    else { console.error(`error: ${error.message}`); process.exitCode = 1; }
  });
}
