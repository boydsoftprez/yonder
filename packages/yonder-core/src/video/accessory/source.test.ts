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
  const readCameras = vi.fn(() => [camera]);
  const source = new AccessorySources({ cameras: readCameras, controllers: async () => ['test.udc'], deviceFactory: factory,
    mediaFactory: () => media, clock: { now: () => now.value, setTimer: (ms, fn) => setTimeout(fn, ms), clearTimer: token => clearTimeout(token as NodeJS.Timeout) } });
  const live = () => { status = { ...status, state: 'live', manufacturer: 'DJI', model: 'HG211', lastCommandAt: now.value, lastVideoAt: now.value }; callbacks.onStatus!(status); };
  return { source, camera, factory, device, media, now, live, readCameras, callbacks: () => callbacks,
    newLiveGeneration: () => { status = { ...status, state: 'live', generation: status.generation + 1 }; callbacks.onStatus!(status); },
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

it('uses only native live state during sustained attitude refresh and rate admission, while public camera lookups stay fresh', async () => {
  vi.useFakeTimers();
  const h = harness();
  h.camera.accessory_mount = { mount: 'obsolete-world-profile', envelopes: [{ mount: 'obsolete-world-profile', mode: 2, yaw: [0, 0], pitch: [0, 0] }],
    signs: { pan: null, tilt: null }, limitDirections: {}, actions: [] };
  const savedProfile = structuredClone(h.camera.accessory_mount);
  try {
    await h.source.discover(); h.live(); h.readCameras.mockClear();
    (h.device.sendCommand as any).mockImplementation(async (_command: any, options: any) => {
      if (!options.admission()) throw new Error('not admitted at the endpoint');
    });
    let grant = (await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'sustained' }) as any).grant;
    for (let sample = 0; sample < 40; sample++) {
      h.now.value = 1000 + sample * 50;
      const payload = Buffer.alloc(40); payload.writeInt16LE(897, 0); payload[6] = 0x80; payload[10] = 0xa0;
      const halfAngle = sample * 0.25 * Math.PI / 360;
      payload.writeFloatLE(Math.cos(halfAngle), 24); payload.writeFloatLE(Math.sin(halfAngle), 36);
      h.callbacks().onCommand!(decodeDuml(encodeDuml({ sender: 4, receiver: 2, commandSet: 4, commandId: 5, payload }))!);
      await vi.advanceTimersByTimeAsync(sample ? 50 : 0);
      if (sample % 2 === 0) {
        const reply = await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...grant, seq: sample / 2, pan: 5, tilt: 0 }) as any;
        expect(reply.accepted).toBe(true); grant = reply.next;
      }
      expect(h.source.snapshot(h.camera.device)?.inhibition).toBeNull();
    }
    expect(h.device.sendCommand.mock.calls.length).toBeGreaterThan(15);
    expect(h.readCameras.mock.calls.length).toBe(0);
    expect(h.source.snapshot(h.camera.device)).toMatchObject({ mount: null, envelope: null, recentre: { allowed: true } });
    expect(h.camera.accessory_mount).toEqual(savedProfile);
    expect(h.source.medium.holds('cam1')).toBe(true);
    h.readCameras.mockReturnValue([]);
    expect(h.source.medium.holds('cam1')).toBe(false);
    expect(h.readCameras).toHaveBeenCalledTimes(2);
  } finally { await h.source.close(); vi.useRealTimers(); }
});

it('keeps accessory detection when the independent USB probe throws', async () => {
  const { detectWithAccessory } = await import('../probe/camera.js');
  const h = harness(); await h.source.discover(); h.live();
  const result = await detectWithAccessory(async () => { throw new Error('v4l2-ctl missing'); }, () => h.source.detect());
  expect(result.found[0].source).toBe('accessory'); expect(result.rejected[0].reason).toBe('v4l2-ctl missing');
  await h.source.close();
});

