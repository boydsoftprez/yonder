// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, 'build.mjs');

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitFor(path, pattern) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await readFile(path, 'utf8').catch(() => '');
    if (pattern.test(value)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${pattern}`);
}

async function cancellationCase(signal, cleanupFails) {
  const root = await mkdtemp(join(tmpdir(), 'yonder-build-cancel-'));
  try {
    const bin = join(root, 'bin');
    const output = join(root, 'output');
    const log = join(root, 'docker.log');
    const containers = join(root, 'containers');
    await mkdir(bin);
    await writeFile(containers, 'owned-fixture\nunrelated-fixture\n');
    const docker = join(bin, 'docker');
    await writeFile(docker, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$DOCKER_LOG"
if [ "$1" = exec ] && [ "$3" = /bin/bash ] && [ "$4" = /work/build-inside.sh ]; then
  printf '%s\\n' BUILD_STARTED >>"$DOCKER_LOG"
  trap 'exit 143' TERM
  trap 'exit 130' INT
  while :; do sleep 1; done
fi
if [ "$1" = exec ] && [ "$3" = /bin/bash ] && [ "$4" = /work/cleanup.sh ] \
    && [ "\${FAIL_CLEANUP:-0}" = 1 ]; then
  exit 1
fi
if [ "$1" = rm ] && [ "$2" = -f ]; then
  grep -vxF "$3" "$CONTAINER_STATE" >"$CONTAINER_STATE.new"
  mv "$CONTAINER_STATE.new" "$CONTAINER_STATE"
fi
exit 0
`);
    await chmod(docker, 0o755);
    const runner = join(root, 'runner.mjs');
    await writeFile(runner, `
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cleanupOwnedContainer, InterruptedBuildError, runInterruptible } from ${JSON.stringify(pathToFileURL(BUILD).href)};
const name = 'owned-fixture';
const output = process.env.TEST_OUTPUT;
mkdirSync(output);
writeFileSync(output + '/looks-successful.img.xz', 'partial');
let created = true;
let cleaning = false;
const cleanup = () => {
  if (!created || cleaning) return;
  cleaning = true;
  if (cleanupOwnedContainer(name)) created = false;
};
try {
  await runInterruptible('docker', ['exec', name, '/bin/bash', '/work/build-inside.sh', 'production'], {
    onInterrupt: () => {
      cleanup();
      rmSync(output, { recursive: true, force: true });
    },
  });
} catch (error) {
  if (error instanceof InterruptedBuildError) process.exitCode = error.exitCode;
  else throw error;
} finally {
  cleanup();
}
`);
    const child = spawn(process.execPath, [runner], { env: { ...process.env,
      PATH: `${bin}:${process.env.PATH}`, DOCKER_LOG: log, TEST_OUTPUT: output,
      CONTAINER_STATE: containers, FAIL_CLEANUP: cleanupFails ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    await waitFor(log, /BUILD_STARTED/);
    const started = Date.now();
    child.kill(signal);
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, childSignal) => resolve({ code, childSignal }));
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancelled build did not exit promptly')), 4000)),
    ]);
    assert.deepEqual(result, { code: signal === 'SIGINT' ? 130 : 143, childSignal: null });
    assert.ok(Date.now() - started < 4000);
    assert.equal(await exists(output), false, 'interruption left output that looks successful');
    const calls = (await readFile(log, 'utf8')).trim().split('\n');
    assert.deepEqual(calls.slice(0, 2), [
      'exec owned-fixture /bin/bash /work/build-inside.sh production', 'BUILD_STARTED',
    ]);
    assert.deepEqual(calls.slice(2), cleanupFails ? [
      'exec owned-fixture /bin/sh -c kill -TERM -1',
      'exec owned-fixture /bin/sh -c kill -KILL -1',
      'exec owned-fixture /bin/bash /work/cleanup.sh',
    ] : [
      'exec owned-fixture /bin/sh -c kill -TERM -1',
      'exec owned-fixture /bin/sh -c kill -KILL -1',
      'exec owned-fixture /bin/bash /work/cleanup.sh',
      'rm -f owned-fixture',
    ]);
    assert.equal(calls.some(call => call.includes('unrelated')), false);
    assert.equal(await readFile(containers, 'utf8'), cleanupFails
      ? 'owned-fixture\nunrelated-fixture\n' : 'unrelated-fixture\n');
    if (cleanupFails) assert.match(stderr, /retained container owned-fixture for inspection/);
    else assert.doesNotMatch(stderr, /retained container/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('SIGTERM stops the active owned build, cleans it, and removes only its container', async () => {
  await cancellationCase('SIGTERM', false);
});

test('SIGINT retains the owned container when backend cleanup fails', async () => {
  await cancellationCase('SIGINT', true);
});
