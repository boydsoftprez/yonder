// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AccessoryWriter } from './writer.js';
import type { IntentClock } from './intent.js';

const clock: IntentClock = { now: () => 1000, setTimer: (ms, fn) => setTimeout(fn, ms), clearTimer: token => clearTimeout(token as NodeJS.Timeout) };
const command = { commandSet: 4, commandId: 12, payload: Buffer.from([1]) };
const options = () => ({ signal: new AbortController().signal, deadline: 1500, admission: () => true });

describe('bounded accessory writer arbitration', () => {
  it('retains exactly one waiter, preserves its original dispatch checks and never overlaps endpoint I/O', async () => {
    let release!: () => void; let active = false; const sent: any[] = [];
    const endpoint = vi.fn(async (cmd, opts) => {
      expect(active).toBe(false); active = true; sent.push({ cmd, opts });
      try { if (sent.length === 1) await new Promise<void>(done => { release = done; }); }
      finally { active = false; }
    });
    const writer = new AccessoryWriter(clock, endpoint);
    const first = writer.write(command, options()); const held = options(); const second = writer.write(command, held);
    await expect(writer.write(command, options())).rejects.toThrow('capacity exceeded'); expect(sent).toHaveLength(1);
    release(); await Promise.all([first, second]); expect(sent).toHaveLength(2);
    expect(sent[1].opts).toEqual(held); expect(sent[1].opts.admission).toBe(held.admission); expect(sent[1].opts.signal).toBe(held.signal);
  });
  it('removes a canceled waiter before the active endpoint completes', async () => {
    let release!: () => void;
    const endpoint = vi.fn(() => new Promise<void>(done => { release = done; }));
    const writer = new AccessoryWriter(clock, endpoint); const first = writer.write(command, options());
    const controller = new AbortController(); const waiting = writer.write(command, { ...options(), signal: controller.signal });
    controller.abort(); await expect(waiting).rejects.toThrow('canceled');
    release(); await first; expect(endpoint).toHaveBeenCalledOnce();
  });
});
