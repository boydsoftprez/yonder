#!/usr/bin/env node
// Private board hardware-test image builder; never a release builder.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock, acquireBase } from '../lib/bases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const RUNTIME = 'debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1';
const TARGETS = {
  rpi: { label: 'Raspberry Pi 3/4/5', slug: 'rpi' },
  'radxa-zero3w': {
    label: 'Radxa ZERO 3W',
    slug: 'zero3w',
    opaqueGapSha256: 'e6d47fa7c4cd09b09004cb71f579d135107c86d6bd9fad5c4d854fcf68653269'
  },
  'radxa-rock5c': {
    label: 'ROCK 5C',
    slug: 'rock5c',
    opaqueGapSha256: 'cfb2cd548556513337f36639918e713c65565aaa247e6f312964b92c4019706c'
  }
};
const SOURCE_ENTRIES = ['package.json', 'package-lock.json', 'config', 'flows', 'systemd', 'packages', 'vendor/node', 'vendor/console', 'vendor/mediamtx', 'vendor/zerotier', 'vendor/mavlink-router', 'vendor/gst-rockchip', 'installer', 'scripts', 'image/bench'];

function usage() {
  return 'Usage: node image/bench/build.mjs --output DIRECTORY [--target rpi|radxa-zero3w|radxa-rock5c] [--storage-prototype]\nPrivate bench image with temporary SSH; --storage-prototype remains hardware and power-cut unqualified.';
}

export function sourceEntriesFor(target, storagePrototype = false) {
  if (!Object.hasOwn(TARGETS, target)) throw new Error('Unknown source target');
  const entries = target === 'rpi'
    ? [...SOURCE_ENTRIES.filter(entry => entry !== 'vendor/gst-rockchip'), 'image/pi']
    : target === 'radxa-zero3w' ? [...SOURCE_ENTRIES, 'vendor/seekerhd'] : [...SOURCE_ENTRIES];
  if (storagePrototype) entries.push('image/storage');
  if (storagePrototype && target !== 'rpi') entries.push('image/prototype');
  return entries;
}

export function parseArgs(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return { help: true };
  let output;
  let target = 'radxa-rock5c';
  let sawTarget = false;
  let storagePrototype = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--output' && output === undefined) output = args[++index];
    else if (arg === '--target' && !sawTarget) { target = args[++index]; sawTarget = true; }
    else if (arg === '--storage-prototype' && !storagePrototype) storagePrototype = true;
    else throw new Error(usage());
  }
  if (!output || !Object.hasOwn(TARGETS, target)) throw new Error(usage());
  return { help: false, output, target, storagePrototype };
}

export function backendArgsFor(target, storagePrototype) {
  if (!Object.hasOwn(TARGETS, target)) throw new Error('Unknown backend target');
  if (target === 'rpi') return [storagePrototype ? 'storage-prototype' : 'private-test'];
  return [target, storagePrototype ? 'storage-prototype' : 'bench'];
}

function isSha(value) { return /^[a-f0-9]{64}$/.test(value ?? ''); }
function isUuid(value) { return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value ?? ''); }

export function targetFacts(lock, inspection, target) {
  const profile = TARGETS[target];
  const base = lock?.targets?.[target];
  if (target === 'rpi') {
    const [boot, root] = inspection?.partitions ?? [];
    // FAT serial and disk signature were read from this exact pinned base;
    // inspect-base currently records MBR/ext4 but does not traverse FAT.
    if (base?.sha256 !== 'acff736ca7945e3b305f07cda4abdb870910e12634991da69783611756e381b3'
      || inspection?.compressedSha256 !== base.sha256 || inspection.schemaVersion !== 1 || inspection.target !== target
      || inspection.rawSha256 !== 'e235fd24fc5f039c08daba7d3abc04aecc7313f979d16d2a3fdad29dd44c33a9'
      || inspection.partitionTable !== 'mbr' || inspection.uncompressedBytes !== 2977955840
      || inspection.partitions.length !== 2 || boot.startSector !== 16384 || boot.sectorCount !== 1048576
      || boot.type !== '0x0c' || root.startSector !== 1064960 || root.sectorCount !== 4751360
      || root.type !== '0x83' || root.filesystem?.type !== 'ext4'
      || root.filesystem.uuid !== '15f4c6be-1102-4331-9904-f78e78afd1fd') {
      throw new Error('Inspection record does not match the locked rpi base');
    }
    return { target, ...profile, rawSha256: inspection.rawSha256, uncompressedBytes: inspection.uncompressedBytes,
      partitionTable: 'mbr', mbrDiskId: '0x041bba91', bootStartSector: boot.startSector,
      bootSectorCount: boot.sectorCount, bootType: boot.type, bootFilesystemUuid: 'B2F0-82D2', bootFilesystemLabel: 'bootfs',
      rootStartSector: root.startSector, rootSectorCount: root.sectorCount, rootType: root.type,
      rootFilesystemUuid: root.filesystem.uuid };
  }
  const root = inspection?.partitions?.length === 1 ? inspection.partitions[0] : undefined;
  if (!profile || !base || inspection?.schemaVersion !== 1 || inspection.target !== target ||
      inspection.compressedSha256 !== base.sha256 || !isSha(inspection.rawSha256) ||
      inspection.partitionTable !== 'gpt' || !Number.isSafeInteger(root?.startSector) ||
      root.startSector <= 34 || !isUuid(root.partitionUuid) || !isUuid(root.typeGuid) ||
      root.filesystem?.type !== 'ext4' || !isUuid(root.filesystem.uuid)) {
    throw new Error(`Inspection record does not match the locked ${target} base`);
  }
  return {
    target,
    label: profile.label,
    slug: profile.slug,
    rawSha256: inspection.rawSha256,
    opaqueGapSha256: profile.opaqueGapSha256,
    rootStartSector: root.startSector,
    rootPartitionUuid: root.partitionUuid.toLowerCase(),
    rootTypeGuid: root.typeGuid.toLowerCase(),
    rootFilesystemUuid: root.filesystem.uuid.toLowerCase()
  };
}

