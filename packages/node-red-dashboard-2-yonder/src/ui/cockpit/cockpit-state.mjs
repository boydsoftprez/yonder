// SPDX-License-Identifier: GPL-3.0-or-later
// Pure display adapters. No transport and no vehicle-changing side effects.
import {
  pfdState
} from './pfd-state.mjs';
import {guidedNavigationUnavailable, guidedSource} from './guided-navigation.mjs';
const RAD = Math.PI / 180,
  EARTH = 6371000;
export const finite = Number.isFinite;
export const angle = value => ((value % 360) + 360) % 360;
export const fmt = (value, digits = 0) => finite(value) ? value.toLocaleString('en-US', {
  maximumFractionDigits: digits
}) : '—';
export const validPosition = p => finite(p?.lat) && finite(p?.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
// R-FLT-11: receiving fused coordinates does not establish a GPS fix. In
// particular, an uninitialised controller can keep publishing fresh 0,0.
// Callers pass aged telemetry so expired coordinates/fix metadata are excluded.
export function aircraftMapPosition(t = {}) {
  const point = {lat: t.latitude, lon: t.longitude};
  return t.ready === true && finite(t.fixType) && t.fixType >= 2 && validPosition(point) ? point : null;
}
export function aircraftPositionMessage(t = {}) {
  if (aircraftMapPosition(t)) return '';
  if (!t.ready) return 'Aircraft position unavailable · waiting for fresh telemetry';
  if (finite(t.fixType) && t.fixType < 2)
    return `No GPS fix${finite(t.satellites) ? ` · ${t.satellites} satellites` : ''}`;
  return 'Aircraft position unavailable · waiting for fresh GPS fix and coordinates';
}
export function agedTelemetry(source = {}, elapsed = 0) {
  // A packet can arrive between UI clock ticks. Negative elapsed time must not
  // turn a fresh zero-age sample into invalid negative-age data for one frame.
  elapsed=Number.isFinite(elapsed)?Math.max(0,elapsed):Infinity;
  const telemetry = {
    ...source,
    ready: source.ready === true && elapsed < 2000
  };
  const slow = new Set(['gpsAltitudeM', 'fixType', 'satellites', 'batteryV', 'currentA', 'batteryPercent']);
  for (const [key, metadata] of Object.entries(source.fields || {})) {
    const ttl = slow.has(key) ? 5000 : ['mode', 'customMode', 'armed'].includes(key) ? 3000 : 2000;
    if (metadata.valid === false || (finite(metadata.ageMs) && metadata.ageMs + elapsed >= ttl)) telemetry[key] = null;
  }
  for (const key of ['navController', 'positionTarget', 'turnRate', 'slipSkid'])
    if (source[key]) telemetry[key] = source[key].ageMs + elapsed < 2000 ? {
      ...source[key],
      ageMs: source[key].ageMs + elapsed
    } : null;
  if(source.wind) telemetry.wind={...source.wind,ageMs:source.wind.ageMs+elapsed};
  if(source.estimatedTrueAirspeed) telemetry.estimatedTrueAirspeed={...source.estimatedTrueAirspeed,
    velocityAgeMs:source.estimatedTrueAirspeed.velocityAgeMs+elapsed,windAgeMs:source.estimatedTrueAirspeed.windAgeMs+elapsed};
  telemetry.fdReady=source.fdReady===true&&typeof telemetry.mode==='string'&&finite(telemetry.customMode)&&finite(telemetry.navRollDeg)&&finite(telemetry.navPitchDeg);
  return telemetry;
}
export function flightView(snapshot = {}, elapsed = 0) {
  return pfdState(agedTelemetry(snapshot.telemetry || {}, elapsed));
}
export function destination(p, heading, metres) {
  const lat = p.lat * RAD,
    lon = p.lon * RAD,
    b = heading * RAD,
    d = metres / EARTH;
  const y = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(b));
  const x = lon + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(y));
  return {
    lat: y / RAD,
    lon: ((x / RAD + 540) % 360) - 180
  };
}
export function distance(a, b) {
  if (!validPosition(a) || !validPosition(b)) return null;
  const dlat = (b.lat - a.lat) * RAD,
    dlon = (b.lon - a.lon) * RAD;
  const q = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dlon / 2) ** 2;
  return EARTH * 2 * Math.atan2(Math.sqrt(q), Math.sqrt(Math.max(0, 1 - q)));
}
export function bearing(a, b) {
  if (!validPosition(a) || !validPosition(b)) return null;
  const dlon = (b.lon - a.lon) * RAD;
  return angle(Math.atan2(Math.sin(dlon) * Math.cos(b.lat * RAD), Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math
    .sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dlon)) / RAD);
}
export function prediction(t = {}, {
  seconds = 30,
  distanceM = null
} = {}) {
  const speed = t.groundspeedKt * 1852 / 3600,
    point = {
      lat: t.latitude,
      lon: t.longitude
    };
  const span = finite(distanceM) && speed > 0 ? Math.min(120, distanceM / speed) : Math.max(1, Math.min(120, seconds));
  const label = finite(distanceM) ? `${fmt(distanceM)} m measured-motion estimate` :
    `${fmt(span)} s measured-motion estimate`;
  if (!aircraftMapPosition(t) || !finite(t.groundspeedKt) || speed < 0 || !finite(t.trackDeg ?? t.headingDeg))
    return {
      points: [],
      label,
      distanceM: null
    };
  const points = [point],
    step = span / 20,
    turn = finite(t.yawRateDegS) ? Math.max(-30, Math.min(30, t.yawRateDegS)) : 0;
  for (let i = 1; i <= 20; i++) points.push(destination(points.at(-1), (t.trackDeg ?? t.headingDeg) + turn * step * (i -
    .5), speed * step));
  return {
    points,
    label,
    distanceM: speed * span,
    seconds: span,
    curved: turn !== 0
  };
}
export function targetAction({
  lat,
  lon,
  altitude,
  altitudeM = altitude,
  datum
}) {
  if (!['msl', 'home', 'terrain'].includes(datum)) throw new Error('Choose an explicit altitude datum');
  if (!validPosition({
      lat,
      lon
    }) || !finite(altitudeM) || altitudeM < -1000 || altitudeM > 30000) throw new Error(
    'Use a valid location and altitude in metres');
  return {
    kind: 'goto',
    target: {
      lat,
      lon,
      altitudeM,
      datum
    }
  };
}
export function cameraOverlayGate(camera = {}) {
  if (camera.calibration?.valid !== true) return {
    ready: false,
    reason: 'Camera registration unavailable: lens and mounting calibration required'
  };
  if (!camera.framePose || camera.framePose.valid !== true || !finite(camera.framePose.capturedAt)) return {
    ready: false,
    reason: 'Camera registration unavailable: capture-time pose required'
  };
  if (camera.framePose.heightReference !== 'msl') return {
    ready: false,
    reason: 'Camera registration unavailable: known height reference required'
  };
  return {
    ready: true,
    reason: ''
  };
}
export function aircraftMission(snapshot = {}) {
  const wire = snapshot.mission?.items || [],
    isPlaneHome = snapshot.identity?.autopilot === 3;
  const homeItem = isPlaneHome && wire[0]?.seq === 0 && wire[0]?.command === 16 ? wire[0] : null;
  return {
    name: 'Aircraft mission',
    source: 'Vehicle readback',
    home: homeItem ? {
      lat: homeItem.x,
      lon: homeItem.y,
      alt: homeItem.z
    } : snapshot.telemetry?.homePosition || null,
    homeRecord: homeItem,
    warnings: [],
    items: wire.filter(item => item !== homeItem).map(({
      x,
      y,
      z,
      ...item
    }) => ({
      ...item,
      lat: x,
      lon: y,
      alt: z
    }))
  };
}
export function missionWire(draft, snapshot) {
  const readiness=missionUploadReadiness(snapshot);
  if (!readiness.ready) throw new Error(readiness.reason);
  let home = aircraftMission(snapshot).homeRecord;
  const actualHome=snapshot.telemetry?.homePosition;
  if(!home&&snapshot.identity?.autopilot===3&&snapshot.mission?.synchronization==='verified'&&snapshot.mission.items.length===0&&validPosition(actualHome)&&finite(actualHome.alt)){home={seq:0,command:16,frame:0,params:[0,0,0,0],x:actualHome.lat,y:actualHome.lon,z:actualHome.alt,current:true,autocontinue:true};}
  const entries = draft.items.map(({
    lat,
    lon,
    alt,
    ...item
  }) => ({
    ...item,
    x: lat,
    y: lon,
    z: alt
  }));
  if (entries.length + (home ? 1 : 0) > 2000) throw new Error('Mission is limited to 2000 wire items including home');
  if (home && entries.some(item => item.seq === 0)) throw new Error('Draft sequence zero conflicts with aircraft home');
  // editMission preserves/remaps jumps and numbers authored items from 1. A
  // received mission keeps its exact wire numbering until explicitly edited.
  return home ? [{
    ...home
  }, ...entries] : entries;
}
export function missionUploadReadiness(snapshot = {}) {
  if (snapshot.identity?.autopilot !== 3 || aircraftMission(snapshot).homeRecord) return {ready:true,reason:''};
  if (snapshot.mission?.synchronization !== 'verified')
    return {ready:false,needsRead:true,reason:'Read the aircraft mission first to verify its home record. Your local draft will be kept.'};
  const home=snapshot.telemetry?.homePosition;
  if (snapshot.mission.items.length===0 && validPosition(home) && finite(home.alt)) return {ready:true,reason:''};
  return {ready:false,needsRead:false,reason:'Aircraft mission read completed, but the controller has not provided a home record. With no GPS connected, a home position may be unavailable. Let the controller establish home, then request flight telemetry and read the mission again. Your local draft is kept.'};
}
export function guidanceView(snapshot, elapsed = 0) {
  const t = snapshot.telemetry || {},
    n = t.navController,
    live = t.ready && elapsed < 2000;
  if (!live) return {
    valid: false,
    reason: 'Flight telemetry unavailable'
  };
  const unavailable = guidedNavigationUnavailable(snapshot);
  if (unavailable) return {valid:false, reason:unavailable, desiredBank:t.navRollDeg};
  if (!n || n.ageMs + elapsed >= 2000) return {
    valid: false,
    reason: 'Navigation controller unavailable'
  };
  const target = t.positionTarget;
  if (t.mode === 'GUIDED' && target && target.ageMs + elapsed < 2000) {
    const center = {
        lat: target.lat,
        lon: target.lon
      },
      here = {
        lat: t.latitude,
        lon: t.longitude
      };
    return {
      valid: true,
      kind: 'radial',
      bearing: bearing(here, center),
      distanceM: distance(here, center),
      crossTrackM: n.crossTrackM,
      label: 'GUIDED radial',
      guidanceSource: guidedSource,
      target,
      ete: null,
      desiredBank: t.navRollDeg
    };
  }
  if (t.mode !== 'AUTO' || !snapshot.mission?.currentFresh || n.missionSeq !== snapshot.mission.currentSeq) return {
    valid: false,
    reason: 'No current AUTO leg'
  };
  return {
    valid: true,
    kind: 'lateral',
    bearing: n.navBearingDeg,
    distanceM: n.waypointDistanceM,
    crossTrackM: n.crossTrackM,
    label: `AUTO · item ${n.missionSeq}`,
    ete: t.groundspeedKt > 1 ? n.waypointDistanceM / (t.groundspeedKt * 1852 / 3600) : null,
    desiredBank: t.navRollDeg
  };
}
export { createCockpitApi } from './cockpit-api.mjs';