it('keeps a held native rate and fresh DUML attitude through a media reset, but revokes it on real USB loss', async () => {
  vi.useFakeTimers(); const h = harness();
  const fresh = () => {
    const payload = Buffer.alloc(40); payload[6] = 0x80; payload[10] = 0xa0; payload.writeFloatLE(1, 24);
    h.callbacks().onCommand!(decodeDuml(encodeDuml({ sender: 4, receiver: 2, commandSet: 4, commandId: 5, payload }))!);
  };
  try {
    await h.source.discover(); h.live(); fresh();
    (h.device.sendCommand as any).mockImplementation(async (_cmd: any, options: any) => { if (!options.admission()) throw new Error('not admitted'); });
    const before = h.source.snapshot(h.camera.device)!;
    const issued = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'press1' }) as any;
    const admitted = await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...issued.grant, seq: 0, pan: 5, tilt: 0 }) as any;
    expect(admitted.accepted).toBe(true); await settleSource();
    const data = Buffer.from([0,0,1,0x65,1]);
    h.callbacks().onVideo!({ data, timestamp: 10000, metadata: 0 });
    h.now.value += 100; fresh(); await vi.advanceTimersByTimeAsync(100);
    h.callbacks().onVideo!({ data, timestamp: 10, metadata: 0 });
    const after = h.source.snapshot(h.camera.device)!;
    expect(after.generation).not.toBe(before.generation);
    expect(after.input?.generation).toBe(after.generation);
    expect(after.controlGeneration).toBe(before.controlGeneration);
    expect(after.attitude).toMatchObject({ at: h.now.value, mode: 2 });
    expect(after.admitted).toEqual({ pan: 5, tilt: 0 });
    expect((h.device.sendCommand as any).mock.calls[0][1].signal.aborted).toBe(false);
    const next = await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...admitted.next, seq: 1, pan: 5, tilt: 0 }) as any;
    expect(next.accepted).toBe(true);
    h.now.value += 100; fresh(); await vi.advanceTimersByTimeAsync(100);
    expect(h.device.sendCommand.mock.calls.length).toBeGreaterThan(2);
    h.stale(); h.live();
    expect(h.source.snapshot(h.camera.device)?.controlGeneration).not.toBe(before.controlGeneration);
    expect(await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...next.next, seq: 2, pan: 5, tilt: 0 })).toMatchObject({ accepted: false, reason: 'inactive' });
  } finally { await h.source.close(); vi.useRealTimers(); }
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

it('retires old control intent if a new live USB generation arrives without an intermediate status callback', async () => {
  const h = harness(); await h.source.discover(); h.live();
  try {
    const payload = Buffer.alloc(40); payload[6] = 0x80; payload.writeFloatLE(1, 24);
    h.callbacks().onCommand!(decodeDuml(encodeDuml({ sender: 4, receiver: 2, commandSet: 4, commandId: 5, payload }))!);
    const issued = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'old-usb' }) as any;
    const first = await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...issued.grant, seq: 0, pan: 5, tilt: 0 }) as any;
    expect(first.accepted).toBe(true); await settleSource();
    h.newLiveGeneration();
    expect(await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...first.next, seq: 1, pan: 5, tilt: 0 })).toMatchObject({ accepted: false, reason: 'inactive' });
    expect(h.source.snapshot(h.camera.device)?.attitude).toBeNull();
  } finally { await h.source.close(); }
});

it('reports world position without joint bounds and permits measured native actions independently of the obsolete mount profile', async()=>{
  const h=harness();await h.source.discover();h.live();
  const payload=Buffer.alloc(40);payload.writeInt16LE(1799,0);payload.writeInt16LE(-1545,4);payload[6]=0x80;payload.writeFloatLE(1,24);
  h.callbacks().onCommand!(decodeDuml(encodeDuml({sender:4,receiver:2,commandSet:4,commandId:5,payload}))!);
  expect(h.source.snapshot(h.camera.device)).toMatchObject({attitude:{pitch:179.9,yaw:-154.5},envelope:null,inhibition:null,motionNotice:null,recentre:{allowed:true}});
  expect(await h.source.aim(h.camera.device,'owner',{op:'recentre'})).toMatchObject({accepted:true});
  expect(h.device.sendCommand).toHaveBeenCalledOnce();expect((h.device.sendCommand as any).mock.calls[0][0].payload).toEqual(Buffer.from([2,1]));
  await h.source.close();
});

