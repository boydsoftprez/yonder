// Operator-authored flight requests and observed-state presentation. No transport or timers.
// SPDX-License-Identifier: GPL-3.0-or-later
import {units,unitText} from './flight-units.mjs';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, label, min, max) => {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${label} must be ${min} to ${max}`);
  return Number(value);
};
export const flightModes = snapshot => (snapshot?.capabilities?.modes || []).filter(mode => typeof mode.name === 'string' && Number.isInteger(mode.customMode));
// ArduPlane wire item 0 is home; executable sequence bounds match vehicle.ts.
const executableSequence = seq => Number.isInteger(seq) && seq >= 1 && seq <= 1999;
export function missionExecutionState(snapshot) {
  const mission = snapshot?.mission;
  const blocked = reason => ({kind: null, reason});
  if (mission?.currentFresh !== true || !Number.isInteger(mission.currentSeq)) return blocked('Fresh current mission item required; read the aircraft mission and wait for current-item telemetry');
  if (mission.synchronization !== 'verified') return blocked('Read and verify the current aircraft mission first');
  if (!flightModes(snapshot).some(mode => mode.name === 'AUTO' && mode.customMode === 10)) return blocked('Mission execution requires the supported aircraft AUTO mode');
  if (mission.currentSeq === 0) {
    if (!mission.items?.some(item => executableSequence(item.seq))) return blocked('The verified mission has no authored items to start');
    return {kind: 'mission-start', reason: null};
  }
  if (!executableSequence(mission.currentSeq) || !mission.items?.some(item => item.seq === mission.currentSeq)) return blocked('Current mission sequence must name a verified authored item from 1 to 1999');
  return {kind: 'resume', reason: null};
}
export function flightAvailability(kind, snapshot, available = true) {
  if (!available || !snapshot?.connected || !snapshot?.identity?.generation) return 'Aircraft command transport unavailable';
  if (snapshot.busy) return 'Aircraft command in progress';
  if (kind === 'resume' || kind === 'mission-start') {
    const execution = missionExecutionState(snapshot);
    if (execution.reason) return execution.reason;
    if (execution.kind !== kind) return kind === 'resume' ? 'Home (0) is not an executable mission item; review an explicit mission start' : 'The current mission item changed; review continuation from the current authored item';
  }
  if (['heading', 'altitude', 'speed', 'loiter'].includes(kind)) {
    const capability = snapshot.capabilities?.flightControl?.find(item => item.kind === kind);
    if (!capability?.available) return capability?.reason || `${kind} command unavailable on this firmware`;
  }
  return null;
}
function modeNamed(name, snapshot) {
  const mode = flightModes(snapshot).find(item => item.name === name);
  if (!mode) throw new Error(`${name} mode unavailable`);
  return mode;
}
export function flightRequest(kind, form, snapshot) {
  const unavailable = flightAvailability(kind, snapshot);
  if (unavailable) throw new Error(unavailable);
  let action, label;
  if (kind === 'heading') {
    action = {kind, headingDeg: number(form.headingDeg, 'True heading', 0, 359.999), reference: 'true', turnAccelerationMps2: number(form.turnAccelerationMps2, 'Turn acceleration', .05, 20)};
    label = `GUIDED · heading ${action.headingDeg}° true · ${action.turnAccelerationMps2} m/s² turn acceleration`;
  } else if (kind === 'altitude') {
    const altitudeM = number(form.altitudeM, 'Altitude in metres', -1000, 30000);
    if ([-1, 0].includes(altitudeM)) throw new Error('This firmware reserves altitude -1 and 0; choose another altitude');
    if (!['msl', 'home'].includes(form.datum)) throw new Error('Choose MSL or above-home altitude');
    action = {kind, altitudeM, datum: form.datum, verticalRateMps: number(form.verticalRateMps, 'Vertical rate', 0, 100)};
    label = `GUIDED · altitude ${altitudeM} m ${form.datum === 'msl' ? 'MSL' : 'above home'} · ${action.verticalRateMps || 'maximum'} m/s rate`;
  } else if (kind === 'speed') {
    action = {kind, airspeedMps: number(form.airspeedMps, 'Airspeed in m/s', .01, 300), accelerationMps2: number(form.accelerationMps2, 'Acceleration', 0, 20)};
    label = `GUIDED · airspeed ${action.airspeedMps} m/s · ${action.accelerationMps2 || 'maximum'} m/s² acceleration`;
  } else if (kind === 'direct' || kind === 'loiter') {
    if (!['msl', 'home'].includes(form.datum)) throw new Error('Choose MSL or above-home altitude');
    const target = {lat: number(form.lat, 'Latitude', -90, 90), lon: number(form.lon, 'Longitude', -180, 180), altitudeM: number(form.altitudeM, 'Altitude in metres', -1000, 30000), datum: form.datum};
    action = {kind: kind === 'direct' ? 'goto' : 'loiter', target};
    if (kind === 'loiter') {
      const radiusM = number(form.radiusM, 'Radius in metres', 1, 65535);
      if (!Number.isInteger(radiusM)) throw new Error('Radius must be a whole number of metres');
      if (!['cw', 'ccw'].includes(form.direction)) throw new Error('Choose clockwise or counterclockwise');
      Object.assign(action, {radiusM, direction: form.direction});
    }
    label = `GUIDED · ${kind === 'loiter' ? `loiter ${action.radiusM} m ${action.direction === 'cw' ? 'clockwise' : 'counterclockwise'}` : 'Direct-To'} · ${target.lat.toFixed(6)}°, ${target.lon.toFixed(6)}° · ${target.altitudeM} m ${target.datum === 'msl' ? 'MSL' : 'above home'}`;
  } else if (kind === 'mode' || kind === 'rtl') {
    const mode = modeNamed(kind === 'rtl' ? 'RTL' : form.mode, snapshot);
    action = {kind: 'mode', customMode: mode.customMode}; label = `Select ${mode.name}`;
  } else if (kind === 'resume') {
    const mission = snapshot.mission;
    action = {kind: 'continue-auto', seq: mission.currentSeq, autoMode: modeNamed('AUTO', snapshot).customMode};
    label = `Resume mission · AUTO from item ${mission.currentSeq}`;
  } else if (kind === 'mission-start') {
    action = {kind: 'mission-start'};
    label = 'Start verified aircraft mission · current item Home (0) · does not arm aircraft';
  } else if (kind === 'arm') {
    if (typeof form.armed !== 'boolean') throw new Error('Choose arm or disarm');
    action = {kind, armed: form.armed}; label = form.armed ? 'Arm aircraft' : 'Disarm aircraft';
  } else throw new Error('Flight action unavailable');
  return {action, label};
}
export function flightAnnunciation(snapshot = {},options) {
  const telemetry = snapshot.telemetry || {}, operation = snapshot.operations?.filter(item => !item.vehicleGeneration || item.vehicleGeneration === snapshot.identity?.generation).at(-1);
  const fresh = snapshot.connected === true && telemetry.fields?.mode?.valid !== false && !!telemetry.mode;
  let request = '', outcome = '', tone = 'neutral';
  if (operation) {
    const action = operation.action || {};
    const name = action.kind === 'mode' ? flightModes(snapshot).find(mode => mode.customMode === action.customMode)?.name || `mode ${action.customMode}` : action.kind;
    request = `Requested ${name || 'action'}`;
    if (action.kind === 'heading') request += ` ${action.headingDeg}° true`;
    if (action.kind === 'altitude') request += options?` ${unitText(action.altitudeM,units(options).altitudeUnit)} ${action.datum}`:` ${action.altitudeM} m ${action.datum}`;
    if (action.kind === 'speed') request += options?` ${unitText(action.airspeedMps,units(options).speedUnit,1)}`:` ${action.airspeedMps} m/s`;
    if (action.kind === 'loiter') request += ` ${action.radiusM} m ${action.direction}`;
    outcome = operation.state === 'observed' ? 'Observed in telemetry' : operation.ack ? `ACK ${operation.ack.result === 0 ? 'accepted' : `result ${operation.ack.result}`} · ${operation.effect?.state === 'observed' ? 'effect observed' : 'effect not confirmed'}` : operation.state || 'pending';
    if (['rejected', 'failed', 'unknown'].includes(operation.state) && operation.ack) outcome = `${operation.state} · ${outcome}`;
    tone = ['rejected', 'failed', 'unknown'].includes(operation.state) ? 'caution' : operation.state === 'observed' ? 'observed' : 'neutral';
  }
  return {mode: fresh ? telemetry.mode : 'MODE UNAVAILABLE', armed: fresh && typeof telemetry.armed === 'boolean' ? (telemetry.armed ? 'ARMED' : 'DISARMED') : 'ARM STATE UNAVAILABLE', fresh, request, outcome, tone};
}
/** A wide scene grows in world space. All authored circles, tapes and hit regions keep one scale. */
export function pfdViewport(pixelWidth, pixelHeight) {
  const ratio = finite(pixelWidth) && finite(pixelHeight) && pixelWidth > 0 && pixelHeight > 0 ? pixelWidth / pixelHeight : 640 / 650;
  const width = Math.max(640, 650 * ratio), height = width / ratio, x = (640 - width) / 2, y = (650 - height) / 2;
  return {width, height, x, y, edgeShift: (width - 640) / 2, centerX: .5, centerY: (225 - y) / height, pixelsPerDegree: 5 / height, viewBox: `${x} ${y} ${width} ${height}`};
}
export function pfdHitRegion(viewport, [x, y, width, height]) {
  return {left: `${(x - viewport.x) / viewport.width * 100}%`, top: `${(y - viewport.y) / viewport.height * 100}%`, width: `${width / viewport.width * 100}%`, height: `${height / viewport.height * 100}%`};
}
