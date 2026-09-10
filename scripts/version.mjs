// SPDX-License-Identifier: GPL-3.0-or-later
// One CalVer for the assembled application and its first-party packages.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
const checking = process.argv[2] === '--check';
const version = checking ? read('package.json').version : process.argv[2];
if (process.argv.length !== 3 || !/^[1-9]\d{3}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(version ?? '')) {
  console.error('Usage: node scripts/version.mjs YYYY.M.RELEASE | --check (example: 2026.9.0)');
  process.exit(1);
}
const paths = ['package.json', 'installer/console/package.json', ...readdirSync(join(root, 'packages'))
  .map(name => `packages/${name}/package.json`).filter(path => existsSync(join(root, path)))];
const manifests = new Map(paths.map(path => [path, read(path)]));
const names = new Set([...manifests.values()].map(manifest => manifest.name));
const updates = new Map();
function stamp(record) {
  record.version = version;
  for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(record[kind] ?? {})) {
      if (names.has(name)) record[kind][name] = version;
    }
  }
}
for (const [path, manifest] of manifests) {
  stamp(manifest);
  updates.set(path, JSON.stringify(manifest, null, 2) + '\n');
  const lockPath = path.replace(/package\.json$/, 'package-lock.json');
  if (!existsSync(join(root, lockPath))) continue;
  const lock = read(lockPath);
  lock.version = version;
  for (const [location, record] of Object.entries(lock.packages ?? {})) {
    if (location === '' || names.has(record.name) || manifests.has(`${location}/package.json`)) stamp(record);
  }
  updates.set(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
const indexPath = 'packages/yonder-core/src/index.ts';
const index = readFileSync(join(root, indexPath), 'utf8');
if (!/^export const VERSION = "[^"]+";$/m.test(index)) throw new Error('Cannot locate the runtime VERSION export');
updates.set(indexPath, index.replace(/^export const VERSION = "[^"]+";$/m, `export const VERSION = "${version}";`));
for (const path of ['README.md', 'docs/getting-started.md']) {
  const content = readFileSync(join(root, path), 'utf8');
  const marker = /<!-- yonder:version -->[^<]+<!-- \/yonder:version -->/g;
  if (!marker.test(content)) throw new Error(`No current-version marker in ${path}`);
  updates.set(path, content.replace(marker, `<!-- yonder:version -->${version}<!-- /yonder:version -->`));
}
const changed = [...updates].filter(([path, content]) => readFileSync(join(root, path), 'utf8') !== content);
if (checking && changed.length) {
  console.error(`CalVer metadata differs from ${version}:\n${changed.map(([path]) => path).join('\n')}`);
  process.exit(1);
}
if (!checking) for (const [path, content] of changed) writeFileSync(join(root, path), content);
console.log(`${checking ? 'Verified' : 'Set'} Yonder ${version}${checking ? '' : ` (${changed.length} files updated)`}`);
