// Read-only MAVLink flight-instrument adapter. Aviation units remain explicit.
// SPDX-License-Identifier: GPL-3.0-or-later
export function pfdState(t = {}) {
  const live = t.ready === true;
  const field = (name, valid = () => true) => live && Number.isFinite(t[name]) && valid(t[name]) ? t[name] : null;
  const roll = field('rollDeg', x => Math.abs(x) <= 180),
    pitch = field('pitchDeg', x => Math.abs(x) <= 90);
  const heading = field('headingDeg');
  const navRoll = t.fdReady === true ? field('navRollDeg', x => Math.abs(x) <= 180) : null;
  const navPitch = t.fdReady === true ? field('navPitchDeg', x => Math.abs(x) <= 90) : null;
  return {
    live,
    attitudeValid: roll !== null && pitch !== null,
    roll,
    pitch,
    navRoll,
    navPitch,
    fdValid: navRoll !== null && navPitch !== null && roll !== null && pitch !== null,
    airspeed: field('airspeedKt', x => x >= 0),
    altitude: field('altitudeFt'),
    vsi: field('verticalSpeedFpm'),
    groundspeed: field('groundspeedKt', x => x >= 0),
    heading: heading === null ? null : (heading % 360 + 360) % 360
  };
}
export function attitudeTransform(p) {
  return p.attitudeValid ? `rotate(${-p.roll} 320 225) translate(0 ${p.pitch*5})` : '';
}
export function tapeTicks(value, step, pixelsPerUnit, halfHeight = 130) {
  if (!Number.isFinite(value)) return [];
  const first = Math.ceil((value - halfHeight / pixelsPerUnit) / step),
    last = Math.floor((value + halfHeight / pixelsPerUnit) / step);
  return Array.from({
    length: last - first + 1
  }, (_, i) => ({
    value: (i + first) * step,
    offset: (value - (i + first) * step) * pixelsPerUnit
  }));
}
// SDU460's G3X-style VSI: expanded spacing within +/-1000 fpm, then compressed
// to the +/-2000 marks. Positive offsets are above the fixed zero datum.
export function verticalSpeedOffset(fpm) {
  if (!Number.isFinite(fpm)) return null;
  const speed = Math.min(2000, Math.abs(fpm));
  return Math.sign(fpm) * (speed <= 1000 ? speed * .09 : 90 + (speed - 1000) * .03);
}
