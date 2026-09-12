#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// R-HW-04/R-SEC-07: retain the exact offline inputs used by image builds.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  lstat, mkdir, mkdtemp, open, opendir, readFile, readlink, realpath, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveInputSet } from '../lib/input-set.mjs';

export const MAX_PART_BYTES = 2 * 1024 * 1024 * 1024 - 1;
const TARGETS = Object.freeze(['rpi', 'radxa-zero3w', 'radxa-rock5c']);
const TARGET_SET = new Set(TARGETS);
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^[1-9]\d{3}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/;
const OCI = /^sha256:[a-f0-9]{64}$/;
const RUNTIME = /^debian@sha256:[a-f0-9]{64}$/;
const TOOLCHAIN = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const PRIVATE = /(?:^|[._-])(?:authorized[-_]?keys?|credentials?|id_(?:rsa|dsa|ecdsa|ed25519)|password|private[-_]?key|secret|token)(?:[._-]|$)|\.(?:pem|p12|pfx)$/i;
const BLOCK = 512;

function fail(message) { throw new Error(message); }
function hashBytes(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function hashTarMember(archive, path) {
  const result = spawnSync('tar', ['-xOf', archive, path], { encoding: null, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
    fail(`first-party source archive is missing ${path}`);
  }
  return hashBytes(result.stdout);
}

function runZstd(input, output, decompress = false) {
  const result = spawnSync('zstd', ['--quiet', decompress ? '--decompress' : '-10', '-o', output, input], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail(`zstd failed: ${(result.stderr ?? '').trim()}`);
}

function safePath(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')
    || [...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(`${label} is not a safe relative path`);
  }
  for (const part of value.split('/')) if (PRIVATE.test(part)) fail(`${label} contains a private input name`);
  return value;
}

async function safeInventory(root, prefix) {
  const result = [];
  let count = 0;
  async function visit(directory, rel) {
    const handle = await opendir(directory);
    const entries = [];
    for await (const entry of handle) entries.push(entry.name);
    entries.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    for (const name of entries) {
      count += 1;
      if (count > 200_000) fail('input set contains too many entries');
      const childRel = rel ? `${rel}/${name}` : name;
      safePath(childRel, 'input path');
      const path = join(directory, name);
      const info = await lstat(path);
      const archivePath = `${prefix}/${childRel}`;
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (isAbsolute(target) || target.includes('\\')
          || [...target].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) {
          fail(`input set contains an escaping symlink: ${childRel}`);
        }
        const normalized = posix.normalize(posix.join(posix.dirname(childRel), target));
        if (normalized === '..' || normalized.startsWith('../')) {
          fail(`input set contains an escaping symlink: ${childRel}`);
        }
        result.push({ path: archivePath, type: 'symlink', mode: info.mode & 0o777, linkTarget: target });
      } else if (info.isDirectory()) {
        result.push({ path: archivePath, type: 'directory', mode: info.mode & 0o777 });
        await visit(path, childRel);
      } else if (info.isFile() && info.nlink === 1) {
        result.push({ path: archivePath, type: 'file', mode: info.mode & 0o777,
          bytes: info.size, sha256: await hashFile(path), source: path });
      } else {
        fail(`input set contains a special or hard-linked file: ${childRel}`);
      }
    }
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('input set must be a directory');
  result.push({ path: prefix, type: 'directory', mode: rootInfo.mode & 0o777 });
  await visit(root, '');
  return result;
}

function publicInventory(entries) {
  return entries.map(({ source: _source, ...entry }) => entry);
}

function parseSums(value, label) {
  const result = new Map();
  for (const [index, line] of value.trimEnd().split('\n').entries()) {
    if (line.length < 67 || line.slice(64, 66) !== '  ' || !SHA.test(line.slice(0, 64))) {
      fail(`${label} has an invalid line ${index + 1}`);
    }
    const path = safePath(line.slice(66), `${label} path`);
    if (result.has(path)) fail(`${label} repeats ${path}`);
    result.set(path, line.slice(0, 64));
  }
  return result;
}

async function validateChecksums(root, sumsName, excluded, label) {
  const sumsPath = join(root, sumsName);
  const sums = parseSums(await readFile(sumsPath, 'utf8'), label);
  const inventory = await safeInventory(root, '_validation');
  const files = inventory.filter(entry => entry.type === 'file')
    .map(entry => entry.path.slice('_validation/'.length)).filter(path => !excluded.has(path));
  if (JSON.stringify([...sums.keys()].sort()) !== JSON.stringify(files.sort())) {
    fail(`${label} does not exactly cover regular files`);
  }
  for (const [path, expected] of sums) if (await hashFile(join(root, path)) !== expected) {
    fail(`${label} hash does not match ${path}`);
  }
  return hashFile(sumsPath);
}

async function inputIdentity(inputRoot, target, sourceCommit) {
  const resolved = await resolveInputSet(inputRoot, target);
  const manifestPath = join(resolved.root, 'input-set.json');
  const aptManifestPath = join(resolved.aptInput, resolved.manifest.apt.manifest);
  const payloadManifestPath = join(resolved.payloadInput, resolved.manifest.payload.manifest);
  const builderManifestPath = join(resolved.builderInput, resolved.manifest.builder.manifest);
  const aptManifest = JSON.parse(await readFile(aptManifestPath, 'utf8'));
  if (aptManifest.target !== target) fail('APT manifest target does not match the input set');
  const payloadManifest = JSON.parse(await readFile(payloadManifestPath, 'utf8'));
  if (payloadManifest.kind !== 'yonder-application-payload-input' || payloadManifest.target !== target
    || payloadManifest.architecture !== 'linux-arm64' || payloadManifest.payloadReplay?.status !== 'complete'
    || payloadManifest.sourceRebuild?.status !== 'incomplete'
    || payloadManifest.applicationBundle?.sourceCommit !== sourceCommit
    || payloadManifest.applicationBundle?.sourceKind !== 'git-archive'
    || !SHA.test(payloadManifest.applicationBundle?.sourceArchiveSha256 ?? '')) {
    fail('payload manifest does not match the retained replay contract');
  }
  const sourceArchive = join(resolved.payloadInput, 'files/inputs/sources/application/source.tar');
  const applicationBundlePath = join(resolved.payloadInput, 'files/payload/application/application-bundle.json');
  const applicationBundle = JSON.parse(await readFile(applicationBundlePath, 'utf8'));
  if (await hashFile(sourceArchive) !== payloadManifest.applicationBundle.sourceArchiveSha256
    || JSON.stringify(canonical(applicationBundle)) !== JSON.stringify(canonical(payloadManifest.applicationBundle))
    || !TOOLCHAIN.test(applicationBundle.toolchainImage ?? '')
    || JSON.stringify(canonical(applicationBundle.offlineBuild)) !== JSON.stringify(canonical({
      status: 'verified', network: 'none', source: 'retained-git-archive',
      npmInputs: 'retained-cache-and-manifests' }))) {
    fail('retained first-party source does not match the application bundle');
  }
  const payloadFiles = publicInventory(await safeInventory(join(resolved.payloadInput, 'files'), 'files'))
    .filter(entry => entry.path !== 'files');
  if (!Array.isArray(payloadManifest.files)
    || JSON.stringify(canonical(payloadFiles)) !== JSON.stringify(canonical(payloadManifest.files))) {
    fail('payload manifest inventory does not match retained files');
  }
  const backend = target === 'rpi' ? 'image/pi/build-inside.sh' : 'image/bench/build-inside.sh';
  const buildTools = { outerBuilderSha256: hashTarMember(sourceArchive, 'image/build.mjs'),
    targetBackendSha256: hashTarMember(sourceArchive, backend),
    finalizerSha256: hashTarMember(sourceArchive, 'image/finalize.sh') };
  const builderManifest = JSON.parse(await readFile(builderManifestPath, 'utf8'));
  if (builderManifest.kind !== 'yonder-builder-input' || builderManifest.platform !== 'linux/arm64'
    || !OCI.test(builderManifest.imageId ?? '') || !RUNTIME.test(builderManifest.baseRuntime ?? '')
    || !Array.isArray(builderManifest.files) || builderManifest.files.length === 0) {
    fail('builder manifest does not match the ARM64 builder contract');
  }
  const builderActual = await safeInventory(resolved.builderInput, '_validation');
  const actualByPath = new Map(builderActual.filter(entry => entry.type === 'file')
    .map(entry => [entry.path.slice('_validation/'.length), entry]));
  actualByPath.delete(resolved.manifest.builder.manifest);
  if (builderManifest.files.length !== actualByPath.size) fail('builder manifest inventory does not match');
  for (const entry of builderManifest.files) {
    const path = safePath(entry?.path, 'builder manifest path');
    const actual = actualByPath.get(path);
    if (!actual || entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256) {
      fail(`builder manifest inventory does not match ${path}`);
    }
  }
  if (!actualByPath.has('builder.docker.tar')) fail('builder image archive is not retained');
  return {
    resolved,
    inputSetManifestSha256: await hashFile(manifestPath),
    components: {
      base: { sha256: resolved.manifest.base.sha256, bytes: (await stat(resolved.base)).size },
      apt: { manifestSha256: resolved.manifest.apt.manifestSha256,
        sha256SumsSha256: await validateChecksums(resolved.aptInput, 'SHA256SUMS', new Set(['SHA256SUMS']), 'APT SHA256SUMS') },
      payload: { manifestSha256: resolved.manifest.payload.manifestSha256,
        sha256SumsSha256: await validateChecksums(resolved.payloadInput, 'SHA256SUMS', new Set(['SHA256SUMS']), 'payload SHA256SUMS'),
        replayStatus: 'complete', sourceRebuildStatus: 'incomplete', sourceCommit,
        sourceArchiveSha256: payloadManifest.applicationBundle.sourceArchiveSha256,
        applicationBundleSha256: await hashFile(applicationBundlePath),
        applicationToolchainImage: applicationBundle.toolchainImage, buildTools },
      builder: { manifestSha256: resolved.manifest.builder.manifestSha256,
        imageId: builderManifest.imageId, baseRuntime: builderManifest.baseRuntime },
    },
  };
}

function putString(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) fail(`tar field is too long: ${value}`);
  bytes.copy(buffer, offset);
}
function putOctal(buffer, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) fail('tar numeric field is too large');
  putString(buffer, offset, length, `${encoded}\0`);
}
function splitUstarPath(path) {
  const bytes = Buffer.byteLength(path);
  if (bytes <= 100) return { name: path, prefix: '' };
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return null;
}
function tarHeader({ path, type, mode, bytes = 0, linkTarget = '' }) {
  const header = Buffer.alloc(BLOCK);
  const split = splitUstarPath(path);
  if (!split) fail(`tar path cannot be represented: ${path}`);
  putString(header, 0, 100, split.name);
  putOctal(header, 100, 8, mode);
  putOctal(header, 108, 8, 0);
  putOctal(header, 116, 8, 0);
  putOctal(header, 124, 12, bytes);
  putOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type === 'directory' ? 0x35 : type === 'symlink' ? 0x32 : type === 'pax' ? 0x78 : 0x30;
  putString(header, 157, 100, linkTarget);
  putString(header, 257, 6, 'ustar\0');
  putString(header, 263, 2, '00');
  putString(header, 265, 32, 'root');
  putString(header, 297, 32, 'root');
  putString(header, 345, 155, split.prefix);
  putOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
  return header;
}

function paxLine(key, value) {
  let length = Buffer.byteLength(`${key}=${value}\n`) + 2;
  while (true) {
    const record = `${length} ${key}=${value}\n`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return record;
    length = actual;
  }
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += (await handle.write(buffer, offset)).bytesWritten;
}

async function createTar(entries, path) {
  const handle = await open(path, 'wx', 0o600);
  const tarHash = createHash('sha256');
  let bytes = 0;
  const emit = async buffer => { await writeAll(handle, buffer); tarHash.update(buffer); bytes += buffer.length; };
  try {
    for (const entry of entries) {
      const pax = [];
      if (!splitUstarPath(entry.path)) pax.push(paxLine('path', entry.path));
      if (entry.type === 'symlink' && Buffer.byteLength(entry.linkTarget) > 100) {
        pax.push(paxLine('linkpath', entry.linkTarget));
      }
      if (pax.length > 0) {
        const payload = Buffer.from(pax.join(''));
        const paxPath = `PaxHeaders/${hashBytes(entry.path).slice(0, 32)}`;
        await emit(tarHeader({ path: paxPath, type: 'pax', mode: 0o600, bytes: payload.length }));
        await emit(payload);
        const padding = (BLOCK - (payload.length % BLOCK)) % BLOCK;
        if (padding) await emit(Buffer.alloc(padding));
      }
      const headerEntry = { ...entry,
        path: splitUstarPath(entry.path) ? entry.path : `LongPaths/${hashBytes(entry.path).slice(0, 32)}`,
        linkTarget: entry.type === 'symlink' && Buffer.byteLength(entry.linkTarget) > 100 ? '' : entry.linkTarget };
      await emit(tarHeader(headerEntry));
      if (entry.type === 'file') {
        for await (const chunk of createReadStream(entry.source)) await emit(chunk);
        const padding = (BLOCK - (entry.bytes % BLOCK)) % BLOCK;
        if (padding) await emit(Buffer.alloc(padding));
      }
    }
    await emit(Buffer.alloc(BLOCK * 2));
  } finally {
    await handle.close();
  }
  return { sha256: tarHash.digest('hex'), bytes };
}

async function splitArchive(path, output, target, maximumPartBytes) {
  const parts = [];
  const aggregate = createHash('sha256');
  let aggregateBytes = 0;
  let number = 0;
  let handle;
  let partHash;
  let partBytes = 0;
  const close = async () => {
    if (!handle) return;
    await handle.close();
    const fileName = `${target}.inputs.tar.zst.part${String(number).padStart(3, '0')}`;
    parts.push({ fileName, sha256: partHash.digest('hex'), bytes: partBytes });
    handle = undefined;
    number += 1;
    partBytes = 0;
  };
  for await (const sourceChunk of createReadStream(path)) {
    let offset = 0;
    aggregate.update(sourceChunk);
    aggregateBytes += sourceChunk.length;
    while (offset < sourceChunk.length) {
      if (!handle) {
        const name = `${target}.inputs.tar.zst.part${String(number).padStart(3, '0')}`;
        handle = await open(join(output, name), 'wx', 0o600);
        partHash = createHash('sha256');
      }
      const length = Math.min(maximumPartBytes - partBytes, sourceChunk.length - offset);
      const chunk = sourceChunk.subarray(offset, offset + length);
      await writeAll(handle, chunk);
      partHash.update(chunk);
      partBytes += length;
      offset += length;
      if (partBytes === maximumPartBytes) await close();
    }
  }
  await close();
  if (parts.length === 0) fail('compressed input archive is empty');
  return { parts, sha256: aggregate.digest('hex'), bytes: aggregateBytes };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) fail(`${label} has invalid fields`);
}

