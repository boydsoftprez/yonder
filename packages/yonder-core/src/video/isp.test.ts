// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeekerHdIsp, ispView, parseIspCommand, type IspReply } from './isp.js';

const state: IspReply = { ok: true, running: true, device: '/dev/video0', sensor: 'm00_b_imx462 2-001a',
  profile: 'normal-light', values: { brightness: 128, contrast: 128, saturation: 128, hue: 128 } };
let server: Server | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (dir) rmSync(dir, { recursive: true, force: true });
  server = undefined; dir = undefined;
});
async function peer(answer: (line: string) => string | null, timeout = 500): Promise<SeekerHdIsp> {
  dir = mkdtempSync(join(tmpdir(), 'isp-test-'));
  const path = join(dir, 'isp.sock');
  server = createServer(socket => {
    socket.on('error', () => {});
    socket.on('data', data => { const reply = answer(data.toString()); if (reply !== null) socket.end(reply); });
  });
  await new Promise<void>(resolve => server!.listen(path, resolve));
  return new SeekerHdIsp(path, timeout);
}
describe('live ISP controls (R-CTL-04/10/16)', () => {
  it('sends only the selected native command and returns device readback', async () => {
    const lines: string[] = [];
    const client = await peer(line => { lines.push(line); return JSON.stringify({ ...state, values: { ...state.values, brightness: 140 } }) + '\n'; });
    expect((await client.apply({ kind: 'isp-control', control: 'brightness', value: 140 })).values.brightness).toBe(140);
    await client.apply({ kind: 'isp-profile', value: 'low-light' });
    expect(lines).toEqual(['set brightness 140\n', 'profile low-light\n']);
  });
  it.each([
    { kind: 'isp-profile', value: '../../bad' },
    { kind: 'isp-control', control: 'brightness', value: 256 },
    { kind: 'isp-control', control: 'brightness', value: 1.5 },
    { kind: 'isp-control', control: 'gain', value: 128 },
    { kind: 'isp-profile', value: 'normal-light', path: '/tmp/other' },
  ])('rejects malformed or unsupported requests: %j', body => expect(parseIspCommand(body)).toBeNull());
  it('does not present another camera’s ISP as available', async () => {
    const client = await peer(() => JSON.stringify(state) + '\n');
    expect(await ispView(client, '/dev/video2')).toMatchObject({ available: false, values: null, reason: expect.stringContaining('different camera') });
  });
  it('keeps readback visible while stopped and explains why edits are unavailable', async () => {
    const client = await peer(() => JSON.stringify({ ...state, running: false }) + '\n');
    expect(await ispView(client, '/dev/video0')).toMatchObject({ available: true, running: false, values: state.values, reason: expect.stringContaining('Start video') });
  });
  it.each(['not json\n', JSON.stringify({ ...state, values: { ...state.values, brightness: 999 } }) + '\n', 'a'.repeat(4097)])('rejects invalid readbacks', async body => {
    const client = await peer(() => body);
    await expect(client.status()).rejects.toThrow(/invalid|size limit/);
  });
  it('returns refusal rather than reporting requested values as applied', async () => {
    const client = await peer(() => JSON.stringify({ ok: false, error: 'AIQ is stopped' }) + '\n');
    await expect(client.apply({ kind: 'isp-control', control: 'brightness', value: 150 })).rejects.toThrow('AIQ is stopped');
  });
  it('bounds a silent service without retrying the write', async () => {
    let requests = 0;
    const client = await peer(() => { requests++; return null; }, 30);
    await expect(client.apply({ kind: 'isp-profile', value: 'normal-light' })).rejects.toThrow('timed out');
    expect(requests).toBe(1);
  });
});
