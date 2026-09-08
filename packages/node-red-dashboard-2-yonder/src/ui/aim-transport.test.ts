// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AimTransport } from './aim-transport.js';

afterEach(() => { vi.useRealTimers(); });
describe('private current-gesture transport', () => {
  it('renews a stationary held pointer, samples its latest rate, and stops without replay', async () => {
    vi.useFakeTimers(); const calls: any[] = [];
    const target = { url: '/video/cam1/aim', generation: 1, inhibited: null as string | null };
    let credential = 0;
    const fetcher = vi.fn(async (_url, opts: any) => {
      const body = JSON.parse(opts.body); calls.push(body);
      return { ok: true, json: async () => body.op === 'issue' ? { accepted: true, grant: { gesture: 'daemon-gesture', credential: 'c' + ++credential, deadline: 500 } }
        : { accepted: true, next: { gesture: 'daemon-gesture', credential: 'c' + ++credential, deadline: 500 + credential * 100 } } };
    });
    const transport = new AimTransport(() => target, () => {}, fetcher as any);
    transport.update({ gesture: 'physical', pan: 2, tilt: 0 }); await vi.advanceTimersByTimeAsync(100);
    expect(calls[1]).toMatchObject({ op: 'slew', gesture: 'daemon-gesture', pan: 2, credential: 'c1', deadline: 500 });
    transport.update({ gesture: 'physical', pan: 3, tilt: 1 }); await vi.advanceTimersByTimeAsync(200);
    expect(calls.filter(c => c.op === 'slew').map(c => c.pan)).toEqual([2,3,3]);
    transport.stop(); await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)).toEqual({ op: 'stop', gesture: 'daemon-gesture' });
    const count = calls.length; transport.update({ gesture: 'physical', pan: 3, tilt: 1 }); await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(count); transport.close();
  });
  it('discards an issue arriving after release and never sends its stale physical rate', async () => {
    vi.useFakeTimers(); let resolve!: (value: any) => void; const calls: any[] = [];
    const fetcher = vi.fn((_url, opts: any) => { const body = JSON.parse(opts.body); calls.push(body);
      if (body.op === 'issue') return new Promise(done => { resolve = done; });
      return Promise.resolve({ ok: true, json: async () => ({ accepted: true }) }); });
    const transport = new AimTransport(() => ({ url: '/video/cam1/aim', generation: 1 }), () => {}, fetcher as any);
    transport.update({ gesture: 'physical', pan: 2, tilt: 0 }); transport.stop();
    resolve({ ok: true, json: async () => ({ accepted: true, grant: { gesture: 'late', credential: 'old', deadline: 1 } }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.map(c => c.op)).toEqual(['issue', 'stop']); transport.close();
  });
  it('has one outstanding renewal and ends on generation change without reconnect resume', async () => {
    vi.useFakeTimers(); let generation = 1; let renew!: (value: any) => void;
    const calls: any[] = [];
    const fetcher = vi.fn((_url, opts: any) => { const body = JSON.parse(opts.body); calls.push(body);
      if (body.op === 'slew') return new Promise(done => { renew = done; });
      return Promise.resolve({ ok: true, json: async () => ({ accepted: true, grant: { gesture: 'g', credential: 'c', deadline: 500 } }) }); });
    const transport = new AimTransport(() => ({ url: '/video/cam1/aim', generation }), () => {}, fetcher as any);
    transport.update({ gesture: 'physical', pan: 2, tilt: 0 }); await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 10; i++) transport.update({ gesture: 'physical', pan: 3, tilt: 0 });
    await vi.advanceTimersByTimeAsync(200); expect(calls.filter(c => c.op === 'slew')).toHaveLength(1);
    generation = 2; transport.refresh(); renew({ ok: true, json: async () => ({ accepted: true, next: { gesture: 'g', credential: 'c2', deadline: 600 } }) });
    await vi.advanceTimersByTimeAsync(1000); expect(calls.filter(c => c.op === 'slew')).toHaveLength(1); transport.close();
  });
});
