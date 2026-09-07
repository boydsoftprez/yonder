// Presentation only. Interpolate received poses; never predict aircraft motion.
// SPDX-License-Identifier: GPL-3.0-or-later
const fields = ['lat', 'lon', 'altitude', 'heading', 'pitch', 'roll'];
const delta = (a, b) => ((b - a + 540) % 360) - 180;
const wrap = value => ((value + 180) % 360 + 360) % 360 - 180;
export class PosePresentation {
  constructor(delayMs = 100) {
    this.delayMs = delayMs;
    this.samples = [];
  }
  push(pose, time) {
    if (!pose || !Number.isFinite(time) || !fields.every(key => Number.isFinite(pose[key])) || Math.abs(pose.lat) >
      85 || Math.abs(pose.lon) > 180 || Math.abs(pose.roll) > 180 || Math.abs(pose.pitch) > 90) {
      this.samples = [];
      return;
    }
    const last = this.samples.at(-1);
    if (last) {
      const moved = Math.hypot((pose.lat - last.pose.lat) * 111195, delta(last.pose.lon, pose.lon) * 111195 * Math
        .cos(pose.lat * Math.PI / 180));
      if (time <= last.time || time - last.time > 500 || moved > 250 || Math.abs(pose.altitude - last.pose.altitude) >
        200) this.samples = [];
    }
    this.samples.push({
      pose: {
        ...pose
      },
      time
    });
    if (this.samples.length > 8) this.samples.shift();
  }
  at(time) {
    if (!this.samples.length) return null;
    const target = time - this.delayMs;
    if (target <= this.samples[0].time) return {
      ...this.samples[0].pose
    };
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1],
        b = this.samples[i];
      if (target > b.time) continue;
      const fraction = (target - a.time) / (b.time - a.time),
        out = {
          ...b.pose
        };
      for (const key of [...fields, 'navPitch', 'navRoll']) {
        if (!Number.isFinite(a.pose[key]) || !Number.isFinite(b.pose[key])) continue;
        out[key] = a.pose[key] + (['lon', 'heading', 'roll', 'navRoll'].includes(key) ? delta(a.pose[key], b.pose[
          key]) : b.pose[key] - a.pose[key]) * fraction;
        if (key === 'heading') out[key] = (out[key] % 360 + 360) % 360;
        if (['lon', 'roll', 'navRoll'].includes(key)) out[key] = wrap(out[key]);
      }
      return out;
    }
    return {
      ...this.samples.at(-1).pose
    };
  }
}
