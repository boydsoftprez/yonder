// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AimTransport } from './aim-transport.js';

afterEach(() => { vi.useRealTimers(); });
describe('private current-gesture transport', () => {
  it('renews a stationary held pointer, samples its latest rate, and stops without replay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); const calls: any[] = [];
    const target = { url: '/video/cam1/aim', generation: 1, inhibited: null as string | null };
    let credential = 0;
    const fetcher = vi.fn(async (_url, opts: any) => {
      const body = JSON.parse(opts.body); calls.push(body);
      return { ok: true, json: async () => body.op === 'issue' ? { accepted: true, grant: { gesture: 'daemon-gesture', credential: 'c' + ++credential, deadline: 500 } }
        : { accepted: true, next: { gesture: 'daemon-gesture', credential: 'c' + ++credential, deadline: 500 + credential * 100 } } };
    });
    const transport = new AimTransport(() => target, () => {}, fetcher as any);
    transport.update({ gesture: 'physical', pan: 2, tilt: 0 }); await vi.advanceTimersByTimeAsync(0);
    expect(calls[1]).toMatchObject({ op: 'slew', gesture: 'daemon-gesture', pan: 2, credential: 'c1', deadline: 500 });
    transport.update({ gesture: 'physical', pan: 3, tilt: 1 }); await vi.advanceTimersByTimeAsync(200);
    expect(calls.filter(c => c.op === 'slew').map(c => c.pan)).toEqual([2,3,3]);
    transport.stop(); await vi.advanceTimersByTimeAsync(1000);
    expect(calls.at(-1)).toEqual({ op: 'stop', gesture: 'daemon-gesture' });
    const count = calls.length; transport.update({ gesture: 'physical', pan: 3, tilt: 1 }); await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(count); transport.close();
  });
  it('discards an issue arriving after release and never sends its stale physical rate', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); let resolve!: (value: any) => void; const calls: any[] = [];
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }); let generation = 1; let renew!: (value: any) => void;
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

it.each([60, 160])('sends the first slew on grant and paces %ims responses from request start without overlap', async (latency) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const calls: { op: string; at: number }[] = [];
  let inFlight = 0, maximum = 0;
  const fetcher = vi.fn(async (_url, opts: any) => {
    const { op } = JSON.parse(opts.body);
    calls.push({ op, at: performance.now() });
    maximum = Math.max(maximum, ++inFlight);
    await new Promise(resolve => setTimeout(resolve, op === 'issue' ? 40 : latency));
    inFlight--;
    return { ok: true, json: async () => ({ accepted: true, grant: { gesture: 'g', credential: 'c', deadline: 500 }, next: { gesture: 'g', credential: 'c', deadline: 500 } }) };
  });
  const transport = new AimTransport(() => ({ url: '/video/cam1/aim', generation: 1 }), () => {}, fetcher as any);
  transport.update({ gesture: 'held', pan: 10, tilt: 0 });
  await vi.advanceTimersByTimeAsync(40);
  expect(calls.map(c => c.op)).toEqual(['issue', 'slew']);
  expect(calls[1].at - calls[0].at).toBe(40);
  await vi.advanceTimersByTimeAsync(360);
  const starts = calls.filter(c => c.op === 'slew').map(c => c.at);
  expect(starts.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < starts.length; i++) {
    expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(Math.max(100, latency));
    expect(starts[i] - starts[i - 1]).toBeLessThanOrEqual(Math.max(100, latency) + 1);
  }
  expect(maximum).toBe(1);
  transport.stop(); await vi.advanceTimersByTimeAsync(1000); transport.close();
});

it('keeps the 450ms request abort and requires a fresh gesture after failure', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const calls: any[] = []; const changed = vi.fn();
  const fetcher = vi.fn((_url, options: any) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (body.op === 'slew') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Timed out'))));
    return Promise.resolve({ ok: true, json: async () => ({ accepted: true, grant: { gesture: 'g', credential: 'c', deadline: 500 } }) });
  });
  const transport = new AimTransport(() => ({ url: '/video/cam1/aim', generation: 1 }), changed, fetcher as any);
  transport.update({ gesture: 'hold', pan: 10, tilt: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.map(c => c.op)).toEqual(['issue', 'slew']);
  await vi.advanceTimersByTimeAsync(449);
  expect(calls.map(c => c.op)).toEqual(['issue', 'slew']);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls.map(c => c.op)).toEqual(['issue', 'slew', 'stop']);
  expect(changed).toHaveBeenCalledWith({ pan: 0, tilt: 0 }, 'Timed out');
  transport.update({ gesture: 'hold', pan: 5, tilt: 0 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls).toHaveLength(3);
  transport.update({ gesture: 'fresh', pan: 5, tilt: 0 });
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.slice(-2).map(c => c.op)).toEqual(['issue', 'slew']);
  transport.close(); await vi.advanceTimersByTimeAsync(500);
});
