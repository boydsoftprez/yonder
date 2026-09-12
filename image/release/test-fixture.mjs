// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, opendir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const fixtureHash = value => createHash('sha256').update(value).digest('hex');

async function inventory(root, prefix = '') {
  const result = [];
  const handle = await opendir(root);
  const names = [];
  for await (const entry of handle) names.push(entry.name);
  names.sort();
  for (const name of names) {
    const path = join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(path);
    const common = { path: `files/${rel}`, mode: info.mode & 0o777 };
    if (info.isDirectory()) {
      result.push({ ...common, type: 'directory' });
      result.push(...await inventory(path, rel));
    } else if (info.isSymbolicLink()) {
      result.push({ ...common, type: 'symlink', linkTarget: await readlink(path) });
    } else {
      result.push({ ...common, type: 'file', sha256: fixtureHash(await readFile(path)),
        bytes: info.size });
    }
  }
  return result;
}

export async function makeAcceptedInputSet(root, target, sourceCommit = 'a'.repeat(40), options = {}) {
  const input = join(root, target);
  await mkdir(join(input, 'apt'), { recursive: true });
  await mkdir(join(input, 'payload'));
  await mkdir(join(input, 'builder'));
  const base = Buffer.from(`locked base:${target}`);
  const capture = `${JSON.stringify({ schemaVersion: 1, kind: 'yonder-target-apt-input', target })}\n`;
  const aptSums = `${fixtureHash(capture)}  capture.json\n`;
  await mkdir(join(input, 'payload/files/inputs/sources/application'), { recursive: true });
  await mkdir(join(input, 'payload/files/payload/application'), { recursive: true });
  const payloadFile = Buffer.from(`payload bytes:${target}`);
  const sourceTree = join(root, `.${target}-source-fixture`);
  await mkdir(join(sourceTree, 'image/pi'), { recursive: true });
  await mkdir(join(sourceTree, 'image/bench'), { recursive: true });
  await writeFile(join(sourceTree, 'image/build.mjs'), `build:${sourceCommit}\n`);
  await writeFile(join(sourceTree, 'image/finalize.sh'), `finalize:${sourceCommit}\n`);
  await writeFile(join(sourceTree, 'image/pi/build-inside.sh'), `pi:${sourceCommit}\n`);
  await writeFile(join(sourceTree, 'image/bench/build-inside.sh'), `radxa:${sourceCommit}\n`);
  const sourceArchivePath = join(input, 'payload/files/inputs/sources/application/source.tar');
  const archived = spawnSync('tar', ['-cf', sourceArchivePath, '-C', sourceTree,
    'image/build.mjs', 'image/finalize.sh', 'image/pi/build-inside.sh', 'image/bench/build-inside.sh']);
  if (archived.status !== 0) throw new Error('could not create source fixture archive');
  const sourceArchive = await readFile(sourceArchivePath);
  const applicationBundleValue = { schemaVersion: 1, kind: 'yonder-first-party-application',
    sourceCommit, sourceKind: 'git-archive', sourceArchiveSha256: fixtureHash(sourceArchive),
    platform: 'linux/arm64', toolchainImage: `tool@sha256:${'d'.repeat(64)}`,
    nodeRuntime: 'retained-payload-node', packages: [], coreProductionDependencies: [],
    offlineBuild: { status: 'verified', network: 'none', source: 'retained-git-archive',
      npmInputs: 'retained-cache-and-manifests' } };
  const applicationBundle = `${JSON.stringify(applicationBundleValue)}\n`;
  const builderFile = Buffer.from(`builder image bytes:${target}`);
  const builderManifestValue = { schemaVersion: 1, kind: 'yonder-builder-input',
    platform: 'linux/arm64', baseRuntime: `debian@sha256:${'b'.repeat(64)}`,
    imageId: `sha256:${fixtureHash(`builder:${target}`)}`, files: [
      { path: 'builder.docker.tar', sha256: fixtureHash(builderFile), bytes: builderFile.length },
    ] };
  const builderManifest = `${JSON.stringify(builderManifestValue)}\n`;
  await writeFile(join(input, 'base.img.xz'), base);
  await writeFile(join(input, 'apt/capture.json'), capture);
  await writeFile(join(input, 'apt/SHA256SUMS'), aptSums);
  await writeFile(join(input, 'payload/files/file.bin'), payloadFile);
  await writeFile(join(input, 'payload/files/payload/application/application-bundle.json'), applicationBundle);
  if (options.linkTarget) await symlink(options.linkTarget, join(input, 'payload/files/file-link'));
  if (options.longPath) {
    const longDirectory = ['a'.repeat(70), 'b'.repeat(70), 'c'.repeat(70), 'd'.repeat(70)].join('/');
    await mkdir(join(input, 'payload/files', longDirectory), { recursive: true });
    await writeFile(join(input, 'payload/files', longDirectory, 'long-file'), 'long path payload');
  }
  const files = await inventory(join(input, 'payload/files'));
  const payloadManifest = `${JSON.stringify({ schemaVersion: 1,
    kind: 'yonder-application-payload-input', target, architecture: 'linux-arm64',
    payloadReplay: { status: 'complete', root: 'files/payload' },
    applicationBundle: applicationBundleValue,
    sourceRebuild: { status: 'incomplete', gaps: [] }, files })}\n`;
  const payloadSums = [
    `${fixtureHash(payloadManifest)}  payload-input.json`,
    ...files.filter(entry => entry.type === 'file').map(entry => `${entry.sha256}  ${entry.path}`),
  ].join('\n') + '\n';
  await writeFile(join(input, 'payload/payload-input.json'), payloadManifest);
  await writeFile(join(input, 'payload/SHA256SUMS'), payloadSums);
  await writeFile(join(input, 'builder/builder.docker.tar'), builderFile);
  await writeFile(join(input, 'builder/builder-input.json'), builderManifest);
  const set = { schemaVersion: 1, kind: 'yonder-image-input-set', target,
    base: { path: 'base.img.xz', sha256: fixtureHash(base) },
    apt: { path: 'apt', manifest: 'capture.json', manifestSha256: fixtureHash(capture) },
    payload: { path: 'payload', manifest: 'payload-input.json', manifestSha256: fixtureHash(payloadManifest) },
    builder: { path: 'builder', manifest: 'builder-input.json', manifestSha256: fixtureHash(builderManifest) } };
  await writeFile(join(input, 'input-set.json'), `${JSON.stringify(set, null, 2)}\n`);
  return { input, set, builderManifest: builderManifestValue,
    aptSha256Sums: fixtureHash(aptSums), payloadManifestSha256: fixtureHash(payloadManifest),
    builderManifestSha256: fixtureHash(builderManifest) };
}