export function validateIndexShape(value) {
  exactKeys(value, ['schemaVersion', 'kind', 'version', 'sourceCommit', 'rebuildability', 'targets'], 'input index');
  if (value.schemaVersion !== 2 || value.kind !== 'yonder-release-input-index'
    || !VERSION.test(value.version ?? '') || !COMMIT.test(value.sourceCommit ?? '')
    || !Array.isArray(value.targets) || value.targets.length === 0) fail('input index identity is invalid');
  exactKeys(value.rebuildability, ['status', 'retained', 'source', 'limitations'], 'rebuildability');
  exactKeys(value.rebuildability.source,
    ['commit', 'firstPartyArchiveRetained', 'buildSnapshotRetained'], 'rebuildability source');
  if (value.rebuildability.status !== 'incomplete'
    || JSON.stringify(value.rebuildability.retained) !== JSON.stringify([
      'locked-base-image', 'target-apt-input', 'application-payload-input', 'arm64-builder-image'])
    || value.rebuildability.source?.commit !== value.sourceCommit
    || value.rebuildability.source?.firstPartyArchiveRetained !== true
    || value.rebuildability.source?.buildSnapshotRetained !== false
    || JSON.stringify(value.rebuildability.limitations) !== JSON.stringify([
      'build-source-snapshot-not-retained', 'payload-source-rebuild-incomplete'])) {
    fail('input index rebuildability statement is invalid');
  }
  const seen = new Set();
  for (const entry of value.targets) {
    exactKeys(entry, ['target', 'inputSetManifestSha256', 'components', 'archive'], 'target input');
    if (!TARGET_SET.has(entry.target) || seen.has(entry.target) || !SHA.test(entry.inputSetManifestSha256 ?? '')) {
      fail('target input identity is invalid');
    }
    seen.add(entry.target);
    const c = entry.components;
    exactKeys(c, ['base', 'apt', 'payload', 'builder'], 'target components');
    exactKeys(c.base, ['sha256', 'bytes'], 'base component');
    exactKeys(c.apt, ['manifestSha256', 'sha256SumsSha256'], 'APT component');
    exactKeys(c.payload, ['manifestSha256', 'sha256SumsSha256', 'replayStatus', 'sourceRebuildStatus',
      'sourceCommit', 'sourceArchiveSha256', 'applicationBundleSha256', 'applicationToolchainImage',
      'buildTools'], 'payload component');
    exactKeys(c.payload.buildTools, ['outerBuilderSha256', 'targetBackendSha256', 'finalizerSha256'], 'source build tools');
    exactKeys(c.builder, ['manifestSha256', 'imageId', 'baseRuntime'], 'builder component');
    if (![c.base.sha256, c.apt.manifestSha256, c.apt.sha256SumsSha256,
      c.payload.manifestSha256, c.payload.sha256SumsSha256, c.payload.sourceArchiveSha256,
      c.payload.applicationBundleSha256, c.builder.manifestSha256].every(v => SHA.test(v ?? ''))
      || !Number.isSafeInteger(c.base.bytes) || c.base.bytes <= 0 || c.payload.replayStatus !== 'complete'
      || c.payload.sourceRebuildStatus !== 'incomplete' || c.payload.sourceCommit !== value.sourceCommit
      || !TOOLCHAIN.test(c.payload.applicationToolchainImage ?? '')
      || !OCI.test(c.builder.imageId ?? '')
      || !RUNTIME.test(c.builder.baseRuntime ?? '')) fail('target component identity is invalid');
    if (!Object.values(c.payload.buildTools).every(value => SHA.test(value ?? ''))) {
      fail('source build tool identity is invalid');
    }
    const archive = entry.archive;
    exactKeys(archive, ['format', 'inventorySha256', 'entryCount', 'uncompressedSha256',
      'uncompressedBytes', 'compressedSha256', 'compressedBytes', 'parts'], 'target archive');
    if (archive.format !== 'tar+zstd-split-v1' || !SHA.test(archive.inventorySha256 ?? '')
      || !SHA.test(archive.uncompressedSha256 ?? '') || !SHA.test(archive.compressedSha256 ?? '')
      || !Number.isSafeInteger(archive.entryCount) || archive.entryCount <= 0
      || !Number.isSafeInteger(archive.uncompressedBytes) || archive.uncompressedBytes <= 0
      || !Number.isSafeInteger(archive.compressedBytes) || archive.compressedBytes <= 0
      || !Array.isArray(archive.parts) || archive.parts.length === 0) fail('target archive identity is invalid');
    let total = 0;
    for (const [index, part] of archive.parts.entries()) {
      exactKeys(part, ['fileName', 'sha256', 'bytes'], 'archive part');
      if (part.fileName !== `${entry.target}.inputs.tar.zst.part${String(index).padStart(3, '0')}`
        || !SHA.test(part.sha256 ?? '') || !Number.isSafeInteger(part.bytes) || part.bytes <= 0
        || part.bytes > MAX_PART_BYTES) fail('archive part identity is invalid');
      total += part.bytes;
    }
    if (total !== archive.compressedBytes) fail('archive part sizes do not match the compressed archive');
  }
  const ordered = TARGETS.filter(target => seen.has(target));
  if (JSON.stringify(value.targets.map(entry => entry.target)) !== JSON.stringify(ordered)) {
    fail('input index targets are not canonical');
  }
  return value;
}

