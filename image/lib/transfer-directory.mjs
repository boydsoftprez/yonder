// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsset, sealAsset } from './artifact-envelope.mjs';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LIMIT = 2 * 1024 ** 3;
async function sha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size >= LIMIT) throw new Error('Invalid transfer file');
  return info;
}
export function validateTransferIndex(index) {
  if (index?.format !== 'yonder-private-transfer' || index.version !== 1
    || !Array.isArray(index.files) || index.files.length === 0 || index.files.length > 200) throw new Error('Invalid transfer index');
  const names = new Set();
  const blobs = new Set();
  for (const file of index.files) {
    if (!NAME.test(file.name ?? '') || file.name === 'transfer-index.json' || names.has(file.name)
      || !/^asset-\d{3}\.sealed$/.test(file.blob ?? '') || blobs.has(file.blob)
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes >= LIMIT - 2048) throw new Error('Invalid transfer file entry');
    names.add(file.name); blobs.add(file.blob);
  }
  return index;
}
export async function transferDirectory(mode, input, output, key) {
  if (!['seal', 'open'].includes(mode)) throw new Error('Unknown transfer mode');
  const inputInfo = await lstat(input);
  if (!inputInfo.isDirectory() || inputInfo.isSymbolicLink()) throw new Error('Transfer input must be a directory');
  let index;
  if (mode === 'seal') {
    const names = (await readdir(input)).sort();
    if (names.length === 0 || names.length > 200) throw new Error('Invalid transfer file count');
    index = { format: 'yonder-private-transfer', version: 1, files: [] };
    for (const [i, name] of names.entries()) {
      if (!NAME.test(name) || name === 'transfer-index.json') throw new Error('Invalid transfer filename');
      const path = join(input, name);
      const info = await regular(path);
      index.files.push({ name, blob: `asset-${String(i).padStart(3, '0')}.sealed`, bytes: info.size, sha256: await sha(path) });
    }
  } else {
    const path = join(input, 'transfer-index.json');
    const info = await regular(path);
    if (info.size > 128 * 1024) throw new Error('Transfer index too large');
    index = JSON.parse(await readFile(path, 'utf8'));
  }
  validateTransferIndex(index);
  // Fresh, private output. No caller-selected nested paths or archive extraction.
  await mkdir(output, { mode: 0o700 });
  try {
    for (const file of index.files) {
      const original = join(input, mode === 'seal' ? file.name : file.blob);
      await regular(original);
      const dest = join(output, mode === 'seal' ? file.blob : file.name);
      if (mode === 'seal') await sealAsset(original, dest, key);
      else {
        await openAsset(original, dest, key);
        const info = await regular(dest);
        if (info.size !== file.bytes || await sha(dest) !== file.sha256) throw new Error('Transfer content hash mismatch');
      }
    }
    if (mode === 'seal') await writeFile(join(output, 'transfer-index.json'), JSON.stringify(index) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await rm(output, { force: true, recursive: true });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, input, output] = process.argv.slice(2);
    if (!output || process.argv.length !== 5) throw new Error('Usage: node image/lib/transfer-directory.mjs seal|open INPUT_DIR OUTPUT_DIR');
    const key = process.env.IMAGE_TRANSFER_KEY;
    if (!key) throw new Error('Image transfer key is missing');
    delete process.env.IMAGE_TRANSFER_KEY;
    await transferDirectory(mode, resolve(input), resolve(output), key);
    console.log('Private image handoff complete');
  } catch {
    console.error('Private image handoff failed; no completed output retained');
    process.exitCode = 1;
  }
}
