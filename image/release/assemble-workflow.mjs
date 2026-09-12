#!/usr/bin/env node

// SPDX-License-Identifier: GPL-3.0-or-later
// R-HW-04/R-SEC-07: assemble authenticated matrix outputs and retained inputs
// into the strict draft-release manifest. This helper never calls GitHub.

import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBuildInputBinding, validateIndexShape, verifyIndexedArchive } from './input-bundles.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const TARGETS = Object.freeze(['rpi', 'radxa-zero3w', 'radxa-rock5c']);
const TARGET_SET = new Set(TARGETS);
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const VERSION = /^[1-9]\d{3}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;
const CANDIDATE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

async function json(path, label) {
  const info = await regular(path, label, 1024 * 1024);
  try {
    return { value: JSON.parse(await readFile(path, 'utf8')), info };
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

async function regular(path, label, maximum = MAX_ASSET_BYTES) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size >= maximum) {
    fail(`${label} must be a bounded regular file`);
  }
  return info;
}

async function directory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`${label} must be a directory`);
  return realpath(path);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function sourceContract(value) {
  object(value, 'source evidence');
  if (value.schemaVersion !== 1 || !VERSION.test(value.version ?? '')
    || !SHA1.test(value.sourceRevision ?? '') || !Array.isArray(value.targets)
    || value.targets.length === 0 || new Set(value.targets).size !== value.targets.length) {
    fail('source evidence has an invalid release identity');
  }
  for (const target of value.targets) if (!TARGET_SET.has(target)) fail(`unsupported source target ${target}`);
  const ordered = TARGETS.filter(target => value.targets.includes(target));
  if (JSON.stringify(value.targets) !== JSON.stringify(ordered)) fail('source targets are not canonical');
  const complete = ordered.length === TARGETS.length;
  if (value.fullRelease !== complete) fail('source fullRelease does not match selected targets');
  const trigger = object(value.trigger, 'source trigger');
  const expectedTag = `refs/tags/v${value.version}`;
  if (!['push', 'workflow_dispatch'].includes(trigger.event)
    || (trigger.ref !== 'refs/heads/main' && trigger.ref !== expectedTag)
    || trigger.signedTagVerified !== (trigger.ref === expectedTag)) {
    fail('source trigger is not bound to the verified ref');
  }
  if (trigger.event === 'push' && (trigger.ref !== expectedTag || !complete)) {
    fail('tag-triggered source must be a verified complete release');
  }
  return {
    version: value.version,
    sourceCommit: value.sourceRevision,
    targets: ordered,
    complete,
    event: trigger.event,
  };
}

function safeName(value, label) {
  if (typeof value !== 'string' || basename(value) !== value || !SAFE_NAME.test(value)) {
    fail(`${label} must be a safe basename`);
  }
  return value;
}

function inputIndexContract(value, source) {
  validateIndexShape(value);
  if (value.version !== source.version || value.sourceCommit !== source.sourceCommit) {
    fail('retained input index does not match the source');
  }
  const byTarget = new Map(value.targets.map(entry => [entry.target, entry]));
  for (const target of source.targets) {
    if (!byTarget.has(target)) fail(`retained input index does not cover ${target}`);
  }
  const names = new Set();
  for (const targetEntry of value.targets) {
    for (const part of targetEntry.archive.parts) {
      safeName(part.fileName, 'retained input archive part fileName');
      if (names.has(part.fileName)) fail(`retained input index repeats ${part.fileName}`);
      names.add(part.fileName);
    }
  }
  return { index: value, selected: source.targets.map(target => byTarget.get(target)) };
}

async function copyAndRecord(source, destination, role, target) {
  const info = await regular(source, `${role} asset`);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  return {
    role,
    path: destination,
    sha256: await sha256(destination),
    bytes: info.size,
    ...(target ? { target } : {}),
  };
}

function relativeRecord(record, root) {
  return { role: record.role, path: record.path.slice(root.length + 1), sha256: record.sha256 };
}

export function parseArgs(argv) {
  const allowed = new Set(['--source', '--input-release', '--build-root', '--output', '--candidate']);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || !value || values[key]) fail('invalid workflow assembly arguments');
    values[key] = value;
  }
  for (const required of ['--source', '--input-release', '--build-root', '--output']) {
    if (!values[required]) fail('invalid workflow assembly arguments');
  }
  if (argv.length !== (values['--candidate'] ? 10 : 8)) fail('invalid workflow assembly arguments');
  return values;
}

