// SPDX-License-Identifier: GPL-3.0-or-later
// R-SEC-07: temporary Actions handoff must not expose unpublished image bytes.
import { constants, createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, open, link, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('YONDER-IMAGE-TRANSFER-1\n');
const OAEP = { padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

async function destination(path) {
  try { await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Transfer output already exists');
}

async function inputFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Transfer input must be a regular file');
  return info;
}

/** A fresh AES key per asset; only the draft job receives the RSA private key. */
export async function sealAsset(input, output, publicKey) {
  await inputFile(input);
  await destination(output);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const wrapped = publicEncrypt({ ...OAEP, key: publicKey }, key);
  if (wrapped.length < 256 || wrapped.length > 1024) throw new Error('Unsupported transfer key');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(wrapped.length);
  const header = Buffer.concat([MAGIC, length, wrapped, iv]);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const temporary = `${output}.${randomBytes(12).toString('hex')}.partial`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(header); } finally { await handle.close(); }
    await pipeline(createReadStream(input), cipher, createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
    const handleEnd = await open(temporary, 'a');
    try { await handleEnd.writeFile(cipher.getAuthTag()); await handleEnd.sync(); } finally { await handleEnd.close(); }
    await destination(output);
    await link(temporary, output);
  } finally {
    key.fill(0);
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

/** Authentication must finish before any plaintext receives a completed name. */
export async function openAsset(input, output, privateKey) {
  const info = await inputFile(input);
  await destination(output);
  const handle = await open(input, 'r');
  let header;
  let wrapped;
  let iv;
  let tag;
  try {
    const prefix = Buffer.alloc(MAGIC.length + 2);
    if ((await handle.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length
      || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid transfer envelope');
    const length = prefix.readUInt16BE(MAGIC.length);
    if (length < 256 || length > 1024 || info.size < prefix.length + length + 12 + 16) {
      throw new Error('Invalid transfer envelope');
    }
    header = Buffer.alloc(prefix.length + length + 12);
    if ((await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) throw new Error('Truncated transfer envelope');
    wrapped = header.subarray(prefix.length, prefix.length + length);
    iv = header.subarray(-12);
    tag = Buffer.alloc(16);
    if ((await handle.read(tag, 0, 16, info.size - 16)).bytesRead !== 16) throw new Error('Truncated transfer envelope');
  } finally { await handle.close(); }
  let key;
  const temporary = `${output}.${randomBytes(12).toString('hex')}.partial`;
  try {
    key = privateDecrypt({ ...OAEP, key: privateKey }, wrapped);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const stream = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    if (info.size === header.length + 16) {
      // Node's ranged read requires end >= start for the empty input case.
      const { Readable } = await import('node:stream');
      await pipeline(Readable.from([]), decipher, stream);
    } else {
      await pipeline(createReadStream(input, { start: header.length, end: info.size - 17 }), decipher, stream);
    }
    const complete = await open(temporary, 'r+');
    try { await complete.sync(); } finally { await complete.close(); }
    await destination(output);
    await link(temporary, output);
  } catch {
    throw new Error('Transfer authentication or output failed');
  } finally {
    key?.fill(0);
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
