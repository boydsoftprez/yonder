// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { guard, type GuardContext } from './guard.js';

// Synthetic geometry only: deliberately not an installation's hardware limits.
function context(): GuardContext {
  const envelope = { yaw: [-50, 50], pitch: [-40, 40], roll: [-5, 5] } as const;
  return {
    now: 1000, attitudeMaxAgeMs: 200, mount: 'test-mount',
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
  it('admits signed travel only with the full 1.3 second stop margin', () => {
    const c = context(); c.attitude!.yaw = 37;
    expect(guard(rate, c)).toEqual({ allowed: true });
    c.attitude!.yaw = 37.1;
    expect(guard(rate, c)).toEqual({ allowed: false, reason: 'stop-margin' });
    expect(guard({ ...rate, pan: -10 }, c)).toEqual({ allowed: true });
    c.signs.pan = -1;
    expect(guard({ ...rate, pan: -10 }, c)).toEqual({ allowed: false, reason: 'stop-margin' });
  });
  it.each([
    ['attitude-missing', (c: GuardContext) => { c.attitude = null; }],
    ['attitude-stale', (c: GuardContext) => { c.attitude!.at = 800; }],
    ['attitude-stale', (c: GuardContext) => { c.attitude!.at = 1001; }],
    ['attitude-stale', (c: GuardContext) => { c.attitudeMaxAgeMs = NaN; }],
    ['attitude-malformed', (c: GuardContext) => { c.attitude!.pitch = NaN; }],
    ['mode-unknown', (c: GuardContext) => { c.attitude!.mode = 3; }],
    ['fault', (c: GuardContext) => { c.attitude!.fault = true; }],
    ['envelope-unknown', (c: GuardContext) => { c.mount = 'other'; }],
    ['envelope-unknown', (c: GuardContext) => { c.envelopes = []; }],
    ['outside-envelope', (c: GuardContext) => { c.attitude!.yaw = 51; }],
    ['sign-unknown', (c: GuardContext) => { c.signs.pan = null; }],
    ['stop-allowance-unknown', (c: GuardContext) => { c.deviceStopAllowanceMs = NaN; }],
    ['stop-allowance-unknown', (c: GuardContext) => { c.intentAllowanceMs = -1; }],
  ] as const)('refuses %s', (reason, change) => {
    const c = context(); change(c);
    expect(guard(rate, c)).toEqual({ allowed: false, reason });
  });
  it.each([NaN, Infinity, 10.1, -10.1])('refuses malformed or over-cap rate %s', pan => {
    expect(guard({ ...rate, pan }, context()).allowed).toBe(false);
  });
  it('requires signs only for commanded axes and never exposes roll', () => {
    const c = context(); c.signs.tilt = null;
    expect(guard(rate, c).allowed).toBe(true);
    expect(guard({ kind: 'rate', pan: 0, tilt: 1 }, c)).toEqual({ allowed: false, reason: 'sign-unknown' });
    expect(guard({ kind: 'rate', pan: 0, tilt: 0, roll: 1 } as any, c).allowed).toBe(false);
  });
  it('pan-only travel needs no invented roll or pitch range, while tilt remains inhibited', () => {
    const c = context(); delete c.envelopes[0].roll; delete c.envelopes[0].pitch;
    expect(guard(rate, c)).toEqual({ allowed: true });
    expect(guard({ kind: 'rate', pan: 0, tilt: 1 }, c)).toEqual({ allowed: false, reason: 'envelope-unknown' });
    expect(guard({ kind: 'recentre' }, c)).toEqual({ allowed: false, reason: 'envelope-unknown' });
  });
  it('tilt-only travel applies the same stop margin without needing yaw bounds', () => {
    const c = context(); delete c.envelopes[0].yaw; delete c.envelopes[0].roll;
    c.attitude!.pitch = -27;
    expect(guard({ kind: 'rate', pan: 0, tilt: -10 }, c).allowed).toBe(true);
    c.attitude!.pitch = -27.1;
    expect(guard({ kind: 'rate', pan: 0, tilt: -10 }, c)).toEqual({ allowed: false, reason: 'stop-margin' });
  });
  it('lit limits refuse into travel; away needs the verified stop direction', () => {
    const c = context(); c.attitude!.yawLimit = true;
    expect(guard(rate, c)).toEqual({ allowed: false, reason: 'limit-direction-unknown' });
    c.limitDirections.yaw = 1;
    expect(guard(rate, c)).toEqual({ allowed: false, reason: 'into-limit' });
    expect(guard({ ...rate, pan: -10 }, c)).toEqual({ allowed: true });
    c.signs.pan = -1;
    expect(guard(rate, c)).toEqual({ allowed: true });
    c.attitude!.pitchLimit = true; c.limitDirections.pitch = -1;
    expect(guard({ kind: 'rate', pan: 0, tilt: -1 }, c)).toEqual({ allowed: false, reason: 'into-limit' });
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
  it('mode transition needs the target envelope as well as the source envelope', () => {
    const c = context(); c.envelopes.pop();
    expect(guard({ kind: 'mode', mode: 2 }, c)).toEqual({ allowed: false, reason: 'envelope-unknown' });
    expect(guard({ kind: 'mode', mode: 3 } as any, context()).allowed).toBe(false);
  });
});