export async function assembleWorkflowRelease({ sourcePath, inputRelease, buildRoot, output, candidate }) {
  if (candidate !== undefined && !CANDIDATE.test(candidate)) fail('candidate must be a safe bounded identifier');
  const destination = resolve(output);
  const sourceFile = resolve(sourcePath);
  const inputs = await directory(inputRelease, 'retained input release directory');
  const builds = await directory(buildRoot, 'decrypted build root');
  const { value: sourceValue } = await json(sourceFile, 'source evidence');
  const source = sourceContract(sourceValue);
  if (source.event === 'push' && candidate) fail('tag-triggered release must not have a candidate identifier');
  if (source.event === 'workflow_dispatch' && !candidate) fail('manual release requires a candidate identifier');
  const { value: indexValue } = await json(join(inputs, 'input-index.json'), 'retained input index');
  const retained = inputIndexContract(indexValue, source);
  const expectedInputFiles = new Set(['input-index.json', ...retained.index.targets.flatMap(
    entry => entry.archive.parts.map(part => part.fileName),
  )]);
  const actualInputFiles = await readdir(inputs);
  if (actualInputFiles.some(name => !expectedInputFiles.has(name))
    || actualInputFiles.length !== expectedInputFiles.size) {
    fail('retained input release directory does not exactly match its index');
  }
  for (const input of retained.selected) await verifyIndexedArchive(inputs, input);
  await mkdir(destination, { mode: 0o700 });
  try {
    const targets = {};
    for (const target of TARGETS) {
      if (!source.targets.includes(target)) {
        targets[target] = { status: 'failed', reason: 'not selected by this manual run' };
        continue;
      }
      const stem = `yonder-${source.version}-${target}-arm64`;
      const expected = new Map([
        [`${stem}.img.xz`, 'image'],
        [`${stem}.sha256`, 'checksum'],
        [`${stem}.build.json`, 'build-manifest'],
        [`${stem}.packages.tsv`, 'packages'],
        [`${stem}.verification.json`, 'verification'],
      ]);
      const buildDirectory = join(builds, target);
      if (JSON.stringify((await readdir(buildDirectory)).sort()) !== JSON.stringify([...expected.keys()].sort())) {
        fail(`${target} decrypted build output does not contain exactly five release assets`);
      }
      const buildManifestName = `${stem}.build.json`;
      const { value: buildManifest } = await json(join(buildDirectory, buildManifestName), `${target} build manifest`);
      assertBuildInputBinding(buildManifest, retained.selected.find(entry => entry.target === target), {
        version: source.version, sourceCommit: source.sourceCommit,
      });
      const assets = [];
      for (const [name, role] of expected) {
        const record = await copyAndRecord(join(buildDirectory, name), join(destination, name), role, target);
        assets.push(relativeRecord(record, destination));
      }
      targets[target] = {
        status: 'success',
        buildManifest: `${stem}.build.json`,
        assets,
      };
    }

    const retainedDirectory = join(destination, 'inputs');
    await mkdir(retainedDirectory, { mode: 0o700 });
    const retainedInputs = [];
    for (const targetEntry of retained.selected) {
      for (const part of targetEntry.archive.parts) {
        const destinationPath = join(retainedDirectory, part.fileName);
        const record = await copyAndRecord(join(inputs, part.fileName), destinationPath, 'input-bundle');
        if (record.sha256 !== part.sha256 || record.bytes !== part.bytes) {
          fail(`retained input archive part does not match ${part.fileName}`);
        }
        retainedInputs.push(relativeRecord(record, destination));
      }
    }
    const selectedIndex = {
      schemaVersion: 2,
      kind: 'yonder-release-input-index',
      version: source.version,
      sourceCommit: source.sourceCommit,
      rebuildability: retained.index.rebuildability,
      targets: retained.selected,
    };
    const selectedIndexPath = join(retainedDirectory, 'input-index.json');
    await writeFile(selectedIndexPath, `${JSON.stringify(selectedIndex, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    retainedInputs.unshift(relativeRecord({
      role: 'input-index',
      path: selectedIndexPath,
      sha256: await sha256(selectedIndexPath),
    }, destination));
    const license = await copyAndRecord(join(REPO, 'LICENSE'), join(retainedDirectory, 'LICENSE'), 'license');
    retainedInputs.push(relativeRecord(license, destination));
    const evidence = await copyAndRecord(sourceFile, join(retainedDirectory, 'source-verification.json'), 'source-notice');
    retainedInputs.push(relativeRecord(evidence, destination));

    const manifest = {
      schemaVersion: 1,
      kind: 'yonder-image-release-set',
      version: source.version,
      sourceCommit: source.sourceCommit,
      status: source.complete ? 'complete' : 'partial',
      ...(candidate ? { candidateId: candidate } : {}),
      targets,
      retainedInputs,
    };
    await writeFile(join(destination, 'release-set.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return manifest;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = await assembleWorkflowRelease({
      sourcePath: options['--source'],
      inputRelease: options['--input-release'],
      buildRoot: options['--build-root'],
      output: options['--output'],
      ...(options['--candidate'] ? { candidate: options['--candidate'] } : {}),
    });
    process.stdout.write(`Assembled ${manifest.status} release set for ${manifest.version}\n`);
  } catch (error) {
    process.stderr.write(`workflow release assembly failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
