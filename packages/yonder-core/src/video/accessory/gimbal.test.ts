// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { decodeGimbalAttitude, GimbalController } from './gimbal.js';
import type { GuardContext } from './guard.js';
import type { IntentClock, IntentGrant } from './intent.js';
import type { DumlFrame, DumlCommand } from './duml.js';
import type { AccessoryCommandOptions } from './aoa.js';

class Clock implements IntentClock {
  time = 1000; serial = 0; timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimer = (ms: number, callback: () => void) => { const id = ++this.serial; this.timers.set(id, { at: this.time + ms, callback }); return id; };
  clearTimer = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number, dispatch = true) { this.time += ms; if (dispatch) for (const [id, t] of [...this.timers]) if (t.at <= this.time) { this.timers.delete(id); t.callback(); } }
}
function frame(hex = '85ff2d00db034000000003'): DumlFrame {
  return { commandSet: 4, commandId: 5, sender: 4, receiver: 2, senderIndex: 0, receiverIndex: 0, sequence: 1, response: false, ack: 0, encryption: 0, version: 1, payload: Buffer.from(hex, 'hex') } as DumlFrame;
}
function fixture() {
  const clock = new Clock();
  const box = { yaw: [-50, 50], pitch: [-40, 40], roll: [-5, 5] } as const;
  const context: GuardContext = { now: 1000, attitudeMaxAgeMs: 200, attitude: { pitch: 0, roll: 0, yaw: 0, mode: 1, at: 1000, pitchLimit: false, yawLimit: false, fault: false }, mount: 'test', envelopes: [{ mount: 'test', mode: 1, ...box }, { mount: 'test', mode: 2, ...box }], signs: { pan: 1, tilt: 1 }, limitDirections: {}, intentAllowanceMs: 500, deviceStopAllowanceMs: 800, actions: [{ mount: 'test', fromMode: 1, command: { kind: 'recentre' }, start: box, trajectory: box }, { mount: 'test', fromMode: 1, command: { kind: 'mode', mode: 2 }, start: box, trajectory: box }] };
  const writes: { command: DumlCommand; options: AccessoryCommandOptions; resolve: () => void; reject: (e: Error) => void }[] = [];
  const controller = new GimbalController({ clock, context: () => context, write: (command, options) => new Promise<void>((resolve, reject) => writes.push({ command, options, resolve, reject })) });
  const issue = (owner = 'alice') => { const r = controller.issue(owner); if (!r.accepted) throw new Error(r.reason); return r.grant; };
  const admit = (grant: IntentGrant, pan = 5, tilt = -2, seq = 0) => controller.admit('alice', { ...grant, seq, rate: { pan, tilt } });
  const freshAdvance = (ms: number) => { context.attitude!.at = clock.time + ms; clock.advance(ms); };
  return { clock, context, writes, controller, issue, admit, freshAdvance };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe('gimbal attitude', () => {
  it('decodes signed tenths, mode high bits and pitch/yaw limit bits using injected monotonic time', () => {
    expect(decodeGimbalAttitude(frame(), { now: () => 1234 })).toEqual({ pitch: -12.3, roll: 4.5, yaw: 98.7, mode: 1, at: 1234, pitchLimit: true, yawLimit: true, fault: false });
    for (const [byte, pitchLimit, yawLimit, fault] of [[1,true,false,false],[2,false,true,false],[4,false,false,true],[128,false,false,true]] as const) {
      const f = frame(); f.payload[10] = byte;
      expect(decodeGimbalAttitude(f, { now: () => 1 })).toMatchObject({ pitchLimit, yawLimit, fault });
    }
  });
  it('rejects every truncation and unrelated/response frame without inventing zero attitude', () => {
    for (let n = 0; n < 11; n++) { const original = frame(); const f = { ...original, payload: original.payload.subarray(0,n) }; expect(decodeGimbalAttitude(f, { now: () => 1 })).toBeNull(); }
    for (const patch of [{ commandId: 4 }, { commandSet: 2 }, { sender: 1 }, { response: true }]) expect(decodeGimbalAttitude({ ...frame(), ...patch }, { now: () => 1 })).toBeNull();
    const f = frame(); f.payload[6] = 0xc0;
    expect(decodeGimbalAttitude(f, { now: () => 1 })?.mode).toBe(3);
  });
});
describe('intent-bound gimbal dispatcher', () => {
  it('issue alone writes nothing; signed rates encode yaw/zero-roll/inverted pitch at 10Hz', async () => {
    const f = fixture(); const grant = f.issue(); expect(f.writes).toHaveLength(0);
    expect(f.admit(grant)).toMatchObject({ accepted: true });
    expect(f.writes[0].command).toMatchObject({ receiver: 4, commandSet: 4, commandId: 12, ack: 0 });
    expect(Buffer.from(f.writes[0].command.payload!).toString('hex')).toBe('32000000140080');
    expect(f.writes[0].options.deadline).toBe(1500); expect(f.writes[0].options.admission!()).toBe(true);
    f.writes[0].resolve(); await settle(); f.freshAdvance(99); expect(f.writes).toHaveLength(1);
    f.freshAdvance(1); expect(f.writes).toHaveLength(2);
    f.controller.close();
  });
  it('renewal cancels the old queued write and cannot exceed the frame cadence', async () => {
    const f = fixture(); const r = f.admit(f.issue()); if (!r.accepted || !r.next) throw new Error('no grant');
    const old = f.writes[0]; f.freshAdvance(10); expect(f.admit(r.next, -5, 2, 1).accepted).toBe(true);
    expect(old.options.signal!.aborted).toBe(true); expect(old.options.admission!()).toBe(false);
    old.resolve(); await settle(); f.freshAdvance(89); expect(f.writes).toHaveLength(1);
    f.freshAdvance(1); expect(f.writes).toHaveLength(2);
    expect(Buffer.from(f.writes[1].command.payload!).toString('hex')).toBe('ceff0000ecff80'); f.controller.close();
  });
  it('never overlaps writes or builds a backlog when a writer stalls', async () => {
    const f = fixture(); f.admit(f.issue());
    for (let n = 0; n < 4; n++) f.freshAdvance(100);
    expect(f.writes).toHaveLength(1); f.freshAdvance(100);
    expect(f.writes[0].options.signal!.aborted).toBe(true); f.writes[0].resolve(); await settle();
    f.freshAdvance(1000); expect(f.writes).toHaveLength(1); f.controller.close();
  });
  it.each(['end','zero','reset','disconnect','close','expire'] as const)('%s revokes queued admission and never resumes', async method => {
    const f = fixture(); const g = f.issue(); const r = f.admit(g); const w = f.writes[0];
    if (method === 'end') f.controller.end('alice',g.gesture);
    else if (method === 'zero' && r.accepted && r.next) f.admit(r.next,0,0,1);
    else if (method === 'expire') f.clock.advance(500, false);
    else if (method !== 'zero') f.controller[method]();
    expect(w.options.admission!()).toBe(false); expect(w.options.signal!.aborted).toBe(true);
    w.resolve(); await settle(); f.controller.connect(); f.freshAdvance(1000); expect(f.writes).toHaveLength(1); f.controller.close();
  });
  it.each(['stale','limit','mode','bounds'] as const)('queued dispatch rechecks latest %s and retires the gesture', async change => {
    const f = fixture(); const g = f.issue(); const r = f.admit(g); const w = f.writes[0];
    if (change === 'stale') f.clock.advance(200,false);
    if (change === 'limit') { f.context.attitude!.yawLimit = true; f.context.limitDirections.yaw = 1; }
    if (change === 'mode') f.context.attitude!.mode = 3;
    if (change === 'bounds') f.context.envelopes = [];
    expect(w.options.admission!()).toBe(false); expect(w.options.signal!.aborted).toBe(true);
    f.context.attitude!.at = f.clock.time; f.context.attitude!.yawLimit = false; f.context.attitude!.mode = 1;
    w.resolve(); await settle(); f.freshAdvance(100);
    expect(f.writes).toHaveLength(1);
    if(r.accepted && r.next) expect(f.admit(r.next,5,0,1).accepted).toBe(false); f.controller.close();
  });
  it('the repeat timer refuses stale attitude before enqueueing another frame', async () => {
    const f = fixture(); f.admit(f.issue()); f.writes[0].resolve(); await settle();
    f.clock.advance(200); expect(f.writes).toHaveLength(1);
    f.context.attitude!.at = f.clock.time; f.freshAdvance(100); expect(f.writes).toHaveLength(1); f.controller.close();
  });
  it('a short attitude freshness budget aborts pending I/O at expiry without waiting for a frame tick', () => {
    const f = fixture(); f.context.attitudeMaxAgeMs = 25; f.admit(f.issue());
    f.clock.advance(25); expect(f.writes[0].options.signal!.aborted).toBe(true); f.controller.close();
  });
  it('context refresh immediately cancels a newly observed fault while writer is pending', () => {
    const f = fixture(); f.admit(f.issue()); f.context.attitude!.fault = true; f.controller.refresh();
    expect(f.writes[0].options.signal!.aborted).toBe(true); f.controller.close();
  });
  it('synchronous writer failure leaves no timer or retained gesture', () => {
    const f = fixture(); const c = new GimbalController({ clock: f.clock, context: () => f.context, write: () => { throw new Error('closed'); } });
    const r = c.issue('alice'); if (!r.accepted) throw new Error(r.reason);
    c.admit('alice', { ...r.grant, seq: 0, rate: { pan: 1, tilt: 0 } });
    expect(f.clock.timers.size).toBe(0); expect(c.issue('alice').accepted).toBe(false); c.close();
  });
  it('write failure discards the rate and requires an explicit reconnect plus new gesture', async () => {
    const f = fixture(); f.admit(f.issue()); f.writes[0].reject(new Error('link lost')); await settle();
    expect(f.controller.issue('alice').accepted).toBe(false); f.controller.connect(); f.freshAdvance(1000);
    expect(f.writes).toHaveLength(1); f.admit(f.issue()); expect(f.writes).toHaveLength(2); f.controller.close();
  });
  it.each([{ kind: 'recentre' },{ kind: 'mode', mode: 2 }] as const)('guards $kind and reports accepted separately from observed attitude', async command => {
    const f = fixture(); const g = f.issue();
    expect(await f.controller.action('bob',command)).toMatchObject({ accepted: false, reason: 'busy' });
    const p = f.controller.action('alice',command); expect(f.writes).toHaveLength(1);
    expect(f.admit(g).accepted).toBe(false); expect(f.controller.issue('bob').accepted).toBe(false);
    expect(f.writes[0].command).toMatchObject({ commandSet: 4, commandId: command.kind === 'mode' ? 0x44 : 0x4c, receiver: 4 });
    expect(Buffer.from(f.writes[0].command.payload!).toString('hex')).toBe(command.kind === 'mode' ? '02' : '0201');
    f.writes[0].resolve(); expect(await p).toEqual({ accepted: true }); expect(f.context.attitude!.mode).toBe(1); f.controller.close();
  });
  it('refused action still ends its owners active gesture, and cannot overlap pending rate', async () => {
    const f = fixture(); f.admit(f.issue());
    expect(await f.controller.action('alice',{ kind: 'recentre' })).toMatchObject({ accepted: false });
    expect(f.writes[0].options.signal!.aborted).toBe(true); expect(f.writes).toHaveLength(1);
    f.writes[0].resolve(); await settle(); f.context.actions = [];
    expect(await f.controller.action('alice',{ kind: 'recentre' })).toMatchObject({ accepted: false, reason: 'trajectory-unverified' }); f.controller.close();
  });
  it('blocked writer uses bounded 10 Hz wakeups, without a millisecond polling loop', () => {
    const f = fixture(); f.admit(f.issue()); f.freshAdvance(100);
    expect(Math.min(...[...f.clock.timers.values()].map(t => t.at))).toBe(1200);
    f.controller.close();
  });
  it('mode acceptance inhibits rates until fresh target-mode readback', async () => {
    const f = fixture(); const p = f.controller.action('alice', { kind: 'mode', mode: 2 });
    f.writes[0].resolve(); await p;
    expect(f.admit(f.issue())).toMatchObject({ accepted: false, reason: 'mode-unobserved' });
    f.context.attitude!.mode = 2;
    expect(f.admit(f.issue())).toMatchObject({ accepted: false, reason: 'mode-unobserved' });
    f.freshAdvance(1);
    expect(f.admit(f.issue())).toMatchObject({ accepted: true }); f.controller.close();
  });
  it('invalid target-mode telemetry cannot clear the mode observation interlock', async () => {
    const f = fixture(); const p = f.controller.action('alice', { kind: 'mode', mode: 2 });
    f.writes[0].resolve(); await p;
    f.context.attitude!.mode = 2; f.context.attitude!.at = 2000;
    expect(f.admit(f.issue()).accepted).toBe(false);
    f.context.attitude!.mode = 1; f.context.attitude!.at = 1000;
    expect(f.admit(f.issue())).toMatchObject({ accepted: false, reason: 'mode-unobserved' }); f.controller.close();
  });
  it('the discrete-action API cannot inject a rate without Intent admission', async () => {
    const f = fixture();
    const p = f.controller.action('alice', { kind: 'rate', pan: 5, tilt: 0 } as any);
    // Resolve any erroneous write to make the assertion independent of a timeout.
    f.writes[0]?.resolve();
    expect(await p).toMatchObject({ accepted: false, reason: 'malformed-command' });
    expect(f.writes).toHaveLength(0); f.controller.close();
  });
  it('a shorter configured lease reaches the actual writer and cannot exceed its stop allowance', () => {
    const f = fixture(); const c = new GimbalController({ clock: f.clock, leaseMs: 120, context: () => f.context,
      write: (command, options) => { f.writes.push({ command, options, resolve() {}, reject() {} }); return new Promise(() => {}); } });
    const r = c.issue('alice'); if (!r.accepted) throw new Error(r.reason);
    expect(c.admit('alice', { ...r.grant, seq: 0, rate: { pan: 1, tilt: 0 } }).accepted).toBe(true);
    expect(f.writes[0].options.deadline).toBe(1120);
    f.clock.advance(120, false); expect(f.writes[0].options.admission!()).toBe(false); c.close();
    f.context.intentAllowanceMs = 100;
    expect(f.admit(f.issue())).toMatchObject({ accepted: false, reason: 'stop-allowance-unknown' }); f.controller.close();
  });
  it('discrete pending I/O is revoked when attitude ages out, even without another push', async () => {
    const f = fixture(); const p = f.controller.action('alice', { kind: 'recentre' });
    f.clock.advance(200); expect(f.writes[0].options.signal!.aborted).toBe(true);
    f.writes[0].resolve(); expect(await p).toEqual({ accepted: false, reason: 'revoked' }); f.controller.close();
  });
  it('discrete action admission rechecks the physical pose after queuing', async () => {
    const f = fixture(); const p = f.controller.action('alice', { kind: 'recentre' });
    f.context.attitude!.pitchLimit = true;
    expect(f.writes[0].options.admission!()).toBe(false); expect(f.writes[0].options.signal!.aborted).toBe(true);
    f.writes[0].reject(new Error('revoked')); expect(await p).toMatchObject({ accepted: false }); f.controller.close();
  });
});
