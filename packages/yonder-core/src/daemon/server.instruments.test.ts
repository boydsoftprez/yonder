// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startServer } from './server.js';
import { SecretStore } from '../secrets/store.js';
import { ADMIN_PASSWORD_SECRET } from '../console/credential.js';
import { hashPassword } from '../console/password.js';
import { DEFAULT_CONFIG } from '../schema/config.js';
import { saveConfig } from '../config/save.js';
import { unpackInstruments } from '../../../node-red-dashboard-2-yonder/src/ui/cockpit/instrumentation-client.mjs';

it('wires injected companion OS readers and passive modem facts through the daemon without a vehicle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yonder-instruments-'));
  const socketPath = join(dir, 'core.sock'), configPath = join(dir, 'config.yaml'), secretsPath = join(dir, 'secrets.yaml');
  saveConfig(configPath, DEFAULT_CONFIG);
  new SecretStore(secretsPath).ensureValue(ADMIN_PASSWORD_SECRET, hashPassword('an operator password'));
  const fixture = (name: string) => readFileSync(new URL(`../net/modem/mmcli/fixtures/${name}.txt`, import.meta.url), 'utf8');
  const commands: string[][] = [];
  let reads = 0;
  const server = await startServer({ socketPath, configPath, secretsPath, journalPath: join(dir, 'apply.json'), renderers: [{ name: 'noop', async render() {} }],
    clock: { now: () => 1000, setTimer: () => 0, clearTimer: () => {} }, counters: () => null,
    hostInstruments: { readFile: path => { reads++; return path === '/proc/uptime' ? '444 888' : null; }, freeBytes: async () => 12345 },
    runner: async argv => {
      commands.push([...argv]);
      let stdout = '';
      if (argv[0] === 'mmcli') stdout = fixture(argv.includes('-L') ? 'modem-list' : argv.includes('--signal-get') ? 'signal-get' : argv.includes('-b') ? 'bearer-connected' : 'modem-show');
      return { code: 0, stdout, stderr: '' };
    },
  });
  const poll = () => new Promise<any>((resolve, reject) => {
    const req = request({ socketPath, method: 'GET', path: '/cockpit/instruments' }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end();
  });
  try {
    const replies = await Promise.all([poll(), poll()]);
    expect(replies.map(reply => reply.status)).toEqual([200, 200]);
    expect(unpackInstruments(replies[0].body)).toMatchObject({ connected: false, generation: null, fields: {
      'host.uptimeSeconds': { value: 444 }, 'host.storageFreeBytes': { value: 12345 },
    } });
    // The first reply can precede optional ModemManager completion. A later
    // request sees the independently cached result without another OS/modem read.
    expect(unpackInstruments((await poll()).body)).toMatchObject({ fields: {
      'modem.rsrpDbm': { value: -100 }, 'modem.sinrDb': { value: 19 },
    } });
    expect(reads).toBe(4);
    expect(commands.filter(argv => argv.includes('--signal-get'))).toHaveLength(1);
    expect(commands.some(argv => argv.some(arg => arg.startsWith('--signal-setup')))).toBe(false);
    expect(commands.some(argv => ['ping', 'curl', 'gst-launch-1.0'].includes(argv[0]))).toBe(false);
  } finally { await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
