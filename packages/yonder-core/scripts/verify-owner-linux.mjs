// SPDX-License-Identifier: GPL-3.0-or-later
// Disposable Linux-only account integration. Never invoke on an installed host.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { LinuxOwnerProjector } from '../dist/owner-access/linux.js';
import { OwnerAccessService } from '../dist/owner-access/service.js';
import { DurableStateCoordinator } from '../dist/state/coordinator.js';
import { DEFAULT_CONFIG } from '../dist/schema/config.js';
import { runSensitiveProcess } from '../dist/admin/sensitive-process.js';

assert(process.platform === 'linux' && process.getuid() === 0 && existsSync('/.dockerenv'));
assert(!existsSync('/lab/owner-integration'));
mkdirSync('/lab/owner-integration', { recursive: true });
const folder = '/lab/owner-integration';
const password = 'disposable-owner-fixture-password';
let listener;
let desiredSsh = false;
const native = new LinuxOwnerProjector(async enabled => { desiredSsh = enabled; });
let failForward = () => false;
const projector = {
  name: native.name, sections: native.sections,
  async apply(input) {
    try { await native.apply(input); }
    catch (error) { process.stderr.write(`Native fixture projection failed: ${error.code ?? 'unknown'}\n${error.stack}\n`); throw error; }
    if (failForward(input)) { failForward = () => false; throw Error('injected projection failure'); }
  },
  verify: input => native.verify(input),
};
const coordinator = new DurableStateCoordinator({ root: `${folder}/transactions`,
  configPath: `${folder}/config.yaml`, secretsPath: `${folder}/secrets.yaml`,
  bootstrap: async () => ({ config: structuredClone(DEFAULT_CONFIG), secrets: {}, linuxOwner: null, zeroTier: null }),
  projectors: [projector],
});
const service = new OwnerAccessService(coordinator, native);
const run = async (command, args, stdin) => (await runSensitiveProcess({ command, args, stdin })).stdout.toString().trim();
const snapshot = async () => { const lease = await coordinator.beginSnapshot({ id: randomUUID() }); try { return lease.snapshot; } finally { await lease.release(); } };

