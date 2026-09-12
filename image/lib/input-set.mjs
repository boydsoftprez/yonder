// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const SHA = /^[a-f0-9]{64}$/;
const TARGETS = new Set(['rpi', 'radxa-zero3w', 'radxa-rock5c']);
const COMPONENTS = ['apt', 'payload', 'builder'];

async function sha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function child(root, value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')
    || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a safe relative path`);
  }
  const path = resolve(root, value);
  if (!path.startsWith(`${root}${sep}`)) throw new Error(`${label} escapes the input set`);
  return path;
}

async function regular(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`${label} must be a regular single-link file`);
  }
}

async function directory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a directory`);
}

export async function resolveInputSet(directoryPath, target) {
  if (!TARGETS.has(target)) throw new Error('Unknown image target');
  const root = resolve(directoryPath);
  await directory(root, 'Input set');
  const manifestPath = join(root, 'input-set.json');
  await regular(manifestPath, 'Input-set manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(
    ['apt', 'base', 'builder', 'kind', 'payload', 'schemaVersion', 'target'].sort(),
  ) || manifest.schemaVersion !== 1 || manifest.kind !== 'yonder-image-input-set'
    || manifest.target !== target) throw new Error('Input-set manifest does not match the target');

  const base = child(root, manifest.base?.path, 'Base path');
  await regular(base, 'Base image');
  if (!SHA.test(manifest.base?.sha256 ?? '') || await sha(base) !== manifest.base.sha256) {
    throw new Error('Base image hash does not match the input set');
  }

  const result = { root, manifest, base };
  for (const name of COMPONENTS) {
    const record = manifest[name];
    const component = child(root, record?.path, `${name} path`);
    await directory(component, `${name} input`);
    const componentManifest = child(component, record?.manifest, `${name} manifest path`);
    await regular(componentManifest, `${name} manifest`);
    if (!SHA.test(record?.manifestSha256 ?? '')
      || await sha(componentManifest) !== record.manifestSha256) {
      throw new Error(`${name} manifest hash does not match the input set`);
    }
    result[`${name}Input`] = component;
  }
  return result;
}

export async function writeInputSetManifest(directoryPath, target, expectedBaseSha256) {
  if (!TARGETS.has(target) || !SHA.test(expectedBaseSha256 ?? '')) {
    throw new Error('Cannot create an input set for an unknown target or base');
  }
  const root = resolve(directoryPath);
  await directory(root, 'Input set');
  const base = join(root, 'base.img.xz');
  await regular(base, 'Base image');
  if (await sha(base) !== expectedBaseSha256) throw new Error('Base image hash does not match the lock');
  const records = {
    apt: { path: 'apt', manifest: 'capture.json' },
    payload: { path: 'payload', manifest: 'payload-input.json' },
    builder: { path: 'builder', manifest: 'builder-input.json' },
  };
  for (const [name, record] of Object.entries(records)) {
    const component = join(root, record.path);
    await directory(component, `${name} input`);
    const manifestPath = join(component, record.manifest);
    await regular(manifestPath, `${name} manifest`);
    record.manifestSha256 = await sha(manifestPath);
  }
  const manifest = { schemaVersion: 1, kind: 'yonder-image-input-set', target,
    base: { path: 'base.img.xz', sha256: expectedBaseSha256 }, ...records };
  await writeFile(join(root, 'input-set.json'), `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 });
  return manifest;
}
