// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { chmod, mkdir, unlink, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { H264AccessUnit } from './aoa.js';

export const MAX_MEDIA_FRAME = 2_000_000;
/** Private wire contract: uint32 BE length, uint32 BE camera milliseconds, Annex B AU. */
export function frameMedia(unit: H264AccessUnit): Buffer {
  if (!unit.data.length || unit.data.length > MAX_MEDIA_FRAME || !Number.isInteger(unit.timestamp)
    || unit.timestamp < 0 || unit.timestamp > 0xffffffff) throw new Error('invalid accessory media frame');
  const out = Buffer.allocUnsafe(8 + unit.data.length);
  out.writeUInt32BE(unit.data.length, 0); out.writeUInt32BE(unit.timestamp, 4);
  out.set(unit.data, 8); return out;
}
export function annexBUnits(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; size: number }[] = [];
  for (let i = 0; i < data.length - 2; i++) {
    if (data[i] || data[i + 1]) continue;
    const size = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    if (size) { starts.push({ at: i, size }); i += size - 1; }
  }
  return starts.map((s, i) => data.subarray(s.at + s.size, starts[i + 1]?.at ?? data.length)).filter(n => n.length);
}
/** SPS display geometry, including chroma-dependent cropping; VUI rate is deliberately unused. */
export function spsDimensions(nal: Uint8Array): { width: number; height: number } | null {
  try {
    if ((nal[0] & 31) !== 7 || nal.length > 65_536) return null;
    const bytes: number[] = [];
    for (let i = 1; i < nal.length; i++) {
      if (nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
      bytes.push(nal[i]);
    }
    let at = 0;
    const bits = (n: number): number => {
      if (n > 32 || at + n > bytes.length * 8) throw new Error();
      let v = 0; while (n--) { v = v * 2 + ((bytes[at >> 3] >> (7 - (at & 7))) & 1); at++; } return v;
    };
    const ue = (): number => { let n = 0; while (!bits(1)) if (++n > 30) throw new Error(); return 2 ** n - 1 + bits(n); };
    const se = (): number => { const v = ue(); return v & 1 ? (v + 1) / 2 : -v / 2; };
    const profile = bits(8); bits(16); ue();
    let chroma = 1; let separate = 0;
    if ([100,110,122,244,44,83,86,118,128,138,139,134,135].includes(profile)) {
      chroma = ue(); if (chroma > 3) throw new Error();
      if (chroma === 3) separate = bits(1);
      ue(); ue(); bits(1);
      if (bits(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (bits(1)) {
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
      }
    }
    ue(); const order = ue();
    if (order === 0) ue();
    else if (order === 1) { bits(1); se(); se(); const n = ue(); if (n > 255) throw new Error(); for (let i = 0; i < n; i++) se(); }
    else if (order > 2) throw new Error();
    ue(); bits(1); const w = ue() + 1; const h = ue() + 1;
    const frame = bits(1); if (!frame) bits(1); bits(1);
    let left = 0, right = 0, top = 0, bottom = 0;
    if (bits(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
    const array = separate ? 0 : chroma;
    const cropX = array === 1 || array === 2 ? 2 : 1;
    const cropY = (array === 1 ? 2 : 1) * (2 - frame);
    const width = w * 16 - (left + right) * cropX;
    const height = h * 16 * (2 - frame) - (top + bottom) * cropY;
    return width > 0 && height > 0 && width <= 8192 && height <= 8192 ? { width, height } : null;
  } catch { return null; }
}
export class FrameClock {
  private previous?: number;
  private deltas: number[] = [];
  update(timestamp: number): boolean {
    const delta = this.previous === undefined ? undefined : (timestamp - this.previous) >>> 0;
    this.previous = timestamp;
    if (delta === undefined) return true;
    if (delta === 0) return true;
    if (delta > 1000) { this.deltas = []; return false; }
    this.deltas.push(delta); if (this.deltas.length > 120) this.deltas.shift(); return true;
  }
  fps(): number | null { return this.deltas.length < 15 ? null : 1000 * this.deltas.length / this.deltas.reduce((a, b) => a + b, 0); }
  reset(): void { this.previous = undefined; this.deltas = []; }
}

/** No backlog: slow clients are disconnected; every generation starts at a fresh IDR. */
export class AccessoryMedia {
  private server?: Server;
  private clients = new Map<Socket, boolean>();
  private sps?: Uint8Array;
  private pps?: Uint8Array;
  readonly clock = new FrameClock();
  dimensions: { width: number; height: number } | null = null;
  constructor(readonly endpoint: string) {}
  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(dirname(this.endpoint), { recursive: true, mode: 0o750 });
    // Never unlink an unknown owner's live endpoint to make a second source fit.
    try {
      const file = await lstat(this.endpoint);
      if (!file.isSocket() || (process.getuid && file.uid !== process.getuid())) throw new Error('Accessory endpoint is owned by another file or user');
      const stale = await new Promise<boolean>(resolve => {
        const probe = createConnection(this.endpoint);
        const finish = (value: boolean) => { probe.destroy(); resolve(value); };
        probe.once('connect', () => finish(false));
        probe.once('error', error => finish((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'));
        probe.setTimeout(250, () => finish(false));
      });
      if (!stale) throw new Error('Accessory media endpoint is already claimed');
      await unlink(this.endpoint);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const server = createServer(socket => {
      if (this.clients.size >= 4) { socket.destroy(); return; }
      this.clients.set(socket, false);
      socket.on('error', () => socket.destroy()); socket.on('close', () => this.clients.delete(socket));
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.endpoint, () => { server.removeListener('error', reject); resolve(); }); });
    this.server = server; await chmod(this.endpoint, 0o600);
  }
  push(unit: H264AccessUnit): boolean {
    const continuous = this.clock.update(unit.timestamp);
    if (!continuous) { this.reset(); this.clock.update(unit.timestamp); }
    const nals = annexBUnits(unit.data);
    for (const nal of nals) {
      if ((nal[0] & 31) === 7) { this.sps = nal.slice(); this.dimensions = spsDimensions(nal); }
      if ((nal[0] & 31) === 8) this.pps = nal.slice();
    }
    const idr = nals.some(n => (n[0] & 31) === 5);
    for (const [client, ready] of this.clients) {
      if (!ready && (!idr || !this.sps || !this.pps)) continue;
      const data = ready ? unit.data : Buffer.concat([Buffer.from([0,0,0,1]), this.sps!, Buffer.from([0,0,0,1]), this.pps!, unit.data]);
      if (data.length > MAX_MEDIA_FRAME || client.writableLength + data.length > MAX_MEDIA_FRAME) { client.destroy(); continue; }
      client.write(frameMedia({ ...unit, data }));
      this.clients.set(client, true);
    }
    return continuous;
  }
  reset(): void { for (const client of this.clients.keys()) client.destroy(); this.clients.clear(); this.sps = this.pps = undefined; this.dimensions = null; this.clock.reset(); }
  async close(): Promise<void> {
    this.reset(); const server = this.server; this.server = undefined;
    if (server) { await new Promise<void>(resolve => server.close(() => resolve())); await unlink(this.endpoint).catch(() => undefined); }
  }
}
