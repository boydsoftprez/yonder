// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraController, encodeCameraCommand, cameraControlDescriptors } from './controls.js';
import { decodeDuml, encodeDuml, type DumlCommand, type DumlFrame } from './duml.js';
import type { AccessoryCommandOptions } from './aoa.js';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/pocket2-state.json', import.meta.url), 'utf8'));
function frame(name: string, id = 0x80, change?: (p: Buffer) => void): DumlFrame {
    const p = Buffer.from(fixtures.cases.find((c: {
        name: string;
    }) => c.name === name).payloads[id.toString(16)], 'hex');
    change?.(p);
    return decodeDuml(encodeDuml({ sender: 1, senderIndex: 0, commandSet: 2, commandId: id, ack: 0, payload: p }))!;
}
function harness(hold = false) {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const writes: {
        command: Omit<DumlCommand, 'sequence'>;
        options: AccessoryCommandOptions;
    }[] = [];
    const release: (() => void)[] = [];
    const camera = new CameraController({ clock: { now: () => Date.now(), setTimer: (ms, cb) => setTimeout(cb, ms), clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>) },
        stateMaxAgeMs: 500, operationTimeoutMs: 2000, write: async (command, options) => {
            writes.push({ command, options });
            if (hold)
                await new Promise<void>(r => release.push(r));
            if (options.signal?.aborted || options.admission?.() === false)
                throw new Error('dispatch refused');
        } });
    function push(name: string, id = 0x80, change?: (p: Buffer) => void) { vi.advanceTimersByTime(1); camera.update(frame(name, id, change)); }
    push('card-record-before2');
    return { camera, writes, release, push };
}
const flush = async () => { for (let i = 0; i < 8; i++)
    await Promise.resolve(); };
