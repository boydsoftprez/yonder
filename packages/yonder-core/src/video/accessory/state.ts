// SPDX-License-Identifier: GPL-3.0-or-later
import { decodeDuml, type DumlFrame } from './duml.js';
/** Native shutter wire value. decimal is tenths; no V4L2 exposure units. */
export interface CameraShutter {
    readonly raw: number;
    readonly reciprocal: boolean;
    readonly integer: number;
    readonly decimal: number;
    readonly numerator: number | null;
    readonly denominator: number | null;
}
export interface CameraStatus {
    readonly kind: 'status';
    readonly at: number;
    readonly flags: number;
    readonly modeCode: number;
    readonly mode: 'photo' | 'video' | null;
    readonly cardInserted: boolean;
    readonly cardStateCode: number;
    readonly cardState: 'normal' | 'absent' | null;
    /** Native sizes; bench is consistent with MiB. Retain native units until measured independently. */
    readonly totalSpaceRaw: number;
    readonly freeSpaceRaw: number;
    readonly remainingPhotos: number;
    readonly remainingSeconds: number;
    readonly recordState: number;
    readonly recordPhase: 'idle' | 'starting' | 'recording' | 'finalizing';
    readonly photoState: number;
    readonly storing: boolean;
    readonly recordingSeconds: number;
}
export interface CameraExposure {
    readonly kind: 'exposure';
    readonly at: number;
    readonly exposureModeCode: number;
    readonly shutter: CameraShutter;
    readonly actualShutter: CameraShutter;
    readonly isoCode: number;
    readonly actualIso: number | null;
    readonly evCode: number;
    readonly ev: number | null;
    readonly whiteBalanceCode: number;
    readonly temperatureRaw: number;
    readonly photoSizeCode: number;
    readonly recordFormatCode: number;
    readonly recordRateCode: number;
}
export interface CameraFocus {
    readonly kind: 'focus';
    readonly at: number;
    readonly modeCode: number;
    readonly mode: 'single' | 'continuous' | null;
    readonly point: Readonly<{
        x: number;
        y: number;
    }> | null;
}
export type CameraPush = CameraStatus | CameraExposure | CameraFocus;
export interface CameraState {
    readonly status: CameraStatus | null;
    readonly exposure: CameraExposure | null;
    readonly focus: CameraFocus | null;
    readonly batteryPercent: null;
}
function shutter(p: Buffer, offset: number): CameraShutter {
    const raw = p.readUInt16LE(offset), reciprocal = !!(raw & 0x8000), integer = raw & 0x7fff, decimal = p[offset + 2];
    const value = integer * 10 + decimal, valid = decimal <= 9 && value > 0;
    return Object.freeze({ raw, reciprocal, integer, decimal,
        numerator: valid ? (reciprocal ? 10 : value) / (decimal === 0 ? 10 : 1) : null,
        denominator: valid ? (reciprocal ? value : 10) / (decimal === 0 ? 10 : 1) : null });
}
/** Revalidates the raw DUML envelope; timestamps belong to the transport's monotonic clock. */
export function decodeCameraPush(input: DumlFrame, at: number): CameraPush | null {
    if (!Number.isFinite(at) || at < 0)
        return null;
    const frame = decodeDuml(input.raw);
    if (!frame || frame.sender !== 1 || frame.senderIndex !== 0 || frame.commandSet !== 2 || frame.response
        || frame.encryption !== 0 || frame.version !== 1)
        return null;
    const p = Buffer.from(frame.payload);
    if (frame.commandId === 0x80 && p.length >= 31) {
        const flags = p.readUInt32LE(0), modeCode = p[4], cardStateCode = (flags >>> 10) & 15, recordState = (flags >>> 6) & 3;
        return Object.freeze({ kind: 'status', at, flags, modeCode, mode: modeCode === 0 ? 'photo' : modeCode === 1 ? 'video' : null,
            cardInserted: !!(flags & 0x200), cardStateCode, cardState: cardStateCode === 0 ? 'normal' : cardStateCode === 1 ? 'absent' : null,
            totalSpaceRaw: p.readUInt32LE(5), freeSpaceRaw: p.readUInt32LE(9), remainingPhotos: p.readUInt32LE(13),
            remainingSeconds: p.readUInt32LE(17), recordState, recordPhase: (['idle', 'starting', 'recording', 'finalizing'] as const)[recordState],
            photoState: (flags >>> 3) & 7, storing: !!(flags & 0x80000), recordingSeconds: p.readUInt16LE(29) });
    }
    if (frame.commandId === 0x81 && p.length >= 48) {
        const actualIso = p.readUInt32LE(43), evCode = p[6];
        return Object.freeze({ kind: 'exposure', at, exposureModeCode: p[20], shutter: shutter(p, 2), actualShutter: shutter(p, 40),
            isoCode: p[5], actualIso: actualIso === 0 || actualIso === 0xffffffff ? null : actualIso,
            evCode, ev: evCode >= 4 && evCode <= 28 ? (evCode - 16) / 3 : null,
            whiteBalanceCode: p[23], temperatureRaw: p[24], photoSizeCode: p[9], recordFormatCode: p[13], recordRateCode: p[14] });
    }
    if (frame.commandId === 0x87 && p.length >= 21) {
        const modeCode = p[0] & 3, x = p.readFloatLE(13), y = p.readFloatLE(17);
        return Object.freeze({ kind: 'focus', at, modeCode, mode: modeCode === 1 ? 'single' : modeCode === 2 ? 'continuous' : null,
            point: Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? Object.freeze({ x, y }) : null });
    }
    return null;
}
/** A malformed push never refreshes a previous block. Reset on every link generation change. */
export class CameraStateStore {
    private state: CameraState = { status: null, exposure: null, focus: null, batteryPercent: null };
    update(frame: DumlFrame, at: number): boolean {
        const push = decodeCameraPush(frame, at);
        if (!push || (this.state[push.kind]?.at ?? -Infinity) >= at)
            return false;
        this.state = Object.freeze({ ...this.state, [push.kind]: push });
        return true;
    }
    read(now: number, maxAgeMs: number): CameraState {
        if (!Number.isFinite(now) || now < 0 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0)
            throw new RangeError('Invalid state freshness');
        const fresh = <T extends CameraPush>(p: T | null): T | null => p && now >= p.at && now - p.at < maxAgeMs ? p : null;
        return Object.freeze({ status: fresh(this.state.status), exposure: fresh(this.state.exposure), focus: fresh(this.state.focus), batteryPercent: null });
    }
    reset(): void { this.state = { status: null, exposure: null, focus: null, batteryPercent: null }; }
}