it('publishes a terminal no-rotation notice with zero admitted rate and leaves the live source ready for new intent',async()=>{
  vi.useFakeTimers();const h=harness();
  const attitude=()=>{const payload=Buffer.alloc(40);payload[6]=0x80;payload[10]=0xa0;payload.writeFloatLE(1,24);
    h.callbacks().onCommand!(decodeDuml(encodeDuml({sender:4,receiver:2,commandSet:4,commandId:5,payload}))!);};
  try {
    await h.source.discover();h.live();attitude();
    (h.device.sendCommand as any).mockImplementation(async (_cmd:any,options:any)=>{if(!options.admission())throw new Error('refused');});
    let grant=(await h.source.aim(h.camera.device,'owner',{op:'issue',clientGesture:'one'}) as any).grant;
    let refusal:string|undefined;
    for(let seq=1;seq<=30;seq++){
      const reply=await h.source.aim(h.camera.device,'owner',{op:'slew',...grant,seq,pan:5,tilt:0}) as any;
      if(!reply.accepted){refusal=reply.reason;break;}grant=reply.next;
      await settleSource();h.now.value+=100;attitude();await vi.advanceTimersByTimeAsync(100);
    }
    expect(h.device.snapshot().state).toBe('live');
    expect(h.source.snapshot(h.camera.device)).toMatchObject({admitted:{pan:0,tilt:0},inhibition:null});
    expect(h.source.snapshot(h.camera.device)?.motionNotice).toContain('No camera rotation observed');
    expect(refusal).toContain('No camera rotation observed');
    expect(await h.source.aim(h.camera.device,'owner',{op:'issue',clientGesture:'two'})).toMatchObject({accepted:true});
    expect(h.source.snapshot(h.camera.device)?.motionNotice).toBeNull();
  }finally{await h.source.close();vi.useRealTimers();}
});

it.each([{ yaw: 89, pitch: 0, flags: 0, pan: -1, tilt: 0 }, { yaw: 0, pitch: 39, flags: 0, pan: 0, tilt: -1 }])(
  'keeps safe inward/other-axis gestures available at directional boundaries $yaw/$pitch/$flags', async ({ yaw, pitch, flags, pan, tilt }) => {
    const h = harness();
    h.camera.accessory_mount = { mount: 'synthetic', envelopes: [{ mount: 'synthetic', mode: 2, yaw: [-90,90], pitch: [-40,40] }], signs: { pan: 1, tilt: 1 }, limitDirections: { yaw: 1, pitch: 1 }, actions: [] };
    await h.source.discover(); h.live();
    const payload = Buffer.alloc(11); payload.writeInt16LE(pitch * 10, 0); payload.writeInt16LE(yaw * 10, 4); payload[6] = 2 << 6; payload[10] = flags;
    h.callbacks().onCommand!(decodeDuml(encodeDuml({ sender: 4, receiver: 2, commandSet: 4, commandId: 5, sequence: 1, payload }))!);
    expect(h.source.snapshot(h.camera.device)!.inhibition).toBeNull();
    const issued = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'inward' }) as any;
    expect(await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...issued.grant, seq: 1, pan, tilt })).toMatchObject({ accepted: true });
    expect(h.device.sendCommand).toHaveBeenCalledOnce(); await h.source.close();
  });