export function assertBuildInputBinding(value, targetEntry, { version, sourceCommit }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
    || value.kind !== 'release-image' || value.target !== targetEntry.target || value.version !== version
    || value.sourceRevision !== sourceCommit || value.sourceHasUncommittedChanges !== false
    || value.protectedStorage !== true || value.temporaryBenchSsh !== false
    || !SHA.test(value.inputSetId ?? '') || !SHA.test(value.base?.sha256 ?? '')
    || !SHA.test(value.inputs?.aptSha256Sums ?? '')
    || !SHA.test(value.inputs?.payloadManifestSha256 ?? '')
    || !SHA.test(value.inputs?.builderManifestSha256 ?? '')
    || !SHA.test(value.inputs?.sourceSnapshotSha256 ?? '')
    || !OCI.test(value.builderImageId ?? '')) fail(`${targetEntry.target} build manifest has an invalid input identity`);
  const components = targetEntry.components;
  if (value.base.sha256 !== components.base.sha256
    || value.inputs.aptSha256Sums !== components.apt.sha256SumsSha256
    || value.inputs.payloadManifestSha256 !== components.payload.manifestSha256
    || value.inputs.builderManifestSha256 !== components.builder.manifestSha256
    || value.builderImageId !== components.builder.imageId
    || JSON.stringify(value.buildTools) !== JSON.stringify(components.payload.buildTools)) {
    fail(`${targetEntry.target} build manifest does not match its retained input archive`);
  }
  const expected = createHash('sha256').update(
    `${components.base.sha256}\n${components.apt.sha256SumsSha256}\n`
      + `${components.payload.manifestSha256}\n${components.builder.manifestSha256}\n`
      + `${value.inputs.sourceSnapshotSha256}\n`,
  ).digest('hex');
  if (value.inputSetId !== expected) fail(`${targetEntry.target} build manifest inputSetId is invalid`);
}

