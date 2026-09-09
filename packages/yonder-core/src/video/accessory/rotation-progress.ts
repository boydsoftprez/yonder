// SPDX-License-Identifier: GPL-3.0-or-later
import type { GimbalAttitude } from './guard.js';

export type WorldQuaternion = readonly [number, number, number, number];
export function normalizedQuaternion(value: unknown): WorldQuaternion | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  const norm = Math.hypot(...value);
  if (Math.abs(norm - 1) > 0.01) return null;
  return Object.freeze(value.map(v => v / norm)) as unknown as WorldQuaternion;
}

type Window = {
  epoch: object; axis: 'pan' | 'tilt'; sign: number; minimumRate: number;
  writtenAt: number; afterSampleAt: number; eligibleAt: number; lastSampleAt: number;
  baseline?: { quaternion: WorldQuaternion; at: number }; samples: number;
};
const NO_ROTATION = 'No camera rotation observed; release and try another direction.';
const NO_FEEDBACK = 'Camera rotation feedback is unavailable; release and try again.';
// Engineering cancellation thresholds, not joint bounds. The measured upright
// stationary sample varied by 0.00163 degrees over 4 s, with <=101 ms gaps.
const MIN_ROTATION_DEGREES = 0.1;
const COMMAND_OPPORTUNITY_DEGREES = 0.5;
const MIN_WINDOW_MS = 1000;
const MAX_WRITE_GAP_MS = 300;
const MAX_SAMPLE_GAP_MS = 500;

/** R-CAM-11: a current-gesture watchdog, never joint geometry or a stop latch.
 * Body motion can hide or imitate camera progress; diagonal input cannot identify
 * a stalled individual axis. Native clamps remain the rate travel constraint.
 */
export class RotationProgress {
  private window?: Window;
  reset(): void { this.window = undefined; }
  completed(epoch: object, rate: { pan: number; tilt: number }, at: number, sampleAt: number, stopAllowanceMs: number): void {
    const axis = rate.pan !== 0 && rate.tilt === 0 ? 'pan' : rate.tilt !== 0 && rate.pan === 0 ? 'tilt' : null;
    if (!axis) { this.reset(); return; }
    const speed = Math.abs(rate[axis]);
    const sign = Math.sign(rate[axis]);
    const w = this.window;
    if (!w || w.epoch !== epoch || w.axis !== axis || w.sign !== sign || at - w.writtenAt > MAX_WRITE_GAP_MS) {
      // A preceding native command can continue through its stopping tail.
      // Do not attribute that rotation to this newly sustained direction.
      const eligibleAt = at + stopAllowanceMs;
      this.window = { epoch, axis, sign, minimumRate: speed, writtenAt: at, afterSampleAt: sampleAt,
        eligibleAt, lastSampleAt: eligibleAt, samples: 0 };
    } else {
      w.writtenAt = at;
      w.minimumRate = Math.min(w.minimumRate, speed);
    }
  }
  observe(epoch: object, sample: GimbalAttitude, now: number): string | null {
    const w = this.window;
    if (!w || w.epoch !== epoch) return null;
    if (now - w.writtenAt > MAX_WRITE_GAP_MS) { this.reset(); return null; }
    if (now < w.eligibleAt) return null;
    // Duplicated reads, sparse/missing quaternion reports, and timestamps from
    // before physical completion are not evidence of either movement or rest.
    if (now - w.lastSampleAt >= MAX_SAMPLE_GAP_MS) return NO_FEEDBACK;
    if (sample.at <= w.afterSampleAt || sample.at < w.eligibleAt || sample.at <= w.lastSampleAt || sample.at > now) return null;
    const q = normalizedQuaternion(sample.quaternion);
    if (!q) return null;
    w.lastSampleAt = sample.at;
    if (!w.baseline) { w.baseline = { quaternion: q, at: sample.at }; w.samples = 1; return null; }
    w.samples++;
    const dot = Math.abs(q.reduce((sum, v, i) => sum + v * w.baseline!.quaternion[i], 0));
    const degrees = 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
    if (degrees >= MIN_ROTATION_DEGREES) {
      // Excursion from the baseline, not summed jitter or Euler subtraction.
      w.baseline = { quaternion: q, at: sample.at }; w.samples = 1;
      return null;
    }
    const requiredMs = Math.max(MIN_WINDOW_MS, COMMAND_OPPORTUNITY_DEGREES / w.minimumRate * 1000);
    return w.samples >= 6 && sample.at - w.baseline.at >= requiredMs ? NO_ROTATION : null;
  }
}
