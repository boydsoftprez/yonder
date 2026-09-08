// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { Camera, ConfigSchema, DEFAULT_CONFIG } from '../../schema/config.js';
import { AccessorySources } from './source.js';
import { AccessoryMedia } from './media.js';
import type { Pocket2DeviceOptions, Pocket2Status } from './linux.js';
import { encodeDuml, decodeDuml } from './duml.js';

function harness() {
  const camera = Camera.parse({ id: 'cam1', name: 'Pocket', source: 'accessory', device: 'pocket2:test.udc' });
  let callbacks!: Pocket2DeviceOptions;
  let status: Pocket2Status = { state: 'preparing', generation: 1, identity: camera.device, manufacturer: null, model: null, lastCommandAt: null, lastVideoAt: null, reason: null };
  const now = { value: 1000 };
  const media = new AccessoryMedia('/unused/test.sock'); media.start = vi.fn(async () => {}); media.close = vi.fn(async () => {});
  const device = { start: vi.fn(async () => {}), close: vi.fn(async () => {}), snapshot: () => status, sendCommand: vi.fn(async () => {}) };
  const factory = vi.fn((options: Pocket2DeviceOptions) => { callbacks = options; return device; });
  const source = new AccessorySources({ cameras: () => [camera], controllers: async () => ['test.udc'], deviceFactory: factory,
    mediaFactory: () => media, clock: { now: () => now.value, setTimer: (ms, fn) => setTimeout(fn, ms), clearTimer: token => clearTimeout(token as NodeJS.Timeout) } });
  const live = () => { status = { ...status, state: 'live', manufacturer: 'DJI', model: 'HG211', lastCommandAt: now.value, lastVideoAt: now.value }; callbacks.onStatus!(status); };
  return { source, camera, factory, device, media, now, live, callbacks: () => callbacks,
    stale: () => { status = { ...status, state: 'stale', generation: status.generation + 1 }; callbacks.onStatus!(status); } };
}

describe('shared accessory source', () => {
  it('resumes asynchronously and never creates a second driver for detection, read or capture state', async () => {
    const h = harness(); h.source.resume(); await h.source.discover(); h.live();
    for (let i = 0; i < 5; i++) { await h.source.discover(); h.source.snapshot(h.camera.device); await h.source.medium.state!('cam1'); }
    expect(h.factory).toHaveBeenCalledTimes(1); expect(h.device.start).toHaveBeenCalledTimes(1);
    expect(h.source.detect().found[0]).toMatchObject({ source: 'accessory', byPath: 'pocket2:test.udc', card: 'DJI Pocket 2 (HG211)', capabilities: { formats: { state: 'not-offered' }, aim: { state: 'present' } } });
    expect(h.source.snapshot(h.camera.device)).toMatchObject({ attitude: null, inhibition: 'attitude-missing' });
    await h.source.close(); expect(h.device.close).toHaveBeenCalledOnce();
  });
  it('disconnects old grants and clears telemetry on a source generation loss', async () => {
    const h = harness(); await h.source.discover(); h.live();
    const grant = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'press1' }) as any;
    expect(grant.accepted).toBe(true); h.stale(); h.live();
    expect(await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...grant.grant, seq: 1, pan: 1, tilt: 0 })).toMatchObject({ accepted: false, reason: 'inactive' });
    expect(h.device.sendCommand).not.toHaveBeenCalled(); await h.source.close();
  });
  it('reports missing peripheral mode as a rejection without creating hardware', async () => {
    const factory = vi.fn(); const source = new AccessorySources({ cameras: () => [], controllers: async () => [], deviceFactory: factory });
    expect((await source.discover()).rejected[0].reason).toContain('No USB peripheral controller'); expect(factory).not.toHaveBeenCalled(); await source.close();
  });
  it('rejects duplicate controller adoption and malformed mount geometry, leaving unknown geometry absent', () => {
    const h = harness();
    expect(h.camera.accessory_mount).toBeUndefined();
    expect(ConfigSchema.safeParse({ ...DEFAULT_CONFIG, cameras: [h.camera, { ...h.camera, id: 'cam2' }] }).success).toBe(false);
    expect(Camera.safeParse({ ...h.camera, accessory_mount: { mount: 'bench', envelopes: [{ mount: 'bench', mode: 2, yaw: [10, -10] }], signs: { pan: 1, tilt: -1 }, limitDirections: {}, actions: [] } }).success).toBe(false);
  });
});

it('keeps accessory detection when the independent USB probe throws', async () => {
  const { detectWithAccessory } = await import('../probe/camera.js');
  const h = harness(); await h.source.discover(); h.live();
  const result = await detectWithAccessory(async () => { throw new Error('v4l2-ctl missing'); }, () => h.source.detect());
  expect(result.found[0].source).toBe('accessory'); expect(result.rejected[0].reason).toBe('v4l2-ctl missing');
  await h.source.close();
});

it('invalidates a gesture and changes the browser generation when camera timestamps reset', async () => {
  const h = harness(); await h.source.discover(); h.live();
  const before = h.source.snapshot(h.camera.device)!.generation;
  const issued = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'press1' }) as any;
  const data = Buffer.from([0,0,1,0x65,1]);
  h.callbacks().onVideo!({ data, timestamp: 10000, metadata: 0 });
  h.callbacks().onVideo!({ data, timestamp: 10, metadata: 0 });
  expect(h.source.snapshot(h.camera.device)!.generation).not.toBe(before);
  expect(await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...issued.grant, seq: 1, pan: 1, tilt: 0 })).toMatchObject({ accepted: false, reason: 'inactive' });
  expect(h.device.sendCommand).not.toHaveBeenCalled(); await h.source.close();
});

it('admits a fresh public slew through the actual Intent rate shape and preserves endpoint expiry', async () => {
  const h = harness();
  h.camera.accessory_mount = { mount: 'synthetic', envelopes: [{ mount: 'synthetic', mode: 2, yaw: [-90,90], pitch: [-40,40] }],
    signs: { pan: 1, tilt: 1 }, limitDirections: {}, actions: [] };
  await h.source.discover(); h.live();
  const payload = Buffer.alloc(11); payload[6] = 2 << 6;
  h.callbacks().onCommand!(decodeDuml(encodeDuml({ sender: 4, receiver: 2, commandSet: 4, commandId: 5, sequence: 1, payload }))!);
  const issued = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'physical' }) as any;
  expect(await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...issued.grant, seq: 1, pan: 2, tilt: -1 })).toMatchObject({ accepted: true });
  expect(h.device.sendCommand).toHaveBeenCalledOnce();
  const [, options] = (h.device.sendCommand as any).mock.calls[0];
  expect(options.deadline).toBe(issued.grant.deadline); expect(options.admission()).toBe(true); expect(options.signal.aborted).toBe(false);
  h.stale(); expect(options.admission()).toBe(false); expect(options.signal.aborted).toBe(true); await h.source.close();
});