afterEach(() => vi.useRealTimers());
describe('camera native encoding and availability', () => {
    it.each([
        [{ kind: 'record-start' }, 2, '01'], [{ kind: 'record-stop' }, 2, '00'], [{ kind: 'photo' }, 1, '01'],
        [{ kind: 'mode', value: 0 }, 0x10, '00'], [{ kind: 'exposure-mode', value: 4 }, 0x1e, '0400'],
        [{ kind: 'iso', value: 3 }, 0x2a, '03'], [{ kind: 'ev', value: 10 }, 0x2e, '0a'],
        [{ kind: 'shutter', value: { reciprocal: true, integer: 1000, decimal: 0 } }, 0x28, '01e88300'],
        [{ kind: 'focus-mode', value: 1 }, 0x24, '01'], [{ kind: 'focus-point', value: { x: 0.25, y: 0.25 } }, 0x30, '0000803e0000803e'],
        [{ kind: 'photo-size', value: 4 }, 0x12, '0401'], [{ kind: 'record-format', value: { format: 16, rate: 3 } }, 0x18, '1003010000'],
    ])('encodes measured command %j exactly', (input, id, hex) => {
        const wire = encodeCameraCommand(input);
        expect(wire).toMatchObject({ receiver: 1, commandSet: 2, commandId: id });
        expect(Buffer.from(wire.payload!).toString('hex')).toBe(hex);
    });
    it.each([null, {}, { kind: 'iso', value: NaN }, { kind: 'iso', value: 4 }, { kind: 'iso', value: '3' },
        { kind: 'mode', value: 2 }, { kind: 'photo', unexpected: true }, { kind: 'shutter', value: { reciprocal: true, integer: 60, decimal: NaN } },
        { kind: 'shutter', value: { reciprocal: false, integer: 60, decimal: 0 } }, { kind: 'focus-point', value: { x: Infinity, y: 0.5 } },
        { kind: 'focus-point', value: { x: 0.4, y: 0.5 } }, { kind: 'record-format', value: { format: 16, rate: 6, extra: 1 } },
        { kind: 'colour', value: 0 }, { kind: 'white-balance', value: 1 }, { kind: 'gain', value: 100 }])('rejects malformed or unmeasured value %j', input => {
        expect(() => encodeCameraCommand(input)).toThrow();
    });
    it('keeps measured options and unavailable controls honest without a fabricated linear shutter range', () => {
        const descriptors = cameraControlDescriptors();
        expect(descriptors.find(d => d.key === 'iso')).toMatchObject({ kind: 'menu', values: [3, 5, 8], evidence: 'measured' });
        expect(descriptors.find(d => d.key === 'shutter')).toMatchObject({ kind: 'shutter', unit: 's' });
        expect(descriptors.find(d => d.key === 'shutter')).not.toHaveProperty('step');
        const iso = descriptors.find(d => d.key === 'iso');
        if (iso?.kind !== 'menu')
            throw new Error('ISO menu missing');
        expect(iso.toDisplay(3)).toBe(100);
        expect(iso.toRaw(400)).toBe(5);
        expect(() => iso.toRaw(200)).toThrow();
        const ev = descriptors.find(d => d.key === 'ev');
        if (ev?.kind !== 'menu')
            throw new Error('EV menu missing');
        expect(ev.toDisplay(10)).toBe(-2);
        expect(ev.toRaw(0)).toBe(16);
        for (const key of ['colour', 'filter', 'white-balance', 'zoom', 'live-format'])
            expect(descriptors.find(d => d.key === key)).toMatchObject({ kind: 'unavailable', reason: expect.any(String) });
    });
});
describe('observed camera operations', () => {
    it('does not complete record on dispatch/ack and rejects competing operations', async () => {
        const h = harness();
        let complete = false;
        const op = h.camera.execute({ kind: 'record-start' }).then(r => { complete = true; return r; });
        await flush();
        expect(complete).toBe(false);
        await expect(h.camera.execute({ kind: 'mode', value: 0 })).rejects.toThrow('busy');
        const ack = decodeDuml(encodeDuml({ sender: 1, senderIndex: 0, commandSet: 2, commandId: 2, response: true, payload: Buffer.from([1]) }))!;
        h.camera.update(ack);
        await flush();
        expect(complete).toBe(false);
        h.push('card-record-running2');
        await expect(op).resolves.toMatchObject({ completed: true, state: { status: { recordState: 2 } } });
        expect(h.writes).toHaveLength(1);
    });
    it('waits through finalization with timer zero until record state is idle', async () => {
        const h = harness();
        h.push('card-record-running2');
        let complete = false;
        const op = h.camera.execute({ kind: 'record-stop' }).then(r => { complete = true; return r; });
        await flush();
        h.push('card-record-stop2');
        await flush();
        expect(complete).toBe(false);
        h.push('photo-idle-before');
        await expect(op).resolves.toMatchObject({ completed: true, state: { status: { recordState: 0 } } });
    });
    it('changes to observed photo mode, then requires photo phase and idle plus storage effect', async () => {
        const h = harness();
        let complete = false;
        const op = h.camera.execute({ kind: 'photo' }).then(r => { complete = true; return r; });
        await flush();
        expect(h.writes.map(w => w.command.commandId)).toEqual([0x10]);
        h.push('photo-ready');
        await flush();
        expect(h.writes.map(w => w.command.commandId)).toEqual([0x10, 1]);
        h.push('photo-ready');
        await flush();
        expect(complete).toBe(false);
        h.push('photo-shot-confirm');
        h.push('photo-ready');
        await flush();
        expect(complete).toBe(false);
        h.push('photo-completed');
        await expect(op).resolves.toMatchObject({ completed: true, capture: { destination: 'camera', kind: 'photo' } });
        expect((await op).capture).not.toHaveProperty('filename');
        expect(h.writes).toHaveLength(2);
    });
    it('does not treat a storage change without a photo phase as success', async () => {
        const h = harness();
        h.push('photo-ready');
        const op = h.camera.execute({ kind: 'photo' });
        const rejected = expect(op).rejects.toThrow('timeout');
        await flush();
        h.push('photo-completed');
        vi.advanceTimersByTime(2000);
        await rejected;
    });
    it('refuses absent/unknown/stale card and refuses mode/settings while finalizing', async () => {
        const h = harness();
        h.push('baseline');
        await expect(h.camera.execute({ kind: 'record-start' })).rejects.toThrow('card');
        h.push('card-record-before2', 0x80, p => p.writeUInt32LE(0x803e00, 0));
        await expect(h.camera.execute({ kind: 'photo' })).rejects.toThrow('card');
        h.push('card-record-stop2');
        await expect(h.camera.execute({ kind: 'mode', value: 0 })).rejects.toThrow('idle');
        await expect(h.camera.execute({ kind: 'focus-mode', value: 1 })).rejects.toThrow('idle');
        vi.advanceTimersByTime(500);
        await expect(h.camera.execute({ kind: 'record-start' })).rejects.toThrow('state');
        expect(h.writes).toHaveLength(0);
    });
    it('rechecks admission at delayed transport dispatch', async () => {
        const h = harness(true);
        const op = h.camera.execute({ kind: 'record-start' });
        const rejected = expect(op).rejects.toThrow();
        h.push('baseline');
        h.release[0]();
        await rejected;
        expect(h.writes[0].options.signal?.aborted).toBe(true);
    });
    it('ignores matching readback from before actual dispatch', async () => {
        const h = harness(true);
        let done = false;
        const op = h.camera.execute({ kind: 'record-start' }).then(r => { done = true; return r; });
        const rejection = expect(op).rejects.toThrow();
        h.push('card-record-running2');
        h.release[0]();
        await rejection;
        expect(done).toBe(false);
    });
    it('expires queued work, aborts transport, rejects delayed pushes and never replays after reconnect', async () => {
        const h = harness(true);
        const op = h.camera.execute({ kind: 'record-start' }, { deadline: Date.now() + 20 });
        const rejected = expect(op).rejects.toThrow('timeout');
        vi.advanceTimersByTime(20);
        await rejected;
        expect(h.writes[0].options.signal?.aborted).toBe(true);
        expect(h.writes[0].options.admission?.()).toBe(false);
        h.release[0]();
        h.push('card-record-running2');
        h.camera.disconnect();
        h.camera.connect();
        await flush();
        expect(h.camera.readState().status).toBeNull();
        expect(h.writes).toHaveLength(1);
    });
    it('checks the absolute deadline even when the expiry timer callback is late', async () => {
        let now=1000;
        const camera=new CameraController({clock:{now:()=>now,setTimer:()=>1,clearTimer:()=>{}},write:async(_command,options)=>{options.admission?.();}});
        camera.update(frame('card-record-before2'));
        const op=camera.execute({kind:'record-start'},{deadline:1010});const rejected=expect(op).rejects.toThrow('timeout');
        await flush();now=1010;camera.update(frame('card-record-running2'));await rejected;
    });
    it('holds a matching push until the actual write completes', async () => {
        let now=1000, release:()=>void=()=>{};
        const camera=new CameraController({clock:{now:()=>now,setTimer:()=>1,clearTimer:()=>{}},write:async(_command,options)=>{
            options.admission?.();await new Promise<void>(r=>release=r);
        }});
        camera.update(frame('card-record-before2'));
        let done=false;const op=camera.execute({kind:'record-start'}).then(r=>{done=true;return r;});
        now++;camera.update(frame('card-record-running2'));await flush();expect(done).toBe(false);
        release();await expect(op).resolves.toMatchObject({completed:true});
    });
    it('disconnect and caller cancellation reject without needing another push', async () => {
        const h = harness();
        const op = h.camera.execute({ kind: 'record-start' });
        const rejected = expect(op).rejects.toThrow('disconnected');
        h.camera.disconnect();
        await rejected;
        h.camera.connect();
        h.push('card-record-before2');
        const abort = new AbortController();
        const second = h.camera.execute({ kind: 'photo' }, { signal: abort.signal });
        const cancelled = expect(second).rejects.toThrow('cancelled');
        abort.abort();
        await cancelled;
    });
    it('allows a stop to cancel pending start without credentials or a normal card', async () => {
        const h = harness();
        const start = h.camera.execute({ kind: 'record-start' });
        const cancelled = expect(start).rejects.toThrow('cancelled');
        await flush();
        const stop = h.camera.execute({ kind: 'record-stop' });
        await cancelled;
        await flush();
        h.push('baseline');
        await expect(stop).resolves.toMatchObject({ completed: true });
        expect(h.writes.map(w => Buffer.from(w.command.payload!).toString('hex'))).toEqual(['01', '00']);
    });
    it('gates ISO on observed manual exposure and reports only actual matching control readback', async () => {
        const h = harness();
        h.push('baseline', 0x81);
        await expect(h.camera.execute({ kind: 'iso', value: 3 })).rejects.toThrow('manual');
        h.push('manual', 0x81);
        const op = h.camera.execute({ kind: 'iso', value: 3 });
        await flush();
        h.push('iso100', 0x81);
        await expect(op).resolves.toMatchObject({ state: { exposure: { isoCode: 3, actualIso: 100 } } });
        const shutter = h.camera.execute({ kind: 'shutter', value: { reciprocal: true, integer: 1000, decimal: 0 } });
        await flush();
        h.push('shutter60fixed', 0x81);
        let done = false;
        void shutter.then(() => done = true);
        await flush();
        expect(done).toBe(false);
        h.push('shutter1000', 0x81);
        await shutter;
    });
    it('does not invent a video capture when a stop only reconfirms idle', async () => {
        const h = harness();
        const op = h.camera.execute({ kind: 'record-stop' });
        await flush();
        h.push('card-record-before2');
        expect(await op).not.toHaveProperty('capture');
    });
    it('does not confuse card removal with a saved photo', async () => {
        const h = harness();
        h.push('photo-ready');
        const op = h.camera.execute({ kind: 'photo' });
        const rejected = expect(op).rejects.toThrow('timeout');
        await flush();
        h.push('photo-shot-confirm');
        h.push('photo_mode');
        vi.advanceTimersByTime(2000);
        await rejected;
    });
    it('does not accept an unknown photo phase as the measured shot transition', async () => {
        const h = harness();
        h.push('photo-ready');
        const op = h.camera.execute({ kind: 'photo' });
        const rejected = expect(op).rejects.toThrow('timeout');
        await flush();
        h.push('photo-shot-confirm', 0x80, p => p.writeUInt32LE(0x880238, 0));
        h.push('photo-completed');
        vi.advanceTimersByTime(2000);
        await rejected;
    });
    it('does not confirm a setting while its operational state has expired', async () => {
        const h = harness();
        const op = h.camera.execute({ kind: 'focus-mode', value: 1 });
        const rejected = expect(op).rejects.toThrow('timeout');
        await flush();
        vi.advanceTimersByTime(500);
        h.push('focus_afs', 0x87);
        vi.advanceTimersByTime(1500);
        await rejected;
    });
    it('requires matching mode/format/point and does not let other fresh blocks confirm a control', async () => {
        const h = harness();
        const op = h.camera.execute({ kind: 'focus-point', value: { x: 0.25, y: 0.25 } });
        await flush();
        h.push('focus_spot_center', 0x87);
        h.push('card-record-before2');
        let done = false;
        void op.then(() => done = true);
        await flush();
        expect(done).toBe(false);
        h.push('focus_spot_quarter', 0x87);
        await op;
        const format = h.camera.execute({ kind: 'record-format', value: { format: 16, rate: 3 } });
        await flush();
        h.push('format5_bytes', 0x81);
        await format;
    });
});
