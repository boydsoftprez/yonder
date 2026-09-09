// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { guard, type GuardContext } from './guard.js';

// Synthetic geometry only: deliberately not an installation's hardware limits.
function context(): GuardContext {
  const envelope = { yaw: [-50, 50], pitch: [-40, 40], roll: [-5, 5] } as const;
  return {
    now: 1000, attitudeMaxAgeMs: 200, mount: 'test-mount', discreteApplicable: true,
    attitude: { pitch: 0, roll: 0, yaw: 0, mode: 1, at: 1000, pitchLimit: false, yawLimit: false, fault: false },
    envelopes: [{ mount: 'test-mount', mode: 1, ...envelope }, { mount: 'test-mount', mode: 2, ...envelope }],
    signs: { pan: 1, tilt: 1 }, limitDirections: {},
    intentAllowanceMs: 500, deviceStopAllowanceMs: 800,
    actions: [
      { mount: 'test-mount', fromMode: 1, command: { kind: 'recentre' }, start: envelope, trajectory: envelope },
      { mount: 'test-mount', fromMode: 1, command: { kind: 'mode', mode: 2 }, start: envelope, trajectory: envelope },
    ],
  };
}
const rate = { kind: 'rate', pan: 10, tilt: 0 } as const;
describe('physical motion guard (synthetic measured context)', () => {
  it.each([[-179,0,0], [179,89.7,0], [95,-89.7,179], [0,110,-90]])('admits native rates at world yaw/pitch/roll %s/%s/%s without a world profile', (yaw,pitch,roll) => {
    const c = context(); Object.assign(c.attitude!, { yaw,pitch,roll });
    c.mount = null; c.envelopes = []; c.signs = { pan:null, tilt:null };
    expect(guard(rate, c)).toEqual({ allowed: true });
    expect(guard({ kind:'rate', pan:-5, tilt:5 }, c)).toEqual({ allowed: true });
  });
  it.each([
    ['attitude-missing', (c: GuardContext) => { c.attitude = null; }],
    ['attitude-stale', (c: GuardContext) => { c.attitude!.at = 800; }],
    ['attitude-stale', (c: GuardContext) => { c.attitude!.at = 1001; }],
    ['attitude-stale', (c: GuardContext) => { c.attitudeMaxAgeMs = NaN; }],
    ['attitude-malformed', (c: GuardContext) => { c.attitude!.pitch = NaN; }],
    ['mode-unknown', (c: GuardContext) => { c.attitude!.mode = 3; }],
    ['fault', (c: GuardContext) => { c.attitude!.fault = true; }],
    ['stop-allowance-unknown', (c: GuardContext) => { c.deviceStopAllowanceMs = NaN; }],
    ['stop-allowance-unknown', (c: GuardContext) => { c.intentAllowanceMs = -1; }],
  ] as const)('refuses %s', (reason, change) => {
    const c = context(); change(c);
    expect(guard(rate, c)).toEqual({ allowed: false, reason });
  });
  it.each([NaN, Infinity, 120.1, -120.1])('refuses malformed or over-cap rate %s', pan => {
    expect(guard({ ...rate, pan }, context()).allowed).toBe(false);
  });
  it('admits the documented controllable rate while bounding combined diagonal speed', () => {
    expect(guard({ kind: 'rate', pan: 120, tilt: 0 }, context())).toEqual({ allowed: true });
    expect(guard({ kind: 'rate', pan: 0, tilt: -120 }, context())).toEqual({ allowed: true });
    expect(guard({ kind: 'rate', pan: 72, tilt: 96 }, context())).toEqual({ allowed: true });
    expect(guard({ kind: 'rate', pan: 120, tilt: 120 }, context())).toEqual({ allowed: false, reason: 'rate-cap' });
    const c = context(); c.attitude!.yawLimit = true;
    expect(guard({ kind: 'rate', pan: 120, tilt: 0 }, c)).toEqual({ allowed: false, reason: 'limit-direction-unknown' });
  });
  it('does not use sign-to-world mappings and never exposes roll', () => {
    const c = context(); c.signs.tilt = null;
    expect(guard(rate, c).allowed).toBe(true);
    expect(guard({ kind: 'rate', pan: 0, tilt: 1 }, c)).toEqual({ allowed: true });
    expect(guard({ kind: 'rate', pan: 0, tilt: 0, roll: 1 } as any, c).allowed).toBe(false);
  });
  it('native pan and tilt need no invented world ranges, while discrete trajectories still do', () => {
    const c = context(); delete c.envelopes[0].roll; delete c.envelopes[0].pitch;
    expect(guard(rate, c)).toEqual({ allowed: true });
    expect(guard({ kind: 'rate', pan: 0, tilt: 1 }, c)).toEqual({ allowed: true });
    expect(guard({ kind: 'recentre' }, c)).toEqual({ allowed: false, reason: 'envelope-unknown' });
  });
  it('tilt-only travel does not reinterpret world pitch as a joint stop', () => {
    const c = context(); delete c.envelopes[0].yaw; delete c.envelopes[0].roll;
    c.attitude!.pitch = -27;
    expect(guard({ kind: 'rate', pan: 0, tilt: -10 }, c).allowed).toBe(true);
    c.attitude!.pitch = -27.1;
    expect(guard({ kind: 'rate', pan: 0, tilt: -10 }, c)).toEqual({ allowed: true });
  });
  it('lit joint limits refuse every nonzero native rate, ignoring old world-direction hints', () => {
    const c = context(); c.attitude!.yawLimit = true;
    expect(guard(rate, c)).toEqual({ allowed: false, reason: 'limit-direction-unknown' });
    c.limitDirections.yaw = 1;
    expect(guard(rate, c)).toEqual({ allowed: false, reason: 'limit-direction-unknown' });
    expect(guard({ ...rate, pan: -10 }, c)).toEqual({ allowed: false, reason: 'limit-direction-unknown' });
    c.signs.pan = -1;
    expect(guard(rate, c)).toEqual({ allowed: false, reason: 'limit-direction-unknown' });
    expect(guard({ kind:'rate', pan:0, tilt:5 }, c)).toEqual({ allowed:false, reason:'limit-direction-unknown' });
    c.attitude!.pitchLimit = true; c.limitDirections.pitch = -1;
    expect(guard({ kind: 'rate', pan: 0, tilt: -1 }, c)).toEqual({ allowed: false, reason: 'limit-direction-unknown' });
  });
  it.each(['pitchLimit','yawLimit'] as const)('does not assume another command axis escapes a lit %s after body rotation', flag => {
    const c=context();c.attitude!.pitch=179.9;c.attitude!.roll=90;c.attitude![flag]=true;
    for(const [pan,tilt] of [[5,0],[-5,0],[0,5],[0,-5],[5,5]]) expect(guard({kind:'rate',pan,tilt},c)).toEqual({allowed:false,reason:'limit-direction-unknown'});
    expect(guard({kind:'rate',pan:0,tilt:0},c)).toEqual({allowed:true});
  });
  it('a world-box action certificate needs separately established current mounting applicability', () => {
    const c=context(); delete c.discreteApplicable;
    expect(guard({ kind:'recentre' },c)).toEqual({ allowed:false,reason:'discrete-mount-unverified' });
    expect(guard({ kind:'mode', mode:2 },c)).toEqual({ allowed:false,reason:'discrete-mount-unverified' });
    c.attitude!.yawLimit=true;
    expect(guard({ kind:'recentre' },c)).toEqual({ allowed:false,reason:'at-limit' });
  });
  it.each([{kind:'recentre'}, {kind:'mode',mode:0}, {kind:'mode',mode:1}, {kind:'mode',mode:2}] as const)('uses only an explicit measured native-action policy for $kind/$mode outside world boxes', command => {
    const c=context(); c.discreteApplicable=false;c.mount=null;c.envelopes=[];c.actions=[];
    c.attitude!.pitch=179.9;c.attitude!.yaw=-154.5;c.nativeActions=[command];
    expect(guard(command,c)).toEqual({allowed:true});
    c.nativeActions=[];expect(guard(command,c)).toEqual({allowed:false,reason:'discrete-mount-unverified'});
    c.nativeActions=[command];c.attitude!.pitchLimit=true;expect(guard(command,c)).toEqual({allowed:false,reason:'at-limit'});
    c.attitude!.pitchLimit=false;c.attitude!.yawLimit=true;expect(guard(command,c)).toEqual({allowed:false,reason:'at-limit'});
    c.attitude!.yawLimit=false;c.attitude!.fault=true;expect(guard(command,c)).toEqual({allowed:false,reason:'fault'});
  });
  it('an established mode action does not authorize recentre or an unmeasured target mode',()=>{
    const c=context();c.discreteApplicable=false;c.nativeActions=[{kind:'mode',mode:2}];
    expect(guard({kind:'recentre'},c)).toEqual({allowed:false,reason:'discrete-mount-unverified'});
    expect(guard({kind:'mode',mode:1},c)).toEqual({allowed:false,reason:'discrete-mount-unverified'});
  });
  it.each([{ kind: 'recentre' }, { kind: 'mode', mode: 2 }] as const)('requires a contained measured pose and trajectory for $kind', command => {
    const c = context(); expect(guard(command, c).allowed).toBe(true);
    c.actions = []; expect(guard(command, c)).toEqual({ allowed: false, reason: 'trajectory-unverified' });
    c.actions = context().actions;
    c.actions[0].start = { yaw: [-1, 1], pitch: [-1, 1], roll: [-1, 1] };
    c.actions[1].start = c.actions[0].start; c.attitude!.yaw = 2;
    expect(guard(command, c).allowed).toBe(false);
    c.attitude!.yaw = 0; c.actions[0].trajectory.yaw = [-60, 60]; c.actions[1].trajectory.yaw = [-60, 60];
    expect(guard(command, c).allowed).toBe(false);
    c.actions = context().actions; c.attitude!.pitchLimit = true;
    expect(guard(command, c)).toEqual({ allowed: false, reason: 'at-limit' });
  });
  it.each([0, 1] as const)('recentre from mode %s requires a measured Follow 2 target envelope', fromMode => {
    const c = context(); c.attitude!.mode = fromMode;
    c.envelopes[0].mode = fromMode; c.actions[0].fromMode = fromMode;
    c.envelopes.pop();
    expect(guard({ kind: 'recentre' }, c)).toEqual({ allowed: false, reason: 'envelope-unknown' });
  });
  it('recentre trajectory must fit both the source and Follow 2 envelopes', () => {
    const c = context();
    c.actions[0].start = { yaw: [-1, 1], pitch: [-1, 1], roll: [-1, 1] };
    c.actions[0].trajectory = { yaw: [-10, 10], pitch: [-10, 10], roll: [-2, 2] };
    c.envelopes[1].yaw = [-5, 5];
    expect(guard({ kind: 'recentre' }, c)).toEqual({ allowed: false, reason: 'trajectory-unverified' });
    c.envelopes[1].yaw = [-50, 50]; c.envelopes[0].yaw = [-5, 5];
    expect(guard({ kind: 'recentre' }, c)).toEqual({ allowed: false, reason: 'trajectory-unverified' });
    c.envelopes[0].yaw = [-10, 10]; c.envelopes[1].yaw = [-10, 10];
    expect(guard({ kind: 'recentre' }, c)).toEqual({ allowed: true });
  });
  it('mode transition needs the target envelope as well as the source envelope', () => {
    const c = context(); c.envelopes.pop();
    expect(guard({ kind: 'mode', mode: 2 }, c)).toEqual({ allowed: false, reason: 'envelope-unknown' });
    expect(guard({ kind: 'mode', mode: 3 } as any, context()).allowed).toBe(false);
  });
});