function run(command, values, { cwd = REPO, capture = false } = {}) {
  const result = spawnSync(command, values, { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  return capture ? result.stdout.trim() : '';
}

async function sha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  const options = parseArgs(args);
  if (options.help) { console.log(usage()); return; }

  const output = resolve(options.output);
  const sourceEntries = sourceEntriesFor(options.target, options.storagePrototype);
  const backend = options.target === 'rpi' ? 'image/pi' : 'image/bench';
  if (sourceEntries.some(entry => output === join(REPO, entry) || output.startsWith(join(REPO, entry) + '/'))) throw new Error('Output must be outside archived source directories; use image/out/NAME');
  if (existsSync(output)) throw new Error('Output directory already exists; use a fresh directory');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const scratch = join(output, '.build');
  mkdirSync(scratch, { mode: 0o700 });

  const lock = await readLock(join(REPO, 'image/bases.lock.json'));
  const inspection = JSON.parse(readFileSync(join(REPO, `image/inspection/${options.target}.json`), 'utf8'));
  const facts = targetFacts(lock, inspection, options.target);
  const base = lock.targets[options.target];
  const name = `yonder-${facts.slug}-bench-${process.pid}-${randomBytes(3).toString('hex')}`;
  let created = false;
  let stopping = false;
  function cleanup() {
    rmSync(join(scratch, 'password'), { force: true });
    if (!created || stopping) return;
    stopping = true;
    spawnSync('docker', ['exec', name, 'rm', '-f', '/work/input/password', '/target/run/yonder-bench-input/password'], { stdio: 'ignore' });
    // The private PID namespace contains only this builder. Stop its children
    // before unmounting and detaching the loop allocated to our copied file.
    spawnSync('docker', ['exec', name, '/bin/sh', '-c', 'kill -TERM -1'], { stdio: 'ignore' });
    spawnSync('docker', ['exec', name, '/bin/sh', '-c', 'kill -KILL -1'], { stdio: 'ignore' });
    const clean = spawnSync('docker', ['exec', name, '/bin/bash', '/work/cleanup.sh'], { stdio: 'inherit' });
    if (clean.status !== 0) {
      console.error(`Cleanup needs attention; retaining private container ${name} so its loop/mount state can be inspected.`);
      process.exitCode = 1;
      return;
    }
    const removed = spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    if (removed.status !== 0) { process.exitCode = 1; return; }
    created = false;
  }
  const onSigint = () => { cleanup(); process.exit(130); };
  const onSigterm = () => { cleanup(); process.exit(143); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    if (run('docker', ['info', '--format', '{{.OSType}}'], { capture: true }) !== 'linux') throw new Error('Linux Docker daemon required');
    const cached = await acquireBase(lock, options.target, join(REPO, 'vendor/image-bases'));
    const password = randomBytes(18).toString('base64url');
    writeFileSync(join(scratch, 'password'), password + '\n', { mode: 0o600 });
    run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `private-yonder-${facts.slug}-bench`, '-f', join(output, 'bench-ssh-key')]);
    const prototypeNotice = options.storagePrototype ? 'Storage prototype: fixed system/state/log partitions; final media grows to the card capacity. Owner recovery, backup and power-cut qualification remain pending.\n' : 'Writable bench filesystem: not power-cut qualified. Camera support remains hardware-unqualified.\n';
    writeFileSync(join(output, 'PRIVATE-ACCESS.txt'), `Private ${facts.label} hardware-test image; never publish these access files.\nWi-Fi: yonder\nWi-Fi password: yonder1234\nConsole: http://192.168.77.1:3000 (set the console administrator password on first visit)\nLinux account: yonder-bench\nLinux password: ${password}\nSSH: ssh -i bench-ssh-key yonder-bench@192.168.77.1\nSudo requires the Linux password. Remote root is disabled.\n${prototypeNotice}`, { mode: 0o600 });
    const sourceRevision = run('git', ['rev-parse', 'HEAD'], { capture: true });
    const sourceHasUncommittedChanges = run('git', ['status', '--porcelain'], { capture: true }) !== '';
    // The ZERO 3W camera runtime is a required payload, not a developer-board
    // side effect. tar must fail if it has not been assembled before this build.
    run('tar', ['--no-xattrs', '-cf', join(scratch, 'source.tar'), ...sourceEntries]);
    const sourceSha256 = await sha(join(scratch, 'source.tar'));
    const snapshotPackage = JSON.parse(run('tar', ['-xOf', join(scratch, 'source.tar'), 'package.json'], { capture: true }));
    // Execute scripts extracted from the exact hashed source snapshot.
    run('tar', ['-xf', join(scratch, 'source.tar'), '-C', scratch, `${backend}/build-inside.sh`, `${backend}/cleanup.sh`]);
    run('docker', ['run', '-d', '--name', name, '--platform', 'linux/arm64', '--cap-add', 'SYS_ADMIN', '--device-cgroup-rule', 'b 7:* rwm', '--device-cgroup-rule', 'b 259:* rwm', '--device-cgroup-rule', 'c 10:237 rwm', RUNTIME, 'sleep', 'infinity']);
    created = true;
    run('docker', ['exec', name, 'mkdir', '-p', '/work/input', '/work/result']);
    writeFileSync(join(scratch, 'expected-sha'), base.sha256 + '\n');
    writeFileSync(join(scratch, 'target.json'), JSON.stringify({ ...facts, storagePrototype: options.storagePrototype }, null, 2) + '\n');
    for (const [source, target] of [[join(scratch, `${backend}/cleanup.sh`), 'cleanup.sh'], [cached, 'base.img.xz'], [join(scratch, 'source.tar'), 'source.tar'], [join(scratch, 'password'), 'input/password'], [join(output, 'bench-ssh-key.pub'), 'input/authorized_key'], [join(scratch, `${backend}/build-inside.sh`), 'build-inside.sh'], [join(scratch, 'expected-sha'), 'expected-sha'], [join(scratch, 'target.json'), 'target.json']]) {
      run('docker', ['cp', source, `${name}:/work/${target}`]);
    }
    console.log(`Private builder container: ${name}`);
    const backendArgs = backendArgsFor(options.target, options.storagePrototype);
    run('docker', ['exec', name, '/bin/bash', '/work/build-inside.sh', ...backendArgs]);
    const filename = `yonder-${facts.slug}-${snapshotPackage.version}-${options.storagePrototype ? 'storage-prototype' : 'bench'}.img.xz`;
    run('docker', ['cp', `${name}:/work/result/image.img.xz`, join(output, filename + '.partial')]);
    run('docker', ['cp', `${name}:/work/result/packages.tsv`, join(output, 'packages.tsv')]);
    run('docker', ['cp', `${name}:/work/result/verification.txt`, join(output, 'verification.txt')]);
    if (options.storagePrototype && options.target !== 'rpi') {
      run('docker', ['cp', `${name}:/work/result/app-artifacts.sha256`, join(output, 'app-artifacts.sha256')]);
      run('docker', ['cp', `${name}:/work/result/layout.json`, join(output, 'layout.json')]);
    }
    const digest = await sha(join(output, filename + '.partial'));
    const expected = run('docker', ['exec', name, 'cat', '/work/result/image.sha256'], { capture: true }).split(/\s+/)[0];
    if (digest !== expected) throw new Error('Copied image checksum mismatch');
    renameSync(join(output, filename + '.partial'), join(output, filename));
    writeFileSync(join(output, 'SHA256SUMS'), `${digest}  ${filename}\n`);
    if (options.storagePrototype) renameSync(join(scratch, 'source.tar'), join(output, 'source-snapshot.tar'));
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, kind: options.storagePrototype ? 'private-storage-prototype' : 'private-hardware-test', target: options.target, hardwareQualified: false, protectedStorage: false, storagePrototype: options.storagePrototype, temporaryBenchSsh: true, base, baseInspection: facts, builderRuntime: RUNTIME, sourceRevision, sourceHasUncommittedChanges, sourceSha256, sourceSnapshot: options.storagePrototype ? 'source-snapshot.tar' : undefined, image: { fileName: filename, sha256: digest }, verification: readFileSync(join(output, 'verification.txt'), 'utf8') }, null, 2) + '\n');
    rmSync(scratch, { recursive: true, force: true });
    cleanup();
    if (created) throw new Error('Image built but builder cleanup failed');
    console.log(`Private ${facts.label} bench image: ${join(output, filename)}\nAccess instructions: ${join(output, 'PRIVATE-ACCESS.txt')}`);
  } finally {
    cleanup();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`error: ${error.message}`); process.exitCode = 1; });
}
