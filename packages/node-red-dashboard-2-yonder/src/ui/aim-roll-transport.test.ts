// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { AimTransport } from './aim-transport.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const target = { url: '/video/cam2/aim', generation: 1, maxRate: 120, mode: 'FPV', imageDirection: 'identity',
    rollControl: { available: true, reason: null as string | null, maxRate: 10 } };
  const calls: any[] = [], changed = vi.fn();
  const fetcher = vi.fn(async (_url, options: any) => {
    const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, json: async () => ({ accepted: true,
      grant: { gesture: 'g', credential: 'c', deadline: 500 },
      next: { gesture: 'g', credential: 'c' + calls.length, deadline: 500 + calls.length * 100 } }) };
  });
  const transport = new AimTransport(() => target, changed, fetcher as any);
  return { target, calls, changed, transport };
}

it('renews a roll-only hold through the existing credential path and stops without replay', async () => {
  const f = fixture();
  f.transport.update({ gesture: 'roll-1', pan: 0, tilt: 0, roll: 2 });
  await vi.advanceTimersByTimeAsync(200);
  expect(f.calls.map(c => c.op)).toEqual(['issue', 'slew', 'slew', 'slew']);
  expect(f.calls[1]).toMatchObject({ pan: 0, tilt: 0, roll: 2, credential: 'c' });
  expect(f.changed).toHaveBeenLastCalledWith({ pan: 0, tilt: 0, roll: 2 }, null);
  f.transport.stop(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.calls.at(-1)).toEqual({ op: 'stop', gesture: 'g' });
  const count = f.calls.length;
  f.transport.update({ gesture: 'roll-1', pan: 0, tilt: 0, roll: 2 });
  await vi.advanceTimersByTimeAsync(200);
  expect(f.calls).toHaveLength(count);
  f.transport.close();
});

it.each(['missing', 'unavailable', 'over-cap', 'mixed', 'nonfinite', 'sub-wire'] as const)('does not issue a grant for %s roll input', async failure => {
  const f = fixture();
  if (failure === 'missing') delete (f.target as any).rollControl;
  if (failure === 'unavailable') f.target.rollControl.available = false;
  f.transport.update({ gesture: 'roll-1', pan: failure === 'mixed' ? 1 : 0, tilt: 0,
    roll: failure === 'over-cap' ? 11 : failure === 'nonfinite' ? NaN : failure === 'sub-wire' ? .09 : 2 });
  await vi.advanceTimersByTimeAsync(200);
  expect(f.calls).toEqual([]);
  f.transport.close();
});

it.each(['mode', 'capability', 'speed', 'transform', 'generation'] as const)('retires held roll when %s changes', async change => {
  const f = fixture();
  f.transport.update({ gesture: 'roll-1', pan: 0, tilt: 0, roll: 2 });
  await vi.advanceTimersByTimeAsync(0);
  if (change === 'mode') f.target.mode = 'Free';
  if (change === 'capability') f.target.rollControl.available = false;
  if (change === 'speed') f.target.rollControl.maxRate = 1;
  if (change === 'transform') f.target.imageDirection = 'horiz';
  if (change === 'generation') f.target.generation++;
  f.transport.refresh(); await vi.advanceTimersByTimeAsync(500);
  expect(f.calls.map(c => c.op)).toEqual(['issue', 'slew', 'stop']);
  f.transport.close();
});

it.each(['identity', '180', '90r', '90l', 'horiz', 'vert', 'ul-lr', 'ur-ll'])('maps perceived roll direction through %s without adding pan or tilt', async direction => {
  const f = fixture(); f.target.imageDirection = direction;
  f.transport.update({ gesture: 'roll-1', pan: 0, tilt: 0, roll: 2 });
  await vi.advanceTimersByTimeAsync(0);
  const reflected = ['horiz', 'vert', 'ul-lr', 'ur-ll'].includes(direction);
  expect(f.calls[1]).toMatchObject({ op: 'slew', pan: 0, tilt: 0, roll: reflected ? -2 : 2 });
  f.transport.close();
});

it('stops the pan hold before granting roll and leaves legacy pan/tilt wire shape intact', async () => {
  const f = fixture();
  f.transport.update({ gesture: 'pan-1', pan: 3, tilt: 0 }); await vi.advanceTimersByTimeAsync(0);
  expect(f.calls[1]).not.toHaveProperty('roll');
  f.transport.update({ gesture: 'roll-1', pan: 0, tilt: 0, roll: -2 }); await vi.advanceTimersByTimeAsync(300);
  expect(f.calls.slice(0, 5).map(c => c.op)).toEqual(['issue', 'slew', 'stop', 'issue', 'slew']);
  expect(f.calls[4]).toMatchObject({ pan: 0, tilt: 0, roll: -2 });
  f.transport.close();
});
