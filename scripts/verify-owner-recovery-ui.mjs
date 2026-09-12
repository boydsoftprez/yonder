#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Focused Settings integration against the real daemon, Node-RED dashboard,
// authenticated maintenance proxy, and browser. Native account, ZeroTier and
// reboot effects remain covered by their separate Linux fixtures.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { parse, stringify } from 'yaml';
import { chromium } from 'playwright';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONSOLE_TREE = process.env.CONSOLE_TREE ?? join(REPO, 'vendor/console');
const artifactArg = process.argv.indexOf('--artifacts');
const ARTIFACTS = artifactArg === -1
  ? join(tmpdir(), `yonder-owner-recovery-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  : process.argv[artifactArg + 1];
if (!ARTIFACTS) throw new Error('--artifacts requires a directory');

for (const required of [
  join(REPO, 'packages/yonder-core/dist/daemon/server.js'),
  join(REPO, 'packages/node-red-dashboard-2-yonder/resources/ui-yonder-settings.umd.js'),
  join(CONSOLE_TREE, 'node_modules/node-red/red.js'),
]) assert(existsSync(required), `missing built harness dependency: ${required}`);

// Darwin's Unix-domain socket path is short; keep this disposable root under
// /tmp so the real daemon binds the same kind of socket without hitting 104.
const root = mkdtempSync('/tmp/yonder-ui.');
const etc = join(root, 'etc/yonder'), runDirectory = join(root, 'run/yonder'), state = join(root, 'var/lib/yonder');
const consoleDir = join(root, 'opt/yonder/console'), userDir = join(state, 'console'), bin = join(root, 'bin');
const socket = join(runDirectory, 'core.sock'), journal = join(root, 'services.log'), fixtureState = join(root, 'admin-fixture.json');
const children = [];
mkdirSync(ARTIFACTS, { recursive: true });
for (const path of [etc, runDirectory, state, consoleDir, userDir, bin, join(root, 'etc/mediamtx')]) mkdirSync(path, { recursive: true });
writeFileSync(journal, '');

const password = 'fixture-console-Kp4Rn8Wq';
const linuxPassword = 'fixture-linux-Tq9Lm3Vx';
const changedLinuxPassword = 'fixture-linux-new-Hs2Bn7Jv';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureOnlyBrowserKeyMaterial0123456789 test@yonder.invalid';

function executable(name, body) {
  const path = join(bin, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o700); return path;
}
const routerState = join(root, 'router-state'), routerStats = join(root, 'router-stats');
writeFileSync(routerState, 'inactive\n'); writeFileSync(routerStats, '');
executable('systemctl', `case "$*" in
  *mavlink-router*) case "$1" in is-active) [ "$(cat '${routerState}')" = active ] || exit 3;; start|restart) echo active > '${routerState}';; stop) echo inactive > '${routerState}';; esac;;
esac
exit 0`);
executable('journalctl', `cat '${routerStats}' 2>/dev/null; exit 0`);
executable('nmcli', `case "$*" in *"device status"*) printf 'lo:loopback:connected:lo\\nwlan0:wifi:disconnected:\\n';; *"device wifi list"*) printf 'FixtureNet:70:WPA2\\n';; esac; exit 0`);
executable('ip', `case "$*" in "-j address show") printf '[]\\n';; *"route show"*) printf '[]\\n';; *) exit 1;; esac`);
for (const name of ['mmcli', 'curl', 'rfkill', 'hostnamectl', 'shutdown']) executable(name, 'exit 0');
executable('ping', `printf '3 packets transmitted, 3 received, 0%% packet loss\\nrtt min/avg/max/mdev = 1/2/3/1 ms\\n'; exit 0`);

const port = await new Promise((resolve, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert(address && typeof address === 'object');
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;

const config = parse(readFileSync(join(REPO, 'config/defaults/config.yaml'), 'utf8'));
config.ui.port = port; config.mavlink.autocast = false;
writeFileSync(join(etc, 'config.yaml'), stringify(config));
writeFileSync(join(etc, 'secrets.yaml'), '{}\n', { mode: 0o600 });
const cameraFixture = join(REPO, 'scripts/fixtures/camera-globalshutter.json');
const mavMode = join(root, 'mav-mode'); writeFileSync(mavMode, 'linked\n');

function start(command, args, env = process.env) {
  const output = writeFileSync;
  const child = spawn(command, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const append = chunk => output(journal, chunk, { flag: 'a' });
  child.stdout.on('data', append); child.stderr.on('data', append); children.push(child); return child;
}
async function waitFor(check, label, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await check()) return; } catch { /* retry until bounded deadline */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}
function ensureAlive(child, label) {
  if (child.exitCode !== null) throw new Error(`${label} exited with ${child.exitCode}\n${readFileSync(journal, 'utf8')}`);
}
async function run(command, args, label) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${label} failed (${code})\n${stdout}\n${stderr}`)));
  });
}
function fixture() { return JSON.parse(readFileSync(fixtureState, 'utf8')); }

