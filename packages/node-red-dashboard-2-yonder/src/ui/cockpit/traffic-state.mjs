// Observed traffic presentation. Internet tracks never become aircraft commands.
// SPDX-License-Identifier: GPL-3.0-or-later
import {
  cameraBasis,
  viewMatrix,
  projectionMatrix,
  transformPoint
} from './terrain-state.mjs';
const RAD = Math.PI / 180,
  R = 6371008.8;
export const trafficRangesNm = Object.freeze([1, 2, 5, 10, 25, 50, 100]);
export const trafficDefaults = Object.freeze({
  enabled: true,
  map: true,
  pfd: true,
  labels: true,
  trails: true,
  showGround: false,
  radiusNm: 10,
  trailSeconds: 120
});
export function validateTrafficOptions(input = {}) {
  const result = {
    ...trafficDefaults
  };
  for (const key of ['enabled', 'map', 'pfd', 'labels', 'trails', 'showGround'])
    if (typeof input?.[key] === 'boolean') result[key] = input[key];
  if (trafficRangesNm.includes(input?.radiusNm)) result.radiusNm = input.radiusNm;
  if ([60, 120, 300].includes(input?.trailSeconds)) result.trailSeconds = input.trailSeconds;
  return result;
}
export function positionValid(p) {
  return Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}
