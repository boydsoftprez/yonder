// SPDX-License-Identifier: GPL-3.0-or-later
/** R-CAM-11 / R-TEL-15: unknown measurements remain unknown. */
export interface GimbalAttitude {
  pitch: number; roll: number; yaw: number; mode: number; at: number;
  /** Camera attitude in the world frame, not body-relative joint travel. */
  quaternion?: import('./rotation-progress.js').WorldQuaternion | null;
  pitchLimit: boolean; yawLimit: boolean;
  /** Unclassified limit bits (including bit 2), never a verified roll limit. */
  fault: boolean;
}
export type GimbalMode = 0 | 1 | 2;
export type MotionCommand = { kind: 'rate'; pan: number; tilt: number }
  | { kind: 'recentre' } | { kind: 'mode'; mode: GimbalMode };
export interface PoseRegion {
  yaw: readonly [number, number]; pitch: readonly [number, number]; roll: readonly [number, number];
}
export interface MeasuredEnvelope extends Partial<PoseRegion> { mount: string; mode: GimbalMode }
export interface MeasuredAction {
  mount: string; fromMode: GimbalMode; command: Exclude<MotionCommand, { kind: 'rate' }>;
  /** Bench establishes the entire action path for every admitted starting pose. */
  start: PoseRegion; trajectory: PoseRegion;
}
export interface GuardContext {
  now: number; attitudeMaxAgeMs: number; attitude: GimbalAttitude | null;
  /** A separate, current installation proof. A world-angle box alone is not portable. */
  discreteApplicable?: boolean;
  /** Exact device-native actions established independently of world-angle boxes. */
  nativeActions?: readonly Exclude<MotionCommand, { kind: 'rate' }>[];
  mount: string | null; envelopes: MeasuredEnvelope[];
  /** Positive public rate to reported attitude, after wire conversion. */
  signs: { pan: 1 | -1 | null; tilt: 1 | -1 | null };
  /** Reported-position direction into the currently lit stop; absent means unknown. */
  limitDirections: { yaw?: 1 | -1; pitch?: 1 | -1 };
  intentAllowanceMs: number; deviceStopAllowanceMs: number;
  actions: MeasuredAction[];
}
export type GuardReason = 'malformed-command' | 'rate-cap' | 'attitude-missing' | 'attitude-stale'
  | 'attitude-malformed' | 'mode-unknown' | 'fault' | 'envelope-unknown' | 'outside-envelope'
  | 'sign-unknown' | 'stop-allowance-unknown' | 'stop-margin' | 'limit-direction-unknown'
  | 'into-limit' | 'at-limit' | 'trajectory-unverified' | 'mode-unobserved' | 'discrete-mount-unverified';
export type GuardResult = { allowed: true } | { allowed: false; reason: GuardReason };
const axes = ['yaw', 'pitch', 'roll'] as const;
const refuse = (reason: GuardReason): GuardResult => ({ allowed: false, reason });
function boundsValid(bounds: unknown): bounds is readonly [number, number] {
  return Array.isArray(bounds) && bounds.length === 2 && bounds.every(Number.isFinite) && bounds[0] <= bounds[1];
}
function regionValid(r: Partial<PoseRegion>): r is PoseRegion {
  return !!r && axes.every(axis => boundsValid(r[axis]));
}
function contains(region: PoseRegion, a: GimbalAttitude): boolean {
  return axes.every(axis => a[axis] >= region[axis][0] && a[axis] <= region[axis][1]);
}
function inside(inner: PoseRegion, outer: PoseRegion): boolean {
  return axes.every(axis => inner[axis][0] >= outer[axis][0] && inner[axis][1] <= outer[axis][1]);
}
/** Pure single guard for every exposed motion path. No factory geometry. */
export function guard(cmd: MotionCommand, c: GuardContext): GuardResult {
  if (!cmd || !['rate', 'recentre', 'mode'].includes(cmd.kind) || 'roll' in cmd
    || (cmd.kind === 'mode' && ![0, 1, 2].includes(cmd.mode))) return refuse('malformed-command');
  if (cmd.kind === 'rate') {
    if (![cmd.pan, cmd.tilt].every(Number.isFinite)) return refuse('malformed-command');
    if (Math.abs(cmd.pan) > 10 || Math.abs(cmd.tilt) > 10) return refuse('rate-cap');
  }
  const a = c.attitude;
  if (!a) return refuse('attitude-missing');
  if (![c.now, a.at, c.attitudeMaxAgeMs].every(Number.isFinite) || c.attitudeMaxAgeMs <= 0
    || c.now < a.at || c.now - a.at >= c.attitudeMaxAgeMs) return refuse('attitude-stale');
  if (!axes.every(axis => Number.isFinite(a[axis]))
    || [a.pitchLimit, a.yawLimit, a.fault].some(value => typeof value !== 'boolean')) return refuse('attitude-malformed');
  if (![0, 1, 2].includes(a.mode)) return refuse('mode-unknown');
  if (a.fault) return refuse('fault');
  if (cmd.kind === 'rate') {
    if (![c.intentAllowanceMs, c.deviceStopAllowanceMs].every(v => Number.isFinite(v) && v > 0)) return refuse('stop-allowance-unknown');
    // Native 0x80 rate control retains the camera's own clamps. Ground Euler
    // angles and the old sign/range profile cannot establish joint travel after
    // body reorientation. Neither the flagged joint's command-axis mapping nor
    // an escape direction is verified across orientations, so any lit flag
    // inhibits all nonzero motion, including a proposed other-axis escape.
    if ((cmd.pan !== 0 || cmd.tilt !== 0) && (a.yawLimit || a.pitchLimit)) return refuse('limit-direction-unknown');
    return { allowed: true };
  }
  if (a.pitchLimit || a.yawLimit) return refuse('at-limit');
  if (c.nativeActions?.some(action => action.kind === cmd.kind
    && (cmd.kind === 'recentre' || (action.kind === 'mode' && action.mode === cmd.mode)))) return { allowed: true };
  if (c.discreteApplicable !== true) return refuse('discrete-mount-unverified');
  const envelope = c.envelopes.find(e => e.mount === c.mount && e.mode === a.mode);
  if (!c.mount || !envelope) return refuse('envelope-unknown');
  if (!regionValid(envelope)) return refuse('envelope-unknown');
  if (!contains(envelope, a)) return refuse('outside-envelope');
  // Measured 4/4c 02 01 recentre also selects Follow mode 2. Its entire
  // certified trajectory must fit both the observed source and that target.
  const targetMode = cmd.kind === 'mode' ? cmd.mode : 2;
  const target = c.envelopes.find(e => e.mount === c.mount && e.mode === targetMode);
  if (!target || !regionValid(target)) return refuse('envelope-unknown');
  const verified = c.actions.some(action => action.mount === c.mount && action.fromMode === a.mode
    && action.command.kind === cmd.kind && (cmd.kind !== 'mode' || (action.command.kind === 'mode' && action.command.mode === cmd.mode))
    && regionValid(action.start) && regionValid(action.trajectory) && contains(action.start, a)
    && inside(action.start, action.trajectory) && inside(action.trajectory, envelope) && inside(action.trajectory, target));
  return verified ? { allowed: true } : refuse('trajectory-unverified');
}
