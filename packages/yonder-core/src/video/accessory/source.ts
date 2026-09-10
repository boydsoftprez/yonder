// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Camera } from '../../schema/config.js';
import { noCapabilities, present, type CameraCapabilities } from '../capability.js';
import type { Detection, DetectResult } from '../probe/camera.js';
import { Pocket2Device, monotonicMilliseconds, type Pocket2DeviceOptions, type Pocket2Status } from './linux.js';
import { CameraController, cameraControlDescriptors } from './controls.js';
import { GimbalController, decodeGimbalAttitude } from './gimbal.js';
import { guard, type GimbalAttitude, type GuardContext } from './guard.js';
import type { IntentClock } from './intent.js';
import { AccessoryMedia } from './media.js';
import type { RecordingState, CameraMedium } from '../recorder.js';
import { validAimRequest } from './requests.js';
import { accessoryControls } from './present.js';
import { AccessoryWriter } from './writer.js';
import { imageDirection } from '../orientation.js';

export interface AccessoryInput {
  endpoint: string;
  native: { width: number; height: number; fps: number } | null;
  live: boolean;
  generation: number;
  reason: string | null;
}
export interface AccessorySourceOptions {
  cameras(): readonly Camera[];
  controllers?: () => Promise<string[]>;
  deviceFactory?: (options: Pocket2DeviceOptions) => Pick<Pocket2Device, 'start' | 'close' | 'snapshot' | 'sendCommand'>;
  mediaFactory?: (endpoint: string) => AccessoryMedia;
  mediaCapability?: () => Promise<string | null>;
  onFailure?: Pocket2DeviceOptions['onFailure'];
  root?: string;
  clock?: IntentClock;
}
const clock: IntentClock = {
  now: monotonicMilliseconds,
  setTimer: (ms, fn) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
  clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
// HG211 native actions measured in clear horizontal and upright poses. This is
// an exact-command policy, not a portable joint trajectory or factory range.
const HG211_NATIVE_ACTIONS = Object.freeze([
  Object.freeze({ kind: 'recentre' as const }),
  ...([0, 1, 2] as const).map(mode => Object.freeze({ kind: 'mode' as const, mode })),
]);
type Owned = { device: ReturnType<NonNullable<AccessorySourceOptions['deviceFactory']>>; media: AccessoryMedia;
  camera: CameraController; gimbal: GimbalController; attitude: GimbalAttitude | null; generation: number | null; error: string | null;
  streamGeneration: number; rawAttitude?: string; admitted?: { owner: string; gesture: string; pan: number; tilt: number; until: number } };

/** R-CAM-15: exactly one asynchronous USB owner shared by all daemon consumers. */
export class AccessorySources {
  private owned = new Map<string, Owned>();
  private discovering?: Promise<void>;
  private closed = false;
  private discoveryReason: string | null = null;
  private readonly clock: IntentClock;
  private readonly imageDirections = new Map<string, string>();
  constructor(private readonly options: AccessorySourceOptions) { this.clock = options.clock ?? clock; }
  /** Config/render callers schedule listening; never await the USB handshake or reconnect. */
  resume(cameras: readonly Camera[] = this.options.cameras()): void {
    const active = new Set(cameras.filter(camera => camera.source === 'accessory').map(camera => camera.id));
    for (const id of this.imageDirections.keys()) if (!active.has(id)) this.imageDirections.delete(id);
    for (const camera of cameras) if (camera.source === 'accessory') {
      const direction = imageDirection(camera.controls);
      const prior = this.imageDirections.get(camera.id);
      if (prior !== undefined && prior !== direction) {
        const source = this.owned.get(camera.device);
        if (source) { source.gimbal.reset(); source.admitted = undefined; }
      }
      this.imageDirections.set(camera.id, direction);
      void this.ensure(camera.device).catch(() => undefined);
    }
    for (const source of this.owned.values()) source.gimbal.refresh();
  }
  async discover(): Promise<DetectResult> {
    if (!this.discovering) {
      this.discovering = (async () => {
        try {
          const controllers = await (this.options.controllers ?? (() => readdir('/sys/class/udc')))();
          this.discoveryReason = controllers.length ? null : 'No USB peripheral controller is available; accessory mode must already be enabled on this board.';
          await Promise.all(controllers.filter(c => /^[a-zA-Z0-9_.:-]{1,120}$/.test(c)).map(c => this.ensure(`pocket2:${c}`)));
        } catch (error) { this.discoveryReason = error instanceof Error ? error.message : 'USB peripheral controller discovery failed'; }
      })().finally(() => { this.discovering = undefined; });
    }
    await this.discovering;
    return this.detect();
  }
  detect(): DetectResult {
    const result: DetectResult = { found: [], rejected: [] };
    for (const [identity, source] of this.owned) {
      const status = source.device.snapshot();
      if (status.state === 'live' && status.manufacturer && status.model) result.found.push(this.detection(identity, source));
      else result.rejected.push({ device: identity, card: 'Pocket 2 accessory', reason: source.error ?? status.reason ?? `Accessory ${status.state}; waiting for live camera identity` });
    }
    if (this.discoveryReason) result.rejected.push({ device: '', card: 'Accessory USB', reason: this.discoveryReason });
    return result;
  }
  probe(identity: string): Detection | { device: string; card: string; reason: string } {
    const found = this.detect().found.find(d => d.byPath === identity);
    return found ?? { device: identity, card: 'Pocket 2', reason: this.input(identity)?.reason ?? 'Accessory camera is not live' };
  }
  private async ensure(identity: string): Promise<void> {
    if (this.closed || this.owned.has(identity) || !/^pocket2:[a-zA-Z0-9_.:-]{1,120}$/.test(identity)) return;
    const endpoint = `${this.options.root ?? '/run/yonder/accessory'}/${createHash('sha256').update(identity).digest('hex').slice(0, 20)}.sock`;
    const media = (this.options.mediaFactory ?? (path => new AccessoryMedia(path)))(endpoint);
    let source!: Owned;
    const device = (this.options.deviceFactory ?? (opts => new Pocket2Device(opts)))({
      controller: identity.slice(8), now: this.clock.now,
      onFailure: this.options.onFailure,
      onStatus: status => this.status(source, status),
      onCommand: frame => {
        source.camera.update(frame);
        if (frame.commandSet === 4 && frame.commandId === 5) {
          source.attitude = decodeGimbalAttitude(frame, this.clock);
          source.rawAttitude = source.attitude ? Buffer.from(frame.payload).toString('hex') : undefined;
          source.gimbal.refresh();
        }
      },
      onVideo: unit => {
        // A timestamp discontinuity retires only media clients/decoder state.
        // Fresh DUML controls belong to the independently observed USB epoch.
        if (!media.push(unit)) source.streamGeneration++;
      },
    });
    const writer = new AccessoryWriter(this.clock, (command, options) => device.sendCommand(command, options));
    source = { device, media, attitude: null, generation: null, error: null, streamGeneration: 0,
      camera: new CameraController({ clock: this.clock, write: (cmd, options) => writer.write(cmd, options) }),
      gimbal: new GimbalController({ clock: this.clock, context: () => this.context(source), write: (cmd, options) => writer.write(cmd, options),
        onMotionNotice: notice => { if (notice) source.admitted = undefined; } }),
    };
    source.camera.disconnect(); source.gimbal.disconnect(); this.owned.set(identity, source);
    try { source.error = await this.options.mediaCapability?.() ?? null; await media.start(); if (!this.closed) await device.start(); else await media.close(); }
    catch (error) { source.error = error instanceof Error ? error.message : 'Accessory media unavailable'; }
  }
  private status(source: Owned, status: Pocket2Status): void {
    if (status.state === 'live') {
      if (source.generation !== status.generation) {
        source.admitted = undefined; source.attitude = null; source.rawAttitude = undefined; source.gimbal.disconnect(); source.media.reset();
        source.generation = status.generation; source.camera.connect(); source.gimbal.connect();
      }
    } else {
      source.generation = null; source.admitted = undefined; source.attitude = null; source.rawAttitude = undefined; source.camera.disconnect(); source.gimbal.disconnect(); source.media.reset();
    }
  }
  private context(source: Owned): GuardContext {
    const status = source.device.snapshot();
    // This runs on every attitude push and dispatch admission. Native motion
    // uses only live device state; reading the obsolete world profile here
    // would synchronously reload/parse configuration inside the intent budget.
    return { now: this.clock.now(), attitudeMaxAgeMs: 500, attitude: source.attitude,
      mount: null, envelopes: [], signs: { pan: null, tilt: null },
      limitDirections: {}, actions: [], intentAllowanceMs: 500, deviceStopAllowanceMs: 800,
      discreteApplicable: false,
      nativeActions: status.state === 'live' && status.manufacturer === 'DJI' && status.model === 'HG211' ? HG211_NATIVE_ACTIONS : [] };
  }
  input(identity: string): AccessoryInput | undefined {
    const source = this.owned.get(identity); if (!source) return undefined;
    const status = source.device.snapshot(), fps = source.media.clock.fps();
    const live = !source.error && status.state === 'live' && status.lastVideoAt !== null && this.clock.now() - status.lastVideoAt < 3000;
    return { endpoint: source.media.endpoint, native: source.media.dimensions && fps ? { ...source.media.dimensions, fps } : null,
      live, generation: status.generation * 1_000_000 + source.streamGeneration, reason: source.error ?? status.reason ?? (live ? null : 'Accessory video is not fresh') };
  }
  snapshot(identity: string) {
    const source = this.owned.get(identity); if (!source) return null;
    const context = this.context(source), status = source.device.snapshot();
    const attitude = source.attitude && this.clock.now() - source.attitude.at < 500 ? source.attitude : null;
    // A directional stopping margin is not a global interlock. Zero tests
    // shared prerequisites; every actual rate is still guarded at dispatch.
    const verdict = guard({ kind: 'rate', pan: 0, tilt: 0 }, context);
    const directions = {
      'Pan +': guard({ kind: 'rate', pan: 0.1, tilt: 0 }, context), 'Pan −': guard({ kind: 'rate', pan: -0.1, tilt: 0 }, context),
      'Tilt +': guard({ kind: 'rate', pan: 0, tilt: 0.1 }, context), 'Tilt −': guard({ kind: 'rate', pan: 0, tilt: -0.1 }, context),
    };
    const admitted = source.admitted;
    const rate = !source.gimbal.motionNotice && admitted && admitted.until > this.clock.now() && guard({ kind: 'rate', pan: admitted.pan, tilt: admitted.tilt }, context).allowed
      ? { pan: admitted.pan, tilt: admitted.tilt } : { pan: 0, tilt: 0 };
    return { ...status, controlGeneration: status.generation, generation: status.generation * 1_000_000 + source.streamGeneration,
      input: this.input(identity), state: source.camera.readState(), attitude, admitted: rate, directions,
      mount: context.mount, envelope: null as import('./guard.js').MeasuredEnvelope | null, motionNotice: source.gimbal.motionNotice,
      recentre: guard({ kind: 'recentre' }, context), modes: ([0,1,2] as const).map(mode => guard({ kind: 'mode', mode }, context)),
      inhibition: verdict.allowed ? null : verdict.reason, controls: accessoryControls(source.camera.readState()), descriptors: cameraControlDescriptors().map(d => d.kind === 'menu'
        ? { ...d, options: d.values.map(value => ({ value, label: String(d.toDisplay(value)) })) } : d) };
  }
  private detection(identity: string, source: Owned): Detection {
    const status = source.device.snapshot();
    const capabilities: CameraCapabilities = { ...noCapabilities(),
      aim: present({ pitch: { min: null, max: null }, yaw: { min: null, max: null }, mode: source.attitude ? String(source.attitude.mode) : 'unknown' }),
      recording: present({ medium: 'camera' }), stills: present({ source: 'camera' }) };
    return { source: 'accessory', device: identity, byPath: identity, byPathStable: true,
      card: `${status.manufacturer} Pocket 2 (${status.model})`, capabilities };
  }
  async controls(identity: string, request: unknown) {
    const source = this.owned.get(identity); if (!source) throw new Error('Accessory camera unavailable');
    return source.camera.execute(request);
  }
  async aim(identity: string, owner: string, body: unknown): Promise<unknown> {
    const source = this.owned.get(identity); if (!source) return { accepted: false, reason: 'unavailable' };
    // Only the privileged Unix API can name this owner/op. Console middleware
    // rejects probe-issue via validAimRequest before deriving its session owner.
    const probe = body as { op?: unknown; clientGesture?: unknown } | null;
    if (probe?.op === 'probe-state' && /^bench-range-[a-z0-9-]{1,64}$/.test(owner) && Object.keys(probe).length === 1) {
      const snapshot = this.snapshot(identity);
      return { accepted: true, attitude: snapshot?.attitude, raw: snapshot?.attitude ? source.rawAttitude ?? null : null,
        generation: snapshot?.generation, notice: source.gimbal.motionNotice, inhibition: snapshot?.inhibition };
    }
    if (probe?.op === 'probe-issue' && /^bench-range-[a-z0-9-]{1,64}$/.test(owner)
      && Object.keys(probe).length === 2 && typeof probe.clientGesture === 'string'
      && /^[A-Za-z0-9_.:-]{1,128}$/.test(probe.clientGesture)) {
      const status = source.device.snapshot();
      if (status.state !== 'live' || status.manufacturer !== 'DJI' || status.model !== 'HG211') return { accepted: false, reason: 'unavailable' };
      const reply = source.gimbal.issueRangeProbe(owner, probe.clientGesture);
      if (reply.accepted) source.admitted = undefined;
      return reply;
    }
    if (!validAimRequest(body)) return { accepted: false, reason: 'malformed' };
    const b = body as Record<string, unknown>;
    switch (b.op) {
      case 'issue': { const reply = source.gimbal.issue(owner, typeof b.clientGesture === 'string' ? b.clientGesture : undefined); if (reply.accepted) source.admitted = undefined; return reply; }
      case 'slew': {
        const { gesture, credential, deadline, seq, pan, tilt } = b;
        const reply = source.gimbal.admit(owner, { gesture, credential, deadline, seq, rate: { pan, tilt } });
        if (reply.accepted) source.admitted = reply.next ? { owner, gesture: b.gesture as string, pan: b.pan as number, tilt: b.tilt as number, until: Math.min(b.deadline as number, this.clock.now() + 500) } : undefined;
        if (!reply.accepted && source.gimbal.motionNotice) return { ...reply, reason: source.gimbal.motionNotice };
        return reply;
      }
      case 'stop': if (typeof b.gesture !== 'string') break; source.gimbal.end(owner, b.gesture);
        if (source.admitted?.owner === owner && source.admitted.gesture === b.gesture) source.admitted = undefined;
        return { accepted: true };
      case 'recentre': if (source.admitted?.owner === owner) source.admitted = undefined; return source.gimbal.action(owner, { kind: 'recentre' });
      case 'mode': if (b.mode === 0 || b.mode === 1 || b.mode === 2) { if (source.admitted?.owner === owner) source.admitted = undefined; return source.gimbal.action(owner, { kind: 'mode', mode: b.mode }); }
    }
    return { accepted: false, reason: 'malformed' };
  }
  readonly medium: CameraMedium = {
    listingReason: 'Files stay on the camera card; Yonder cannot list, download or delete them.',
    holds: id => this.options.cameras().some(c => c.id === id && c.source === 'accessory'),
    captures: async () => [],
    state: async id => this.recordingState(id),
    record: async (id, action) => { await this.controls(this.identity(id), { kind: `record-${action}` }); return this.recordingState(id); },
    // This is the completion observation time, never a camera file timestamp or filename.
    photo: async id => { await this.controls(this.identity(id), { kind: 'photo' }); return { destination: 'camera', kind: 'photo', held: 'camera', observedAt: Date.now() }; },
  };
  private identity(id: string): string { const camera = this.options.cameras().find(c => c.id === id && c.source === 'accessory'); if (!camera) throw new Error('Accessory camera unavailable'); return camera.device; }
  private recordingState(id: string): RecordingState {
    const status = this.owned.get(this.identity(id))?.camera.readState().status;
    return { recording: status?.recordPhase === 'recording' || status?.recordPhase === 'starting' || status?.recordPhase === 'finalizing',
      since: status && status.recordPhase !== 'idle' ? Date.now() - status.recordingSeconds * 1000 : null,
      destination: 'camera', remainingSeconds: status?.remainingSeconds ?? null, remainingPhotos: status?.remainingPhotos ?? null,
      bytes: null, ended: null, observed: !!status, phase: status?.recordPhase ?? null,
      mediumReason: status ? (status.cardInserted && status.cardState === 'normal' ? 'Files stay on the camera card; listing and download are unavailable.' : 'No recognized writable camera card.') : 'Camera card status is not fresh.' };
  }
  async close(): Promise<void> { this.closed = true; await this.discovering; await Promise.all([...this.owned.values()].map(async s => { s.gimbal.close(); s.camera.close(); try { await s.device.close(); } finally { await s.media.close(); } })); }
}
