// SPDX-License-Identifier: GPL-3.0-or-later
// A ball follows apparent gravity, opposite measured specific force. This is an
// inclinometer indication, not aerodynamic sideslip angle or GPS crab angle.
export function slipSkidState(telemetry = {}) {
  const a = telemetry.slipSkid;
  const missing = reason => ({available: false, position: null, reason});
  if (telemetry.ready !== true) return missing('Flight telemetry unavailable');
  if (!a || !['RAW_IMU','SCALED_IMU'].includes(a.source) || ![a.lateralG,a.normalG,a.ageMs].every(Number.isFinite)
    || Math.abs(a.lateralG)>=16 || a.normalG<=.2 || a.normalG>=16 || a.ageMs<0 || a.ageMs>=2000)
    return missing('Fresh, healthy primary accelerometer data required');
  const angleDeg = (Math.atan2(-a.lateralG, a.normalG) * 180 / Math.PI) || 0;
  // Yonder's display scale: full travel at 10° apparent-gravity deflection.
  return {available: true, reason: null, angleDeg, position: Math.max(-1,Math.min(1,angleDeg / 10)), lateralG:a.lateralG, normalG:a.normalG};
}
