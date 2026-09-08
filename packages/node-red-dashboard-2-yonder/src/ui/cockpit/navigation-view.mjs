// SPDX-License-Identifier: GPL-3.0-or-later
import {isPositionItem} from './mission-import.mjs';
import {guidedNavigationUnavailable, guidedSource} from './guided-navigation.mjs';
import {missionSequence,missionLegMatch} from './mission-sequence.mjs';
import {
  aircraftMission,
  bearing,
  distance
} from './cockpit-state.mjs';
// Preserve the authored display's sign conventions. Right-of-path deviation is
// negative in its view model; the bar indicates the correcting direction.
export function cdiDeflection(g, scale) {
  if (!g?.valid || !Number.isFinite(scale) || scale <= 0) return null;
  const error = g.deviationKind === 'radial' ? (g.radialValid ? g.radialErrorM : null) : (g.lateralValid && Number
    .isFinite(g.crossTrackM) ? -g.crossTrackM : null);
  return Number.isFinite(error) ? Math.max(-1, Math.min(1, error / scale)) || 0 : null;
}
export function navigationView(snapshot, elapsed = 0) {
  const t = snapshot.telemetry || {},
    n = t.navController,
    p = {
      lat: t.latitude,
      lon: t.longitude
    },
    mission = aircraftMission(snapshot);
  const base = {
    valid: false,
    preview: false,
    target: null,
    seq: null,
    reason: 'Waiting for current aircraft guidance'
  };
  if (!t.ready || elapsed >= 2000) return {
    ...base,
    reason: 'Flight telemetry unavailable'
  };
  const unavailable = guidedNavigationUnavailable(snapshot);
  if (unavailable) return {...base, targetName:'GUIDED', guidanceSource:guidedSource, reason:unavailable};
  const fresh = n && n.ageMs + elapsed < 2000 && n.autopilotId === 3;
  if (t.mode === 'GUIDED' && t.positionTarget && t.positionTarget.ageMs + elapsed < 2000) {
    const target = t.positionTarget,
      dist = distance(p, target),
      matched = n?.positionTarget && Math.abs(n.positionTarget.lat - target.lat) < 1e-7 && Math.abs(n.positionTarget
        .lon - target.lon) < 1e-7 && n.positionTarget.frame === target.frame && Math.abs(n.positionTarget.alt - target
        .alt) < .1;
    const radialValid = !!(fresh && matched && n.mode === 'GUIDED' && Math.abs(((n.navBearingDeg - n.targetBearingDeg +
      540) % 360) - 180) <= 2);
    return {
      ...base,
      valid: dist !== null,
      target,
      targetName: 'GUIDED',
      guidanceSource: guidedSource,
      guided: true,
      distanceM: dist,
      bearingDeg: bearing(p, target),
      deviationKind: 'radial',
      radialValid,
      radialErrorM: radialValid ? n.crossTrackM : null,
      pathBearingDeg: radialValid ? n.navBearingDeg : null,
      trackTitle: 'LOITER CENTER',
      reason: radialValid ? 'GUIDED loiter · radial error' : 'GUIDED · target bearing',
      eteSeconds: t.groundspeedKt > 1 ? dist / (t.groundspeedKt * 1852 / 3600) : null
    };
  }
  if (t.mode !== 'AUTO' || !snapshot.mission?.currentFresh || snapshot.mission.synchronization!=='verified') return base;
  const target = mission.items.find(item => item.seq === snapshot.mission.currentSeq),
    dist = distance(p, target);
  if(!target||!isPositionItem(target)||dist===null)return {...base,reason:'Current item has no fixed geographic target'};
  const sequence=missionSequence(snapshot);
  const lateralValid = !!(fresh && n.mode === 'AUTO' && target.command === 16 && n.missionSeq === target.seq
    && missionLegMatch(target,sequence,n,t.groundspeedKt));
  return {
    ...base,
    valid: true,
    target,
    seq: target.seq,
    targetName: `WP${target.seq}`,
    distanceM: dist,
    bearingDeg: bearing(p, target),
    lateralValid,
    crossTrackM: lateralValid ? -n.crossTrackM : null,
    desiredTrackDeg: lateralValid ? sequence.courseDeg : null,
    trackTitle: 'LEG COURSE',
    fromSeq: sequence.fromSeq,
    fromName: sequence.fromName,
    nextSeq: sequence.nextSeq,
    reason: lateralValid ? 'Uploaded leg · autopilot cross-track' : 'Waiting for matching leg guidance · target bearing only',
    eteSeconds: t.groundspeedKt > 1 ? dist / (t.groundspeedKt * 1852 / 3600) : null
  };
}
