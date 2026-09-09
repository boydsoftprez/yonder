// SPDX-License-Identifier: GPL-3.0-or-later
// Presentation convention follows the community Garmin wind display: positive
// headwind blows aft, positive crosswind comes from the right and blows left.
export function windState(telemetry = {}) {
  const wind = telemetry.wind, heading = telemetry.headingDeg;
  const missing = reason => ({ available: false, reason });
  if (telemetry.ready !== true) return missing('Flight telemetry unavailable');
  if (!wind || wind.source !== 'WIND' || ![wind.directionFromDeg, wind.speedKt, wind.ageMs].every(Number.isFinite)
    || wind.directionFromDeg < 0 || wind.directionFromDeg >= 360 || wind.speedKt < 0 || wind.speedKt > 1943.8444924406
    || wind.ageMs < 0 || wind.ageMs >= 5000) return missing('Fresh autopilot wind estimate unavailable');
  if (!Number.isFinite(heading) || telemetry.fields?.headingDeg?.valid === false) return missing('Aircraft heading unavailable');
  const relativeFromDeg = ((wind.directionFromDeg - heading) % 360 + 360) % 360;
  const relativeRad = relativeFromDeg * Math.PI / 180;
  return { available: true, reason: null, directionFromDeg: wind.directionFromDeg, speedKt: wind.speedKt,
    relativeFromDeg, headwindKt: wind.speedKt * Math.cos(relativeRad), crosswindKt: wind.speedKt * Math.sin(relativeRad) };
}
