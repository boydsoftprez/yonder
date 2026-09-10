// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { annexBUnits, frameMedia, FrameClock, spsDimensions } from './media.js';

describe('Pocket framed media', () => {
  it('preserves the camera millisecond clock in a bounded binary record', () => {
    const data = Buffer.from([0, 0, 1, 0x65, 1]);
    const out = frameMedia({ data, timestamp: 0xfffffff0, metadata: 0 });
    expect(out.readUInt32BE(0)).toBe(data.length);
    expect(out.readUInt32BE(4)).toBe(0xfffffff0);
    expect(out.subarray(8)).toEqual(data);
    expect(() => frameMedia({ data: Buffer.alloc(2_000_001), timestamp: 0, metadata: 0 })).toThrow();
  });
  it('recognizes both Annex B start codes without exposing empty NALs', () => {
    expect(annexBUnits(Buffer.from([0,0,0,1,0x67,1,0,0,1,0x68,2])).map(n => n[0])).toEqual([0x67, 0x68]);
  });
  it('measures cadence across uint32 wrap and refuses resets', () => {
    const clock = new FrameClock();
    expect(clock.update(0xfffffff0)).toBe(true);
    for (let i = 1; i <= 30; i++) expect(clock.update((0xfffffff0 + Math.round(i * 1000 / 29.97)) >>> 0)).toBe(true);
    expect(clock.fps()).toBeCloseTo(29.97, 1);
    expect(clock.update(10)).toBe(false);
    expect(clock.fps()).toBeNull();
  });
  it('does not fabricate dimensions from malformed SPS', () => {
    expect(spsDimensions(Buffer.from([0x67, 0x64]))).toBeNull();
  });
});

function baselineSps(): Buffer {
  const ue = (n: number) => { const binary = (n + 1).toString(2); return '0'.repeat(binary.length - 1) + binary; };
  let bits = [ue(0), ue(0), ue(0), ue(0), ue(1), '0', ue(79), ue(44), '1', '1', '0', '0', '1'].join('');
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return Buffer.from([0x67, 66, 0, 31, ...bits.match(/.{8}/g)!.map(b => parseInt(b, 2))]);
}

it('extracts actual 1280×720 geometry from a baseline SPS', () => {
  expect(spsDimensions(baselineSps())).toEqual({ width: 1280, height: 720 });
});

it('serves a private framed IDR boundary, refuses a second owner, and ends clients on reset', async () => {
  const { mkdtemp, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createConnection } = await import('node:net');
  const { once } = await import('node:events');
  const { AccessoryMedia } = await import('./media.js');
  const root = await mkdtemp(join(tmpdir(), 'ym-'));
  const media = new AccessoryMedia(join(root, 'c.sock'));
  let client: ReturnType<typeof createConnection> | undefined;
  try {
    await media.start(); expect((await stat(media.endpoint)).mode & 0o777).toBe(0o600);
    await expect(new AccessoryMedia(media.endpoint).start()).rejects.toThrow('already claimed');
    client = createConnection(media.endpoint); await once(client, 'connect');
    const start = Buffer.from([0,0,0,1]);
    media.push({ data: Buffer.concat([start, baselineSps(), start, Buffer.from([0x68,1])]), timestamp: 1000, metadata: 0 });
    media.push({ data: Buffer.from([0,0,1,0x41,3]), timestamp: 1033, metadata: 0 });
    const received = once(client, 'data');
    media.push({ data: Buffer.from([0,0,1,0x65,7]), timestamp: 1067, metadata: 0 });
    const [record] = await received;
    expect(record.readUInt32BE(4)).toBe(1067);
    expect(annexBUnits(record.subarray(8)).map(n => n[0] & 31)).toEqual([7,8,5]);
    const ended = once(client, 'close'); media.reset(); await ended;
    expect(media.dimensions).toBeNull();
  } finally { client?.destroy(); await media.close(); await rm(root, { recursive: true, force: true }); }
});