try {
  await run('/usr/sbin/useradd', ['--system', '--no-create-home', 'yonder']);
  const serviceBefore = await run('/usr/bin/getent', ['passwd', 'yonder']);
  await coordinator.recover();
  assert.equal(desiredSsh, false);
  await assert.rejects(service.create({ username: 'yonder', newPassword: password, confirmPassword: password }));
  await run('/usr/sbin/useradd', ['--no-create-home', 'existingpilot']);
  await assert.rejects(service.create({ username: 'existingpilot', newPassword: password, confirmPassword: password }));
  assert.equal((await service.state()).configured, false);

  failForward = input => input.previous.linuxOwner === null && input.next.linuxOwner?.username === "pilot";
  await assert.rejects(service.create({ username: 'pilot', newPassword: password, confirmPassword: password }));
  assert.equal((await service.state()).configured, false);
  assert(!existsSync('/home/pilot'));
  await service.create({ username: 'pilot', newPassword: password, confirmPassword: password });
  assert.equal(desiredSsh, false);
  assert.equal(await run('/usr/bin/getent', ['passwd', 'yonder']), serviceBefore);
  assert.equal(await run('/usr/sbin/runuser', ['-u', 'pilot', '--', '/usr/bin/sudo', '-S', '-k', '/usr/bin/id', '-u'], password + '\n'), '0');
  await assert.rejects(run('/usr/sbin/runuser', ['-u', 'pilot', '--', '/usr/bin/sudo', '-n', '-k', '/usr/bin/id', '-u']));
  const ownerBefore = await run('/usr/bin/getent', ['passwd', 'pilot']);
  const unrelatedBefore = await run('/usr/bin/getent', ['passwd', 'existingpilot']);
  const existingState = (await snapshot()).state;
  const conflictingOwner = { ...existingState.linuxOwner, username: 'existingpilot' };
  await assert.rejects(native.preflightRestore(conflictingOwner, existingState.linuxOwner), { code: 'DESTINATION_CONFLICT' });
  // Simulate a journal staged by an older build that lacked the preflight.
  const conflicting = await coordinator.begin({ id: randomUUID(), kind: 'restore' });
  await conflicting.stage({ ...existingState, linuxOwner: conflictingOwner });
  await assert.rejects(conflicting.activate());
  await conflicting.rollback('native-restore-conflict');
  assert.equal(await run('/usr/bin/getent', ['passwd', 'pilot']), ownerBefore);
  assert.equal(await run('/usr/bin/getent', ['passwd', 'existingpilot']), unrelatedBefore);
  assert.equal((await coordinator.status()).operation, null);
  // A failed rename must preserve home contents and their owning UID.
  await run('/usr/sbin/runuser', ['-u', 'pilot', '--', '/usr/bin/touch', '/home/pilot/keep-fixture']);
  const rename = await coordinator.begin({ id: randomUUID(), kind: 'restore' });
  await rename.stage({ ...existingState, linuxOwner: { ...existingState.linuxOwner, username: 'renamedpilot' } });
  failForward = input => input.next.linuxOwner?.username === 'renamedpilot';
  await assert.rejects(rename.activate());
  await rename.rollback('native-restore-rename-failed');
  assert.equal((await run('/usr/bin/getent', ['passwd', 'pilot'])).split(':')[2], ownerBefore.split(':')[2]);
  assert.equal(await run('/usr/sbin/runuser', ['-u', 'pilot', '--', '/usr/bin/test', '-O', '/home/pilot/keep-fixture']), '');
  assert.equal((await service.state()).username, 'pilot');
  const before = (await snapshot()).state.linuxOwner.passwordHash;
  failForward = input => input.previous.linuxOwner?.passwordHash === before && input.next.linuxOwner?.passwordHash !== before;
  await assert.rejects(service.changePassword({ newPassword: 'different-fixture-password', confirmPassword: 'different-fixture-password' }), { code: 'PROJECTION_FAILED' });
  assert.equal((await snapshot()).state.linuxOwner.passwordHash, before);
  assert.equal(await run('/usr/sbin/runuser', ['-u', 'pilot', '--', '/usr/bin/sudo', '-S', '-k', '/usr/bin/id', '-u'], password + '\n'), '0');

  await service.configureSsh({ enabled: true, passwordAuthentication: true, authorizedKeys: [] });
  assert.equal(desiredSsh, true);
  listener = spawn('/usr/sbin/sshd', ['-D', '-p', '22222', '-o', 'ListenAddress=127.0.0.1', '-o', 'PidFile=/run/owner-test-sshd.pid'], { stdio: 'ignore' });
  await delay(200);
  assert.equal(listener.exitCode, null);
  const ssh = ['-p', '22222', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=3', '-o', 'NumberOfPasswordPrompts=1'];
  assert.equal(await run('/usr/bin/sshpass', ['-d0', 'ssh', ...ssh, '-o', 'PubkeyAuthentication=no', 'pilot@127.0.0.1', 'id -un'], password + '\n'), 'pilot');
  await assert.rejects(run('/usr/bin/sshpass', ['-d0', 'ssh', ...ssh, '-o', 'PubkeyAuthentication=no', 'root@127.0.0.1', 'id -un'], password + '\n'));

  await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', `${folder}/client`]);
  await service.configureSsh({ enabled: true, passwordAuthentication: false, authorizedKeys: [readFileSync(`${folder}/client.pub`, 'utf8').trim()] });
  listener.kill('SIGHUP'); await delay(150);
  assert.equal(await run('/usr/bin/ssh', [...ssh, '-i', `${folder}/client`, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', 'pilot@127.0.0.1', 'id -un']), 'pilot');
  await assert.rejects(run('/usr/bin/sshpass', ['-d0', 'ssh', ...ssh, '-o', 'PubkeyAuthentication=no', 'pilot@127.0.0.1', 'id -un'], password + '\n'));
  assert.equal(await run('/usr/bin/getent', ['passwd', 'yonder']), serviceBefore);
  assert.equal((await coordinator.status()).operation, null);
  process.stdout.write('PASS: native owner create/collision/rollback, password sudo, password/key SSH policies, direct-root refusal and service-account preservation.\n');
} finally {
  if (listener && listener.exitCode === null) { listener.kill('SIGTERM'); await once(listener, 'close'); }
  rmSync(folder, { recursive: true, force: true });
}
