#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { fileURLToPath } from 'node:url';
import { acquireBase, readLock, TARGETS } from './lib/bases.mjs';
const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log('Usage: node image/fetch-base.mjs --target TARGET --cache DIR');
} else {
  try {
    if (args.length !== 4 || args[0] !== '--target' || args[2] !== '--cache' || !TARGETS.includes(args[1]) || !args[3]) throw new Error('Usage: node image/fetch-base.mjs --target TARGET --cache DIR');
    const lock = await readLock(fileURLToPath(new URL('./bases.lock.json', import.meta.url)));
    console.log(await acquireBase(lock, args[1], args[3]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