export function separation(a, b) {
  if (!positionValid(a) || !positionValid(b)) return null;
  const p1 = a.lat * RAD,
    p2 = b.lat * RAD,
    dl = (b.lon - a.lon) * RAD,
    dp = p2 - p1;
  const hav = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const angle = 2 * Math.atan2(Math.sqrt(Math.max(0, Math.min(1, hav))), Math.sqrt(Math.max(0, 1 - hav)));
  return {
    distanceM: R * angle,
    bearingRad: Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math
      .cos(dl)),
    angle
  };
}
export function trafficOwnship(f = {}, t = {}) {
  if (t.altitudeDatum !== 'EGM96') return null;
  const altitudeMslM = Number.isFinite(t.globalAltitudeM) ? t.globalAltitudeM : Number.isFinite(t.gpsAltitudeM) ? t
    .gpsAltitudeM : null;
  const p = {
    lat: t.latitude,
    lon: t.longitude,
    altitudeMslM,
    heading: f.heading,
    pitch: f.pitch,
    roll: f.roll
  };
  return f.live && f.attitudeValid && t.ready && t.fixType >= 3 && positionValid(p) && [altitudeMslM, p.heading, p
    .pitch, p.roll
  ].every(Number.isFinite) ? p : null;
}
export function visibleTracks(tracks = [], options = trafficDefaults, now = Date.now(), center = null) {
  if (!options.enabled || !positionValid(center)) return [];
  return tracks.filter(t => positionValid(t) && Number.isFinite(t.observedAtMs) && now - t.observedAtMs <= 60000 &&
      now - t.observedAtMs >= -5000 && (options.showGround || !t.ground))
    .map(t => ({
      ...t,
      ageSeconds: Math.max(0, (now - t.observedAtMs) / 1000),
      stale: now - t.observedAtMs > 15000,
      distanceM: separation(center, t)?.distanceM ?? null
    }))
    .filter(t => t.distanceM !== null && t.distanceM <= options.radiusNm * 1852)
    .sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
}
export function trailSegments(history = [], now = Date.now(), seconds = 120, center = null, radiusNm = null) {
  const result = [];
  let segment = [],
    previous = null;
  if (radiusNm !== null && (!positionValid(center) || !Number.isFinite(radiusNm) || radiusNm <= 0)) return result;
  const finish = () => {
    if (segment.length >= 2) result.push(segment);
    segment = [];
  };
  for (const p of history) {
    if (!positionValid(p) || !Number.isFinite(p.observedAtMs) || now - p.observedAtMs > seconds * 1000 || p
      .observedAtMs > now + 5000 || (radiusNm !== null && separation(center, p).distanceM > radiusNm * 1852)) {
      finish();
      previous = null;
      continue;
    }
    if (previous && (p.breakBefore || p.observedAtMs - previous.observedAtMs > 30000 || p.observedAtMs <= previous
        .observedAtMs)) finish();
    segment.push(p);
    previous = p;
  }
  finish();
  return result;
}
export function projectTrafficPoint(target, own) {
  if (!own || !Number.isFinite(target?.altitudeMslM) || !Number.isFinite(own.altitudeMslM)) return null;
  const geo = separation(own, target);
  if (!geo || geo.distanceM < 5) return null;
  // Spherical local tangent coordinates retain earth curvature at ADS-B ranges.
  const horizontal = (R + target.altitudeMslM) * Math.sin(geo.angle);
  const point = [horizontal * Math.sin(geo.bearingRad), (R + target.altitudeMslM) * Math.cos(geo.angle) - (R + own
    .altitudeMslM), -horizontal * Math.cos(geo.bearingRad), 1];
  const view = transformPoint(viewMatrix([0, 0, 0], cameraBasis(own.heading, own.pitch, own.roll)), point);
  if (view[2] >= -2) return null;
  const clip = transformPoint(projectionMatrix(2, 400000), view),
    x = (clip[0] / clip[3] + 1) * 320,
    y = (1 - clip[1] / clip[3]) * 325;
  if (!Number.isFinite(x + y) || Math.abs(x) > 10000 || Math.abs(y) > 10000) return null;
  return {
    x,
    y,
    distanceM: geo.distanceM,
    relativeAltitudeFt: (target.altitudeMslM - own.altitudeMslM) / .3048,
    visible: x >= 14 && x <= 626 && y >= 20 && y <= 630
  };
}
export function trafficHealth(snapshot = {}, now = Date.now()) {
  if (snapshot.status === 'error') return {
    state: 'error',
    message: snapshot.message || 'Traffic feed unavailable'
  };
  if (!Number.isFinite(snapshot.receivedAtMs)) return {
    state: 'loading',
    message: snapshot.message || 'Connecting to ADSB.lol'
  };
  const age = Math.max(now - snapshot.receivedAtMs, Number.isFinite(snapshot.sourceAtMs) ? now - snapshot.sourceAtMs :
    0, 0) / 1000;
  if (age > 15 || snapshot.status === 'stale') return {
    state: 'stale',
    message: `Traffic delayed · ${Math.round(age)}s`
  };
  return {
    state: 'live',
    message: `ADSB.lol · updated ${Math.round(age)}s ago`
  };
}
export function trafficName(t) {
  return t.callSign?.trim() || t.registration || t.id?.toUpperCase() || 'Unknown';
}
export function trafficLabel(item) {
  return `${trafficName(item.track)} · ${item.point.relativeAltitudeFt>=0?'+':''}${(item.point.relativeAltitudeFt/1000).toFixed(1)}k ft`;
}
export function layoutTrafficLabels(items, enabled, selectedId) {
  const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const occupied = [{
    left: 195,
    right: 445,
    top: 211,
    bottom: 240
  }, ...items.map(({
    point: p
  }) => ({
    left: p.x - 11,
    right: p.x + 11,
    top: p.y - 11,
    bottom: p.y + 11
  }))];
  const placements = new Map();
  for (const item of [...items].sort((a, b) => Number(b.track.id === selectedId) - Number(a.track.id === selectedId))) {
    if ((!enabled && item.track.id !== selectedId) || placements.size >= 6) continue;
    const {
      x,
      y
    } = item.point, width = trafficLabel(item).length * 6.4 + 4;
    for (const [left, top] of [
        [x + 13, y - 21],
        [x - width - 13, y - 21],
        [x + 13, y + 12],
        [x - width - 13, y + 12]
      ]) {
      const box = {
        left,
        top,
        right: left + width,
        bottom: top + 18
      };
      if (left < 128 || box.right > 494 || top < 84 || box.bottom > 360 || occupied.some(b => overlap(box, b)))
    continue;
      placements.set(item.track.id, box);
      occupied.push(box);
      break;
    }
  }
  return items.map(item => ({
    ...item,
    labelBox: placements.get(item.track.id)
  }));
}
export function trafficAltitude(t) {
  return Number.isFinite(t.altitudeMslM) ? Math.round(t.altitudeMslM / .3048).toLocaleString('en-US') + ' ft MSL' :
    Number.isFinite(t.altitudeBaroFt) ? Math.round(t.altitudeBaroFt).toLocaleString('en-US') + ' ft baro' : t.ground ?
    'GROUND' : 'Altitude unknown';
}