async function parseTar(path) {
  const handle = await open(path, 'r');
  const entries = [];
  let position = 0;
  let zeroBlocks = 0;
  let pendingPax = null;
  try {
    while (true) {
      const header = Buffer.alloc(BLOCK);
      const { bytesRead } = await handle.read(header, 0, BLOCK, position);
      if (bytesRead !== BLOCK) fail('input tar is truncated');
      position += BLOCK;
      if (header.every(byte => byte === 0)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) break;
        continue;
      }
      zeroBlocks = 0;
      const stored = Number.parseInt(header.toString('ascii', 148, 156).replace(/[\0 ]/g, ''), 8);
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      if (!Number.isSafeInteger(stored) || stored !== [...checksumHeader].reduce((sum, byte) => sum + byte, 0)) {
        fail('input tar header checksum is invalid');
      }
      const field = (start, end) => header.toString('utf8', start, end).replace(/\0.*$/s, '');
      const name = field(0, 100);
      const prefix = field(345, 500);
      const pathValue = prefix ? `${prefix}/${name}` : name;
      const number = (start, end) => Number.parseInt(field(start, end).trim() || '0', 8);
      const mode = number(100, 108);
      const uid = number(108, 116);
      const gid = number(116, 124);
      const bytes = number(124, 136);
      const mtime = number(136, 148);
      const typeByte = header[156];
      if (![mode, uid, gid, bytes, mtime].every(Number.isSafeInteger) || uid !== 0 || gid !== 0 || mtime !== 0
        || ![0, 0x30, 0x32, 0x35, 0x78].includes(typeByte)) fail('input tar contains unsafe metadata or type');
      if (typeByte === 0x78) {
        if (pendingPax || bytes > 16 * 1024) fail('input tar has invalid PAX metadata');
        const payload = Buffer.alloc(bytes);
        if ((await handle.read(payload, 0, bytes, position)).bytesRead !== bytes) fail('input tar PAX data is truncated');
        pendingPax = {};
        let offset = 0;
        while (offset < payload.length) {
          const space = payload.indexOf(0x20, offset);
          if (space < 0) fail('input tar PAX record is invalid');
          const length = Number.parseInt(payload.toString('ascii', offset, space), 10);
          const record = payload.toString('utf8', space + 1, offset + length - 1);
          if (!Number.isSafeInteger(length) || length <= 0 || offset + length > payload.length) fail('input tar PAX record is invalid');
          const equals = record.indexOf('=');
          if (equals < 1 || !['path', 'linkpath'].includes(record.slice(0, equals))) fail('input tar PAX key is unsupported');
          pendingPax[record.slice(0, equals)] = record.slice(equals + 1);
          offset += length;
        }
        position += bytes + ((BLOCK - (bytes % BLOCK)) % BLOCK);
        continue;
      }
      const finalPath = pendingPax?.path ?? pathValue;
      const path = safePath(typeByte === 0x35 ? finalPath.replace(/\/$/, '') : finalPath, 'tar path');
      if (entries.some(entry => entry.path === path)) fail(`input tar repeats ${path}`);
      const type = typeByte === 0x35 ? 'directory' : typeByte === 0x32 ? 'symlink' : 'file';
      const entry = { path, type, mode };
      if (entry.type === 'file') {
        const digest = createHash('sha256');
        let remaining = bytes;
        let cursor = position;
        while (remaining > 0) {
          const buffer = Buffer.alloc(Math.min(1024 * 1024, remaining));
          const read = await handle.read(buffer, 0, buffer.length, cursor);
          if (read.bytesRead !== buffer.length) fail('input tar file data is truncated');
          digest.update(buffer); cursor += buffer.length; remaining -= buffer.length;
        }
        entry.bytes = bytes;
        entry.sha256 = digest.digest('hex');
      } else if (entry.type === 'symlink') {
        if (bytes !== 0) fail('input tar symlink has data');
        const target = pendingPax?.linkpath ?? field(157, 257);
        if (isAbsolute(target) || target.includes('\\')
          || [...target].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) {
          fail('input tar has an escaping symlink');
        }
        const relativePath = path.slice(path.indexOf('/') + 1);
        const normalized = posix.normalize(posix.join(posix.dirname(relativePath), target));
        if (normalized === '..' || normalized.startsWith('../')) fail('input tar has an escaping symlink');
        entry.linkTarget = target;
      } else if (bytes !== 0) fail('input tar directory has data');
      entries.push(entry);
      pendingPax = null;
      position += bytes + ((BLOCK - (bytes % BLOCK)) % BLOCK);
    }
    if (pendingPax) fail('input tar ends with unused PAX metadata');
    const info = await handle.stat();
    if (position !== info.size) fail('input tar has trailing data');
  } finally { await handle.close(); }
  return entries;
}

