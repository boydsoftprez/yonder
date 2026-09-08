// SPDX-License-Identifier: GPL-3.0-or-later
import type { DumlCommand, DumlFrame } from './duml.js';
import type { AccessoryCommandOptions } from './aoa.js';
import type { IntentClock } from './intent.js';
import type { ControlDescriptor } from '../descriptors.js';
import { CameraStateStore, type CameraState, type CameraStatus } from './state.js';
export type CameraCommand = {
    readonly kind: 'record-start' | 'record-stop' | 'photo';
} | {
    readonly kind: 'mode';
    readonly value: 0 | 1;
} | {
    readonly kind: 'exposure-mode';
    readonly value: 1 | 2 | 4;
} | {
    readonly kind: 'iso';
    readonly value: 3 | 5 | 8;
} | {
    readonly kind: 'ev';
    readonly value: 10 | 16;
} | {
    readonly kind: 'shutter';
    readonly value: Readonly<{
        reciprocal: true;
        integer: 60 | 1000;
        decimal: 0;
    }>;
} | {
    readonly kind: 'focus-mode';
    readonly value: 1 | 2;
} | {
    readonly kind: 'focus-point';
    readonly value: Readonly<{
        x: number;
        y: number;
    }>;
} | {
    readonly kind: 'photo-size';
    readonly value: 4 | 5;
} | {
    readonly kind: 'record-format';
    readonly value: Readonly<{
        format: 16;
        rate: 3 | 6;
    }>;
};
/** Source-specific shape: scalar menus can share generic labels/units, while rational shutter and 2D focus cannot use a linear ControlDescriptor. */
export type CameraControlDescriptor = (Pick<ControlDescriptor, 'label' | 'unit' | 'toDisplay' | 'toRaw' | 'openWhen'> & {
    readonly key: string;
    readonly kind: 'menu';
    readonly evidence: 'measured';
    readonly values: readonly number[];
}) | {
    readonly key: string;
    readonly label: string;
    readonly kind: 'shutter' | 'point';
    readonly unit: string;
    readonly evidence: 'measured';
    readonly values: readonly Readonly<Record<string, number | boolean>>[];
} | {
    readonly key: string;
    readonly label: string;
    readonly kind: 'unavailable';
    readonly reason: string;
};
const menu = (key: string, label: string, values: number[], unit = '', shown = values): CameraControlDescriptor => Object.freeze({
    key, label, kind: 'menu', unit, evidence: 'measured', values: Object.freeze(values),
    toDisplay: (raw: number) => shown[values.indexOf(option(raw, values))],
    toRaw: (display: number) => values[shown.indexOf(option(display, shown))],
    ...(key === 'iso' ? { openWhen: (mode: number) => mode === 4 } : {}),
});
const DESCRIPTORS: readonly CameraControlDescriptor[] = Object.freeze([
    menu('mode', 'Camera mode', [0, 1]), menu('exposure-mode', 'Exposure mode', [1, 2, 4]), menu('iso', 'ISO', [3, 5, 8], 'ISO', [100, 400, 3200]),
    menu('ev', 'Exposure compensation', [10, 16], 'EV', [-2, 0]), menu('focus-mode', 'Autofocus', [1, 2]),
    menu('photo-size', 'Photo size code', [4, 5]), menu('record-format', 'Recording rate code (format 16)', [3, 6]),
    Object.freeze({ key: 'shutter', label: 'Shutter', kind: 'shutter', unit: 's', evidence: 'measured', values: Object.freeze([
            Object.freeze({ reciprocal: true, integer: 60, decimal: 0 }), Object.freeze({ reciprocal: true, integer: 1000, decimal: 0 })
        ]) }),
    Object.freeze({ key: 'focus-point', label: 'Focus point', kind: 'point', unit: 'normalized coordinates', evidence: 'measured', values: Object.freeze([
            Object.freeze({ x: 0.25, y: 0.25 }), Object.freeze({ x: 0.5, y: 0.5 })
        ]) }),
    ...[
        ['white-balance', 'White balance', 'Effect was observed, but exact measured option payloads are not yet retained.'],
        ['colour', 'Colour', 'Command 0x3e returned e0 with no observable effect.'],
        ['filter', 'Filter', 'Command 0x42 had no observable effect.'],
        ['zoom', 'Digital zoom', 'No change to the live USB feed was observed.'],
        ['live-format', 'Live format', 'Native USB video is fixed at 1280×720, approximately 29.97 fps; recording format does not configure it.'],
    ].map(([key, label, reason]) => Object.freeze({ key, label, kind: 'unavailable' as const, reason })),
]);
export function cameraControlDescriptors(): readonly CameraControlDescriptor[] { return DESCRIPTORS; }
function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
        || keys.some(k => !Object.hasOwn(value, k)))
        throw new TypeError('Malformed camera command');
    return value as Record<string, unknown>;
}
function option(value: unknown, values: readonly number[]): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !values.includes(value))
        throw new RangeError('Unmeasured camera option');
    return value;
}
/** Validates unknown boundary input before any admission or physical write. Only measured options are encodable. */
export function encodeCameraCommand(input: unknown): Omit<DumlCommand, 'sequence'> {
    const kind = (input as {
        kind?: unknown;
    } | null)?.kind;
    const c = object(input, ['record-start', 'record-stop', 'photo'].includes(String(kind)) ? ['kind'] : ['kind', 'value']);
    let id: number, payload: Buffer;
    switch (kind) {
        case 'record-start':
            id = 2;
            payload = Buffer.from([1]);
            break;
        case 'record-stop':
            id = 2;
            payload = Buffer.from([0]);
            break;
        case 'photo':
            id = 1;
            payload = Buffer.from([1]);
            break;
        case 'mode':
            id = 0x10;
            payload = Buffer.from([option(c.value, [0, 1])]);
            break;
        case 'exposure-mode':
            id = 0x1e;
            payload = Buffer.from([option(c.value, [1, 2, 4]), 0]);
            break;
        case 'iso':
            id = 0x2a;
            payload = Buffer.from([option(c.value, [3, 5, 8])]);
            break;
        case 'ev':
            id = 0x2e;
            payload = Buffer.from([option(c.value, [10, 16])]);
            break;
        case 'focus-mode':
            id = 0x24;
            payload = Buffer.from([option(c.value, [1, 2])]);
            break;
        case 'photo-size':
            id = 0x12;
            payload = Buffer.from([option(c.value, [4, 5]), 1]);
            break;
        case 'record-format': {
            const v = object(c.value, ['format', 'rate']);
            id = 0x18;
            payload = Buffer.from([option(v.format, [16]), option(v.rate, [3, 6]), 1, 0, 0]);
            break;
        }
        case 'shutter': {
            const v = object(c.value, ['reciprocal', 'integer', 'decimal']);
            if (v.reciprocal !== true)
                throw new RangeError('Unmeasured shutter option');
            id = 0x28;
            payload = Buffer.alloc(4);
            payload[0] = 1;
            payload.writeUInt16LE(option(v.integer, [60, 1000]) | 0x8000, 1);
            payload[3] = option(v.decimal, [0]);
            break;
        }
        case 'focus-point': {
            const v = object(c.value, ['x', 'y']);
            const x = option(v.x, [0.25, 0.5]), y = option(v.y, [0.25, 0.5]);
            if (x !== y)
                throw new RangeError('Unmeasured focus point');
            id = 0x30;
            payload = Buffer.alloc(8);
            payload.writeFloatLE(x, 0);
            payload.writeFloatLE(y, 4);
            break;
        }
        default: throw new RangeError('Unsupported camera control');
    }
    return { receiver: 1, commandSet: 2, commandId: id, ack: 1, payload };
}
export interface CameraOperationResult {
    readonly completed: true;
    readonly state: CameraState;
    readonly capture?: Readonly<{
        destination: 'camera';
        kind: 'photo' | 'video';
    }>;
}
export interface CameraControllerOptions {
    readonly clock: IntentClock;
    /** Must call admission at actual serialized dispatch, respect signal/deadline, and resolve after I/O. */
    readonly write: (command: Omit<DumlCommand, 'sequence'>, options: AccessoryCommandOptions) => Promise<void>;
    readonly stateMaxAgeMs?: number;
    readonly operationTimeoutMs?: number;
}
interface Stage {
    command: CameraCommand;
    after?: number;
    written: boolean;
    photoSeen: boolean;
    captureMediumContinuous: boolean;
    baseline: CameraStatus | null;
}
interface Operation {
    command: CameraCommand;
    deadline: number;
    abort: AbortController;
    timer?: unknown;
    stage?: Stage;
    cleanup: () => void;
    resolve: (result: CameraOperationResult) => void;
    reject: (error: Error) => void;
}
/** One operator operation per camera, no retries/reconnect replay. R-CAM-15/17/18, R-CTL-10. */
export class CameraController {
    private readonly store = new CameraStateStore();
    private readonly maxAge: number;
    private readonly timeout: number;
    private available = true;
    private closed = false;
    private active?: Operation;
    constructor(private readonly options: CameraControllerOptions) {
        this.maxAge = options.stateMaxAgeMs ?? 500;
        this.timeout = options.operationTimeoutMs ?? 5000;
        if (!Number.isFinite(this.maxAge) || this.maxAge <= 0 || !Number.isFinite(this.timeout) || this.timeout <= 0)
            throw new RangeError('Invalid camera timing');
    }
    readState(): CameraState { return this.store.read(this.options.clock.now(), this.maxAge); }
    update(frame: DumlFrame, at = this.options.clock.now()): boolean {
        if (!this.available || this.closed || at > this.options.clock.now())
            return false;
        const changed = this.store.update(frame, at);
        if (changed && this.active)
            this.observe(this.active);
        return changed;
    }
    disconnect(): void { this.available = false; if (this.active)
        this.fail(this.active, 'disconnected'); this.store.reset(); }
    connect(): void { if (!this.closed) {
        this.disconnect();
        this.available = true;
    } }
    close(): void { this.closed = true; this.disconnect(); }
    async execute(input: unknown, request: {
        deadline?: number;
        signal?: AbortSignal;
    } = {}): Promise<CameraOperationResult> {
        encodeCameraCommand(input);
        // Own the validated command so a caller cannot change it while queued.
        const command = structuredClone(input) as CameraCommand;
        const deadline = request.deadline ?? this.options.clock.now() + this.timeout;
        if (!Number.isFinite(deadline) || deadline <= this.options.clock.now())
            throw new Error('Camera operation timeout');
        if (!this.available || this.closed)
            throw new Error('Camera disconnected');
        if (request.signal?.aborted)
            throw new Error('Camera operation cancelled');
        if (this.active) {
            if (command.kind !== 'record-stop' || this.active.command.kind !== 'record-start')
                throw new Error('Camera busy');
            this.fail(this.active, 'cancelled by stop');
        }
        this.guard(command);
        return new Promise<CameraOperationResult>((resolve, reject) => {
            const op: Operation = { command, deadline, abort: new AbortController(), resolve, reject, cleanup: () => { } };
            this.active = op;
            const cancel = () => this.fail(op, 'cancelled');
            request.signal?.addEventListener('abort', cancel, { once: true });
            op.cleanup = () => request.signal?.removeEventListener('abort', cancel);
            op.timer = this.options.clock.setTimer(Math.max(0, deadline - this.options.clock.now()), () => this.fail(op, 'timeout'));
            this.send(op, command.kind === 'photo' && this.readState().status?.mode !== 'photo' ? { kind: 'mode', value: 0 } : command);
        });
    }
    private guard(command: CameraCommand): void {
        const state = this.readState(), s = state.status;
        if (!s)
            throw new Error('Camera state unknown or stale');
        // A stop remains legal with an absent/failed card, and never asks for a fresh motion credential.
        if (command.kind === 'record-stop')
            return;
        if (s.recordState !== 0 || s.photoState !== 0 || s.storing)
            throw new Error('Camera must be idle');
        if (s.mode === null)
            throw new Error('Camera mode unknown');
        if (command.kind === 'record-start' || command.kind === 'photo') {
            if (!s.cardInserted || s.cardState !== 'normal')
                throw new Error('Camera card absent or not recognized as normal');
            if (command.kind === 'record-start' && s.mode !== 'video')
                throw new Error('Camera must be in video mode');
        }
        if (command.kind === 'iso' && state.exposure?.exposureModeCode !== 4)
            throw new Error('ISO requires observed manual exposure');
        if (command.kind === 'shutter' && state.exposure?.exposureModeCode !== 4)
            throw new Error('Shutter requires observed manual exposure; priority clamps remain unverified as exact settings');
        if (command.kind === 'ev' && ![1, 2].includes(state.exposure?.exposureModeCode ?? -1))
            throw new Error('EV requires observed automatic exposure');
        if (command.kind === 'record-format' && s.mode !== 'video')
            throw new Error('Recording format requires video mode');
        if (command.kind === 'photo-size' && s.mode !== 'photo')
            throw new Error('Photo size requires photo mode');
    }
    private valid(op: Operation): boolean {
        if (this.active !== op || op.abort.signal.aborted)
            return false;
        if (!this.available || this.closed) {
            this.fail(op, 'disconnected');
            return false;
        }
        if (this.options.clock.now() >= op.deadline) {
            this.fail(op, 'timeout');
            return false;
        }
        return true;
    }
    private send(op: Operation, command: CameraCommand): void {
        if (!this.valid(op))
            return;
        try {
            this.guard(command);
        }
        catch (error) {
            this.fail(op, (error as Error).message);
            return;
        }
        const stage: Stage = { command, written: false, photoSeen: false, captureMediumContinuous: true, baseline: null };
        op.stage = stage;
        const admission = () => {
            if (!this.valid(op) || op.stage !== stage)
                return false;
            try {
                this.guard(command);
            }
            catch (error) {
                this.fail(op, (error as Error).message);
                return false;
            }
            stage.after = this.options.clock.now();
            stage.baseline = this.readState().status;
            stage.captureMediumContinuous &&= !!stage.baseline?.cardInserted && stage.baseline.cardState === 'normal';
            stage.photoSeen = false;
            return true;
        };
        void (async () => {
            try {
                await this.options.write(encodeCameraCommand(command), { deadline: op.deadline, signal: op.abort.signal, admission });
                if (!this.valid(op) || op.stage !== stage)
                    return;
                if (stage.after === undefined) {
                    this.fail(op, 'writer did not check dispatch admission');
                    return;
                }
                stage.written = true;
                this.observe(op);
            }
            catch (error) {
                this.fail(op, `write failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        })();
    }
    private observe(op: Operation): void {
        if (!this.valid(op))
            return;
        const stage = op.stage;
        if (!stage || stage.after === undefined)
            return;
        const state = this.readState(), s = state.status, e = state.exposure, f = state.focus, c = stage.command;
        if (!s)
            return;
        const statusFresh = !!s && s.at > stage.after, exposureFresh = !!e && e.at > stage.after, focusFresh = !!f && f.at > stage.after;
        // Capacity is not a card identity. Once any observed push contradicts
        // medium continuity, same-capacity reinsertion cannot revive a claim.
        if (statusFresh && (c.kind === 'photo' || c.kind === 'record-stop')
            && (!s.cardInserted || s.cardState !== 'normal' || s.totalSpaceRaw !== stage.baseline?.totalSpaceRaw)) {
            stage.captureMediumContinuous = false;
            stage.photoSeen = false;
        }
        if (c.kind === 'photo' && stage.captureMediumContinuous && statusFresh && s.photoState === 1 && s.storing && s.mode === 'photo' && s.cardInserted && s.cardState === 'normal')
            stage.photoSeen = true;
        if (!stage.written)
            return;
        let matches = false;
        switch (c.kind) {
            case 'record-start':
                matches = statusFresh && s.recordState === 2;
                break;
            case 'record-stop':
                matches = statusFresh && s.recordState === 0;
                break;
            case 'mode':
                matches = statusFresh && s.modeCode === c.value && s.recordState === 0 && s.photoState === 0 && !s.storing;
                break;
            case 'photo':
                matches = stage.captureMediumContinuous && statusFresh && s.cardInserted && s.cardState === 'normal' && s.totalSpaceRaw === stage.baseline?.totalSpaceRaw && s.mode === 'photo' && s.recordState === 0 && s.photoState === 0 && !s.storing && stage.photoSeen && !!stage.baseline
                    && (s.remainingPhotos < stage.baseline.remainingPhotos || s.freeSpaceRaw < stage.baseline.freeSpaceRaw);
                break;
            case 'exposure-mode':
                matches = exposureFresh && e.exposureModeCode === c.value;
                break;
            case 'iso':
                matches = exposureFresh && e.isoCode === c.value;
                break;
            case 'ev':
                matches = exposureFresh && e.evCode === c.value;
                break;
            case 'shutter':
                matches = exposureFresh && e.shutter.reciprocal === c.value.reciprocal && e.shutter.integer === c.value.integer && e.shutter.decimal === c.value.decimal;
                break;
            case 'focus-mode':
                matches = focusFresh && f.modeCode === c.value;
                break;
            case 'focus-point':
                matches = focusFresh && f.point?.x === c.value.x && f.point?.y === c.value.y;
                break;
            case 'photo-size':
                matches = exposureFresh && e.photoSizeCode === c.value;
                break;
            case 'record-format':
                matches = exposureFresh && e.recordFormatCode === c.value.format && e.recordRateCode === c.value.rate;
                break;
        }
        if (!matches)
            return;
        if (op.command.kind === 'photo' && c.kind === 'mode') {
            this.send(op, op.command);
            return;
        }
        const capture = op.command.kind === 'photo' ? { destination: 'camera' as const, kind: 'photo' as const } :
            op.command.kind === 'record-stop' && stage.captureMediumContinuous && [2, 3].includes(stage.baseline?.recordState ?? -1) && s.cardInserted && s.cardState === 'normal' ? { destination: 'camera' as const, kind: 'video' as const } : undefined;
        this.finish(op);
        op.resolve(Object.freeze({ completed: true, state, ...(capture ? { capture: Object.freeze(capture) } : {}) }));
    }
    private finish(op: Operation): void {
        if (op.timer !== undefined)
            this.options.clock.clearTimer(op.timer);
        op.cleanup();
        op.abort.abort();
        if (this.active === op)
            this.active = undefined;
    }
    private fail(op: Operation, reason: string): void {
        if (this.active !== op)
            return;
        this.finish(op);
        op.reject(new Error(`Camera ${reason}`));
    }
}