async function contentionHarness() {
  const h = harness();
  h.camera.accessory_mount = { mount: 'synthetic', envelopes: [{ mount: 'synthetic', mode: 2, yaw: [-90,90], pitch: [-40,40] }], signs: { pan: 1, tilt: 1 }, limitDirections: {}, actions: [] };
  await h.source.discover(); h.live();
  const push = (sender: number, commandSet: number, commandId: number, payload: Buffer) => h.callbacks().onCommand!(decodeDuml(encodeDuml({ sender, senderIndex: 0, receiver: 2, commandSet, commandId, payload }))!);
  const fresh = (iso = 3) => {
    const status = Buffer.alloc(31); status.writeUInt32LE(0x200, 0); status[4] = 1; status.writeUInt32LE(1000, 5);
    const exposure = Buffer.alloc(48); exposure[20] = 4; exposure[5] = iso;
    const attitude = Buffer.alloc(11); attitude[6] = 2 << 6;
    push(1,2,0x80,status); push(1,2,0x81,exposure); push(4,4,5,attitude);
  };
  fresh();
  let release!: () => void; const blocked = new Promise<void>(done => { release = done; });
  let active = false; let first = true; const wire: { command: any; options: any }[] = [];
  (h.device.sendCommand as any).mockImplementation(async (command: any, options: any) => {
    if (active) throw new Error('Pocket 2 command already pending');
    if (!options.admission()) throw new Error('admission failed');
    active = true; wire.push({ command, options });
    try { if (first) { first = false; await blocked; } } finally { active = false; }
  });
  return { ...h, fresh, wire, release };
}
const settleSource = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it('keeps a native camera operation pending through media-only discontinuity and confirms its fresh readback', async () => {
  const h = await contentionHarness();
  let settled = false;
  const operation = h.source.controls(h.camera.device, { kind: 'iso', value: 5 }).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  try {
    await settleSource(); expect(h.wire).toHaveLength(1);
    const data = Buffer.from([0,0,1,0x65,1]);
    h.callbacks().onVideo!({ data, timestamp: 10000, metadata: 0 });
    h.callbacks().onVideo!({ data, timestamp: 10, metadata: 0 });
    await settleSource(); expect(settled).toBe(false);
    expect(h.wire[0].options.signal.aborted).toBe(false);
    h.now.value = 1100; h.release(); await settleSource(); h.fresh(5);
    expect(await operation).toMatchObject({ completed: true });
  } finally { h.release(); await h.source.close(); await operation; }
});

it('serializes a camera write and a fresh rate through one actual shared device writer', async () => {
  const h = await contentionHarness();
  const camera = h.source.controls(h.camera.device, { kind: 'iso', value: 5 }).catch(error => error);
  try {
    await settleSource(); expect(h.wire).toHaveLength(1);
    const issued = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'physical' }) as any;
    expect(await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...issued.grant, seq: 1, pan: 2, tilt: 0 })).toMatchObject({ accepted: true });
    await settleSource(); expect(h.device.sendCommand).toHaveBeenCalledTimes(1);
    h.now.value = 1100; h.release(); await settleSource(); h.fresh(5);
    expect(await camera).toMatchObject({ completed: true });
    expect(h.wire).toHaveLength(2); expect(h.wire[1].command.commandSet).toBe(4);
    expect(h.wire[1].options.deadline).toBe(issued.grant.deadline); expect(h.wire[1].options.signal.aborted).toBe(false);
    expect(await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'next-physical' })).toMatchObject({ accepted: true });
  } finally { h.release(); await h.source.close(); await camera; }
});

it('retires an expired rate waiting behind camera I/O without replay or disabling fresh aim', async () => {
  vi.useFakeTimers(); const h = await contentionHarness();
  const camera = h.source.controls(h.camera.device, { kind: 'iso', value: 5 }).catch(error => error);
  try {
    await settleSource();
    const issued = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'physical' }) as any;
    await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...issued.grant, seq: 1, pan: 2, tilt: 0 });
    h.now.value = 1600; await vi.advanceTimersByTimeAsync(600); h.release(); await settleSource(); h.fresh(5);
    expect(await camera).toMatchObject({ completed: true }); expect(h.wire).toHaveLength(1);
    const next = await h.source.aim(h.camera.device, 'owner', { op: 'issue', clientGesture: 'next-physical' }) as any;
    expect(next).toMatchObject({ accepted: true });
    expect(await h.source.aim(h.camera.device, 'owner', { op: 'slew', ...next.grant, seq: 1, pan: 2, tilt: 0 })).toMatchObject({ accepted: true });
    h.now.value = 1700; await vi.advanceTimersByTimeAsync(100); expect(h.wire).toHaveLength(2);
  } finally { h.release(); await h.source.close(); await camera; vi.useRealTimers(); }
});