let browser;
try {
  const daemon = start(process.execPath, [join(REPO, 'scripts/pages-daemon.mjs')], {
    ...process.env, PATH: `${bin}:${process.env.PATH}`,
    YONDER_SOCKET: socket, YONDER_CONFIG: join(etc, 'config.yaml'), YONDER_SECRETS: join(etc, 'secrets.yaml'),
    YONDER_JOURNAL: join(state, 'apply.json'), YONDER_CONSOLE_SETTINGS: join(consoleDir, 'settings.js'),
    YONDER_CONSOLE_USERDIR: userDir, YONDER_CONSOLE_CORE_TREE: join(REPO, 'packages/yonder-core'),
    YONDER_CONSOLE_UNIT: 'yonder-console.service', YONDER_PAGES_MAV_MODE: mavMode,
    YONDER_PAGES_MAV_CONF: join(etc, 'mavlink-router/main.conf'),
    YONDER_PAGES_MAV_HINT: join(state, 'mavlink-link.json'), YONDER_PAGES_ROUTER_STATE: routerState,
    YONDER_PAGES_ROUTER_STATS: routerStats, YONDER_CAMERAS_FIXTURE: cameraFixture,
    YONDER_MEDIA_CONFIG: join(root, 'etc/mediamtx/mediamtx.yml'), YONDER_PAGES_ADMIN_FIXTURE: fixtureState,
  });
  await waitFor(() => { ensureAlive(daemon, 'fixture daemon'); return existsSync(socket); }, 'daemon socket');
  const provision = spawnSync('curl', ['-sf', '-H', 'content-type: application/json', '--data', JSON.stringify({ password }),
    '--unix-socket', socket, 'http://localhost/admin/password'], { encoding: 'utf8' });
  assert.equal(provision.status, 0, 'could not provision fixture console password');
  await waitFor(() => readFileSync(join(consoleDir, 'settings.js'), 'utf8').includes('provisioned: true'), 'generated settings');

  copyFileSync(join(REPO, 'flows/flows.json'), join(userDir, 'flows.json'));
  mkdirSync(join(consoleDir, 'node_modules'), { recursive: true }); mkdirSync(join(userDir, 'node_modules'), { recursive: true });
  const packages = ['node-red-contrib-yonder-system', 'node-red-contrib-yonder-network', 'node-red-contrib-yonder-remote',
    'node-red-contrib-yonder-modem', 'node-red-contrib-yonder-video', 'node-red-contrib-yonder-mavlink', 'node-red-dashboard-2-yonder'];
  for (const name of packages) {
    symlinkSync(join(REPO, 'packages', name), join(consoleDir, 'node_modules', name));
    symlinkSync(join(REPO, 'packages', name), join(userDir, 'node_modules', name));
  }
  symlinkSync(join(REPO, 'packages/yonder-core'), join(consoleDir, 'node_modules/yonder-core'));
  symlinkSync(join(REPO, 'packages/yonder-core'), join(userDir, 'node_modules/yonder-core'));
  writeFileSync(join(userDir, 'package.json'), JSON.stringify({ name: 'yonder-console-state', version: '0.0.0', private: true,
    dependencies: { 'node-red-dashboard-2-yonder': JSON.parse(readFileSync(join(REPO, 'packages/node-red-dashboard-2-yonder/package.json')).toString()).version } }));
  for (const entry of (await import('node:fs')).readdirSync(join(CONSOLE_TREE, 'node_modules'))) {
    const target = join(consoleDir, 'node_modules', entry);
    if (!existsSync(target)) symlinkSync(join(CONSOLE_TREE, 'node_modules', entry), target);
  }
  const consoleProcess = start(process.execPath, [join(consoleDir, 'node_modules/node-red/red.js'), '-s', join(consoleDir, 'settings.js')]);
  await waitFor(async () => { ensureAlive(consoleProcess, 'Node-RED'); return (await fetch(baseUrl, { redirect: 'manual' })).status > 0; }, 'Node-RED');
  await waitFor(() => readFileSync(journal, 'utf8').includes('Started flows'), 'shipped flows');
  assert(!/unknown type|Type not registered|missing types|No group configured|Circular config node/i.test(readFileSync(journal, 'utf8')),
    'Node-RED did not load every shipped node and group');

  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const signIn = async () => {
    const answer = await context.request.post(`${baseUrl}/login`, { form: { password } });
    assert(answer.ok(), `console sign-in failed (${answer.status()})`);
  };
  await signIn();
  const page = await context.newPage();
  await page.goto(`${baseUrl}/dashboard/settings`, { waitUntil: 'load' });
  const owner = page.locator('[aria-label="Linux account and SSH"]');
  const recovery = page.locator('[aria-label="Recovery backup and restore"]');
  const storage = page.locator('[aria-label="Storage protection and maintenance"]');
  await owner.waitFor(); await recovery.waitFor(); await storage.waitFor();

  const create = owner.locator('form[aria-label="Create Linux account"]');
  await create.getByLabel('Linux username').fill('pilot');
  await create.getByLabel('Current console password').fill(password);
  await create.getByLabel('Linux password', { exact: true }).fill(linuxPassword);
  await create.getByLabel('Confirm Linux password', { exact: true }).fill(linuxPassword);
  await create.getByRole('button', { name: 'Create Linux account' }).click();
  await owner.getByText('Linux account created. SSH is off.').waitFor();
  assert.equal(fixture().owner.username, 'pilot');

  const ssh = owner.locator('form[aria-label="SSH access"]');
  await ssh.getByLabel('Enable SSH').check(); await ssh.getByLabel('Allow the Linux password over SSH').check();
  await ssh.getByLabel('Replace the saved public keys').check(); await ssh.getByLabel('SSH public keys, one per line').fill(publicKey);
  await ssh.getByLabel('Current console password').fill(password); await ssh.getByRole('button', { name: 'Save SSH access' }).click();
  await owner.getByText('SSH access saved.').waitFor();
  assert.equal(fixture().owner.authorizedKeyFingerprints.length, 1);
  await ssh.getByLabel('Allow the Linux password over SSH').uncheck();
  await ssh.getByLabel('Current console password').fill(password); await ssh.getByRole('button', { name: 'Save SSH access' }).click();
  await waitFor(() => fixture().calls.includes('owner.ssh.preserve-keys'), 'SSH key-preservation call');
  assert.equal(fixture().owner.authorizedKeyFingerprints.length, 1);

  await owner.locator('summary', { hasText: 'Change Linux password' }).click();
  const change = owner.locator('form[aria-label="Change Linux password"]');
  await change.getByLabel('Current console password').fill(password);
  await change.getByLabel('New Linux password', { exact: true }).fill(changedLinuxPassword);
  await change.getByLabel('Confirm Linux password', { exact: true }).fill(changedLinuxPassword);
  await change.getByRole('button', { name: 'Change Linux password' }).click();
  await owner.getByText('Linux password changed.').waitFor(); assert.equal(fixture().passwordChanges, 1);

  await recovery.getByRole('button', { name: 'Download backup' }).click();
  await recovery.locator('form[aria-label="Download recovery backup"]').getByLabel('Current console password').fill(password);
  const downloadPromise = page.waitForEvent('download');
  await recovery.locator('form[aria-label="Download recovery backup"]').getByRole('button', { name: 'Download backup' }).click();
  const download = await downloadPromise; const archivePath = join(root, 'downloaded-recovery.json'); await download.saveAs(archivePath);
  assert(readFileSync(archivePath, 'utf8').includes('owner-recovery-ui'));

  await recovery.getByRole('button', { name: 'Restore backup' }).click();
  await recovery.locator('input[type="file"]').setInputFiles(archivePath);
  await recovery.locator('form[aria-label="Preview recovery backup"]').getByLabel('Current console password').fill(password);
  const [previewResponse] = await Promise.all([
    page.waitForResponse(answer => answer.url().endsWith('/maintenance/api/recovery/preview')),
    recovery.getByRole('button', { name: 'Preview restore' }).click(),
  ]);
  assert.equal(previewResponse.status(), 200,
    `recovery preview failed (${previewResponse.status()}): ${JSON.stringify(await previewResponse.json())}`);
  await recovery.getByText('Review this restore').waitFor();
  assert((await recovery.textContent()).includes('Setup AP and fallback remain enabled'));

  let committedStatus = 0;
  await page.route('**/maintenance/api/recovery/commit', async route => {
    const answer = await route.fetch(); committedStatus = answer.status(); await route.abort('connectionfailed');
  });
  const commit = recovery.locator('form[aria-label="Confirm recovery restore"]');
  await commit.getByLabel('I understand this replaces the listed settings and credentials.').check();
  await commit.getByLabel('Current console password').fill(password);
  await commit.getByRole('button', { name: 'Restore and restart' }).click();
  await recovery.getByRole('alert').waitFor();
  assert((await recovery.getByRole('alert').textContent()).includes('reply was lost or not confirmed'));
  assert.equal(committedStatus, 200); assert.equal(fixture().restoreCommits, 1); assert.equal(fixture().restoreActivations, 1);
  await page.unroute('**/maintenance/api/recovery/commit');
  const revoked = await context.request.get(`${baseUrl}/maintenance/api/storage`);
  assert.equal(revoked.status(), 401, 'successful restore did not revoke the browser session');

  await signIn(); await page.reload({ waitUntil: 'load' }); await storage.waitFor();
  await storage.getByRole('button', { name: 'Enter maintenance' }).click();
  const enter = storage.locator('form[aria-label="Confirm writable maintenance"]');
  await enter.getByLabel(/I understand this reboots into writable maintenance/).check();
  await enter.getByLabel('Current console password').fill(password);
  await enter.getByRole('button', { name: 'Reboot into maintenance' }).click();
  await storage.getByText(/waiting for the maintenance reboot/i).waitFor();
  assert.equal(fixture().storage.operation.phase, 'awaiting-maintenance-reboot');
  assert.equal(fixture().calls.filter(value => value === 'storage.enter').length, 1);

  assert(!(await page.content()).includes(linuxPassword)); assert(!(await page.content()).includes(changedLinuxPassword));
  const refs = join(ARTIFACTS, 'isolated-refs'); mkdirSync(refs, { recursive: true });
  const capture = async (palette, extra = []) => run(process.execPath, [join(REPO, 'scripts/capture-pages.mjs'),
    '--base-url', baseUrl, '--password', password, '--palette', palette, '--only', 'settings', '--refs', refs,
    '--artifacts', ARTIFACTS, ...extra], `Settings ${palette} capture`);
  await capture('day');
  await page.getByRole('button', { name: 'Night', exact: true }).click();
  await waitFor(() => readFileSync(join(consoleDir, 'public/theme.css'), 'utf8').includes('--yonder-theme: "night"'), 'night palette');
  await capture('night');
  await capture('night', ['--viewport', '600x900', '--as', 'settings-narrow']);

  const publicEvidence = fixture(); delete publicEvidence.owner; delete publicEvidence.storage;
  writeFileSync(join(ARTIFACTS, 'verification.json'), `${JSON.stringify({
    result: 'pass', realStack: ['yonder-core daemon', 'Node-RED', 'Dashboard 2', 'authenticated maintenance proxy', 'Chromium'],
    fixtureScope: 'Linux account, archive, storage and reboot side effects only',
    checks: { ownerCreated: true, sshKeysPreserved: true, linuxPasswordChanged: true,
      recoveryFileInputPreviewed: true, restoreCommittedBeforeLostReply: true, sessionRevoked: true,
      storageMaintenanceRequested: true }, calls: publicEvidence.calls,
  }, null, 2)}\n`);
  process.stdout.write(`PASS: authenticated owner, recovery and storage Settings flow\nARTIFACTS=${ARTIFACTS}\n`);
} catch (error) {
  if (existsSync(journal)) copyFileSync(journal, join(ARTIFACTS, 'failure.log'));
  if (existsSync(fixtureState)) copyFileSync(fixtureState, join(ARTIFACTS, 'failure-fixture.json'));
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const child of children.reverse()) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once('exit', resolve))));
  rmSync(root, { recursive: true, force: true });
}
