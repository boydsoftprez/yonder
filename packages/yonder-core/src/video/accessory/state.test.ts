// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeDuml, encodeDuml, type DumlCommand } from './duml.js';
import { CameraStateStore, decodeCameraPush } from './state.js';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/pocket2-state.json', import.meta.url), 'utf8'));
export function cameraFrame(name: string, id = 0x80, overrides: Partial<DumlCommand> = {}) {
    const hex = fixtures.cases.find((c: {
        name: string;
    }) => c.name === name).payloads[id.toString(16)];
    return decodeDuml(encodeDuml({ sender: 1, senderIndex: 0, receiver: 2, receiverIndex: 1,
        commandSet: 2, commandId: id, ack: 0, payload: Buffer.from(hex, 'hex'), ...overrides }))!;
}
describe('measured Pocket 2 state', () => {
    it('retains card native sizes, phases and elapsed timer independently', () => {
        expect(decodeCameraPush(cameraFrame('card-record-before2'), 100)).toMatchObject({ kind: 'status', at: 100,
            flags: 0x800200, modeCode: 1, mode: 'video', cardInserted: true, cardStateCode: 0, cardState: 'normal',
            totalSpaceRaw: 29807, freeSpaceRaw: 29234, remainingPhotos: 2384, remainingSeconds: 3955, recordState: 0 });
        expect(decodeCameraPush(cameraFrame('card-record-running2'), 110)).toMatchObject({ kind: 'status',
            recordState: 2, recordPhase: 'recording', recordingSeconds: 4, freeSpaceRaw: 29203, remainingSeconds: 3951 });
        expect(decodeCameraPush(cameraFrame('card-record-stop2'), 120)).toMatchObject({ kind: 'status',
            recordState: 3, recordPhase: 'finalizing', recordingSeconds: 0 });
        expect(decodeCameraPush(cameraFrame('photo-shot-confirm'), 130)).toMatchObject({ kind: 'status',
            flags: 0x880208, photoState: 1, storing: true, mode: 'photo' });
        expect(decodeCameraPush(cameraFrame('photo-completed'), 140)).toMatchObject({ kind: 'status',
            photoState: 0, storing: false, remainingPhotos: 2380, freeSpaceRaw: 29188 });
    });
    it('decodes exposure, shutter rational, ISO and focus from independent bench expectations', () => {
        expect(decodeCameraPush(cameraFrame('shutter1000', 0x81), 200)).toMatchObject({ kind: 'exposure',
            exposureModeCode: 4, isoCode: 3, actualIso: 100, evCode: 16, ev: 0, photoSizeCode: 5,
            recordFormatCode: 16, recordRateCode: 6, whiteBalanceCode: 0, temperatureRaw: 52,
            shutter: { raw: 0x83e8, reciprocal: true, integer: 1000, decimal: 0, numerator: 1, denominator: 1000 } });
        expect(decodeCameraPush(cameraFrame('format5_bytes', 0x81), 201)).toMatchObject({ recordRateCode: 3 });
        expect(decodeCameraPush(cameraFrame('focus_afs', 0x87), 202)).toMatchObject({ kind: 'focus', modeCode: 1, mode: 'single' });
        expect(decodeCameraPush(cameraFrame('focus_spot_quarter', 0x87), 203)).toMatchObject({ kind: 'focus',
            modeCode: 2, mode: 'continuous', point: { x: 0.25, y: 0.25 } });
    });
    it('rejects replies, wrong sources, encrypted/versioned traffic and truncated payloads', () => {
        for (const overrides of [{ sender: 4 }, { senderIndex: 1 }, { commandSet: 4 }, { response: true }, { encryption: 1 }, { version: 2 },
            { payload: Buffer.alloc(30) }])
            expect(decodeCameraPush(cameraFrame('baseline', 0x80, overrides), 10)).toBeNull();
        for (const id of [0x81, 0x87])
            expect(decodeCameraPush(cameraFrame('baseline', id, { payload: Buffer.alloc(8) }), 10)).toBeNull();
        expect(decodeCameraPush(cameraFrame('baseline'), NaN)).toBeNull();
    });
    it('preserves unknown codes without presenting them as known states', () => {
        const f = cameraFrame('baseline');
        const p = Buffer.from(f.payload);
        p[4] = 254;
        p.writeUInt32LE(0x800200 | (15 << 10), 0);
        expect(decodeCameraPush(cameraFrame('baseline', 0x80, { payload: p }), 10)).toMatchObject({ modeCode: 254, mode: null, cardStateCode: 15, cardState: null });
        const focus = Buffer.from(cameraFrame('baseline', 0x87).payload);
        focus[0] = 0xff;
        focus.writeFloatLE(NaN, 13);
        expect(decodeCameraPush(cameraFrame('baseline', 0x87, { payload: focus }), 10)).toMatchObject({ modeCode: 3, mode: null, point: null });
    });
    it('retains decimal shutter rationals and marks invalid native values unknown', () => {
        const exposure = Buffer.from(cameraFrame('baseline', 0x81).payload);
        exposure.writeUInt16LE(0x8002, 2);
        exposure[4] = 5;
        expect(decodeCameraPush(cameraFrame('baseline', 0x81, { payload: exposure }), 10)).toMatchObject({ shutter: { numerator: 10, denominator: 25, decimal: 5 } });
        exposure.writeUInt16LE(2, 2);
        expect(decodeCameraPush(cameraFrame('baseline', 0x81, { payload: exposure }), 10)).toMatchObject({ shutter: { numerator: 25, denominator: 10, reciprocal: false } });
        exposure[4] = 255;
        exposure[6] = 255;
        exposure.writeUInt32LE(0xffffffff, 43);
        expect(decodeCameraPush(cameraFrame('baseline', 0x81, { payload: exposure }), 10)).toMatchObject({ shutter: { numerator: null, denominator: null }, ev: null, actualIso: null });
        const corrupt = cameraFrame('baseline');
        corrupt.raw[15] ^= 1;
        expect(decodeCameraPush(corrupt, 10)).toBeNull();
    });
    it.each(fixtures.cases.filter((c: {
        expected?: unknown;
    }) => c.expected))('matches retained bench expectations: $name', (fixture: {
        name: string;
        expected: Record<string, unknown>;
    }) => {
        const status = decodeCameraPush(cameraFrame(fixture.name), 10);
        const exposure = decodeCameraPush(cameraFrame(fixture.name, 0x81), 10);
        const focus = decodeCameraPush(cameraFrame(fixture.name, 0x87), 10);
        if (status?.kind !== 'status' || exposure?.kind !== 'exposure' || focus?.kind !== 'focus')
            throw new Error('fixture did not decode');
        const actual = { mode: status.mode, cardInserted: status.cardInserted, recording: status.recordState === 2, recordingSeconds: status.recordingSeconds,
            exposureMode: exposure.exposureModeCode, isoCode: exposure.isoCode, iso: exposure.actualIso, shutterDenominator: exposure.shutter.denominator,
            focusMode: focus.modeCode, focusPoint: focus.point, photoSizeCode: exposure.photoSizeCode, recordRateCode: exposure.recordRateCode };
        expect(actual).toMatchObject(fixture.expected);
    });
    it('keeps immutable independent snapshots and expires each block on monotonic age', () => {
        const store = new CameraStateStore();
        expect(store.read(0, 500)).toEqual({ status: null, exposure: null, focus: null, batteryPercent: null });
        store.update(cameraFrame('baseline'), 100);
        store.update(cameraFrame('shutter1000', 0x81), 200);
        const old = store.read(300, 500);
        expect(Object.isFrozen(old.status)).toBe(true);
        store.update(cameraFrame('card-record-running2'), 400);
        expect(old.status?.cardInserted).toBe(false);
        expect(store.read(650, 500)).toMatchObject({ status: { recordState: 2 }, exposure: { actualIso: 100 }, focus: null, batteryPercent: null });
        expect(store.read(700, 500).exposure).toBeNull();
        expect(store.update(cameraFrame('baseline'), 399)).toBe(false);
        expect(store.update(cameraFrame('baseline', 0x80, { payload: Buffer.alloc(2) }), 700)).toBe(false);
        expect(store.read(900, 500).status).toBeNull();
        store.reset();
        expect(store.read(901, 500).status).toBeNull();
    });
});