function archived(entries, target, path) {
  const match = entries.find(entry => entry.path === `${target}/${path}`);
  if (!match || match.type !== 'file') fail(`input archive is missing ${target}/${path}`);
  return match;
}

export async function verifyIndexedArchive(directory, targetEntry) {
  const sourceCommit = targetEntry?.components?.payload?.sourceCommit;
  validateIndexShape({ schemaVersion: 2, kind: 'yonder-release-input-index', version: '2026.1.0',
    sourceCommit, rebuildability: { status: 'incomplete',
      retained: ['locked-base-image', 'target-apt-input', 'application-payload-input', 'arm64-builder-image'],
      source: { commit: sourceCommit, firstPartyArchiveRetained: true, buildSnapshotRetained: false },
      limitations: ['build-source-snapshot-not-retained', 'payload-source-rebuild-incomplete'] },
    targets: [targetEntry] });
  const scratch = await mkdtemp(join(tmpdir(), 'yonder-input-verify-'));
  const compressed = join(scratch, 'input.tar.zst');
  const tar = join(scratch, 'input.tar');
  let output;
  try {
    output = await open(compressed, 'wx', 0o600);
    const aggregate = createHash('sha256');
    let total = 0;
    for (const part of targetEntry.archive.parts) {
      const path = join(directory, part.fileName);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== part.bytes
        || await hashFile(path) !== part.sha256) fail(`archive part hash or size does not match ${part.fileName}`);
      for await (const chunk of createReadStream(path)) {
        aggregate.update(chunk); total += chunk.length; await writeAll(output, chunk);
      }
    }
    await output.close();
    output = undefined;
    if (total !== targetEntry.archive.compressedBytes || aggregate.digest('hex') !== targetEntry.archive.compressedSha256) {
      fail('compressed archive identity does not match');
    }
    runZstd(compressed, tar, true);
    const tarInfo = await stat(tar);
    if (tarInfo.size !== targetEntry.archive.uncompressedBytes || await hashFile(tar) !== targetEntry.archive.uncompressedSha256) {
      fail('uncompressed archive identity does not match');
    }
    const entries = await parseTar(tar);
    if (entries.length !== targetEntry.archive.entryCount
      || hashBytes(JSON.stringify(entries)) !== targetEntry.archive.inventorySha256) fail('input archive inventory does not match');
    const setEntry = archived(entries, targetEntry.target, 'input-set.json');
    if (setEntry.sha256 !== targetEntry.inputSetManifestSha256) fail('archived input-set manifest does not match');
    const c = targetEntry.components;
    if (archived(entries, targetEntry.target, 'base.img.xz').sha256 !== c.base.sha256
      || archived(entries, targetEntry.target, 'base.img.xz').bytes !== c.base.bytes
      || archived(entries, targetEntry.target, 'apt/capture.json').sha256 !== c.apt.manifestSha256
      || archived(entries, targetEntry.target, 'apt/SHA256SUMS').sha256 !== c.apt.sha256SumsSha256
      || archived(entries, targetEntry.target, 'payload/payload-input.json').sha256 !== c.payload.manifestSha256
      || archived(entries, targetEntry.target, 'payload/SHA256SUMS').sha256 !== c.payload.sha256SumsSha256
      || archived(entries, targetEntry.target, 'payload/files/inputs/sources/application/source.tar').sha256 !== c.payload.sourceArchiveSha256
      || archived(entries, targetEntry.target, 'payload/files/payload/application/application-bundle.json').sha256 !== c.payload.applicationBundleSha256
      || archived(entries, targetEntry.target, 'builder/builder-input.json').sha256 !== c.builder.manifestSha256) {
      fail('archived component identity does not match the input index');
    }
    return entries;
  } finally {
    if (output) await output.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function generateInputBundles({ inputRoot, output, version, sourceCommit, targets = TARGETS,
  maximumPartBytes = MAX_PART_BYTES }) {
  if (!VERSION.test(version ?? '') || !COMMIT.test(sourceCommit ?? '')
    || !Array.isArray(targets) || targets.length === 0 || new Set(targets).size !== targets.length
    || targets.some(target => !TARGET_SET.has(target)) || !Number.isSafeInteger(maximumPartBytes)
    || maximumPartBytes < 128 || maximumPartBytes > MAX_PART_BYTES) fail('invalid input bundle arguments');
  const selected = TARGETS.filter(target => targets.includes(target));
  const root = await realpath(inputRoot);
  const destination = resolve(output);
  for (const target of selected) {
    const source = resolve(root, target);
    const fromSource = relative(source, destination);
    const fromDestination = relative(destination, source);
    if (fromSource === '' || (!fromSource.startsWith(`..${sep}`) && fromSource !== '..')
      || (!fromDestination.startsWith(`..${sep}`) && fromDestination !== '..')) {
      fail('output must not overlap a target input set');
    }
  }
  await mkdir(destination, { mode: 0o700 });
  const scratch = await mkdtemp(join(tmpdir(), 'yonder-input-bundle-build-'));
  try {
    const targetRecords = [];
    for (const target of selected) {
      const identity = await inputIdentity(join(root, target), target, sourceCommit);
      const inventory = await safeInventory(identity.resolved.root, target);
      const publicEntries = publicInventory(inventory);
      const tar = join(scratch, `${target}.tar`);
      const compressed = join(scratch, `${target}.tar.zst`);
      const tarIdentity = await createTar(inventory, tar);
      runZstd(tar, compressed);
      const split = await splitArchive(compressed, destination, target, maximumPartBytes);
      targetRecords.push({ target, inputSetManifestSha256: identity.inputSetManifestSha256,
        components: identity.components,
        archive: { format: 'tar+zstd-split-v1', inventorySha256: hashBytes(JSON.stringify(publicEntries)),
          entryCount: publicEntries.length, uncompressedSha256: tarIdentity.sha256,
          uncompressedBytes: tarIdentity.bytes, compressedSha256: split.sha256,
          compressedBytes: split.bytes, parts: split.parts } });
    }
    const index = validateIndexShape({ schemaVersion: 2, kind: 'yonder-release-input-index', version,
      sourceCommit, rebuildability: { status: 'incomplete',
        retained: ['locked-base-image', 'target-apt-input', 'application-payload-input', 'arm64-builder-image'],
        source: { commit: sourceCommit, firstPartyArchiveRetained: true, buildSnapshotRetained: false },
        limitations: ['build-source-snapshot-not-retained', 'payload-source-rebuild-incomplete'] },
      targets: targetRecords });
    await writeFile(join(destination, 'input-index.json'), `${JSON.stringify(index, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
    return index;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

function parseArgs(argv) {
  const values = { targets: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!value || !['--input-root', '--output', '--version', '--source', '--target'].includes(key)) fail('invalid arguments');
    if (key === '--target') values.targets.push(value);
    else if (values[key]) fail('invalid arguments');
    else values[key] = value;
  }
  if (!values['--input-root'] || !values['--output'] || !values['--version'] || !values['--source']) fail('invalid arguments');
  if (values.targets.length === 0) values.targets = [...TARGETS];
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  generateInputBundles({ inputRoot: options['--input-root'], output: options['--output'],
    version: options['--version'], sourceCommit: options['--source'], targets: options.targets })
    .then(index => process.stdout.write(`Retained ${index.targets.length} target input archives\n`))
    .catch(error => { process.stderr.write(`input bundle generation failed: ${error.message}\n`); process.exitCode = 1; });
}
