// SPDX-License-Identifier: GPL-3.0-or-later
// ArduPlane 4.7.1 keeps POSITION_TARGET_GLOBAL_INT and the loiter controller
// running while GUIDED_CHANGE_HEADING supplies nav_roll. DO_REPOSITION clears
// that override; an ACK for selecting the already-active GUIDED mode does not.
// See ArduPlane/{GCS_MAVLink_Plane,mode_guided,system}.cpp at firmware commit
// dbe792162d06cab66c3475fd5556bf7a120f119e. This is request history, not capture telemetry.
export const guidedSource = 'Reported GUIDED target · external overrides unreported';

/** A reason to withhold geographic cues, or null when the reported target matches a known request. */
export function guidedNavigationUnavailable(snapshot) {
  if (snapshot.telemetry?.mode !== 'GUIDED') return null;
  if (snapshot._detailsReady === false) return 'GUIDED operation details pending · geographic navigation unavailable';
  const generation = snapshot.identity?.generation;
  const operations = snapshot.operations || [];
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index], action = operation.action || {};
    if (!generation || operation.vehicleGeneration !== generation) continue;
    // An observed departure from GUIDED invalidates earlier ownership. Current
    // AUTO navigation is selected by the caller from actual mode telemetry.
    if ((action.kind === 'mode' && action.customMode !== 15 || action.kind === 'continue-auto') &&
        (operation.state === 'observed' || operation.effect?.state === 'observed')) break;
    if (!['heading', 'goto', 'loiter'].includes(action.kind)) continue;
    const command = action.kind === 'heading' ? 43002 : 192, ack = operation.ack;
    if (ack?.command === command && ack.result !== 0 && ack.result !== 5) continue;
    if (operation.state === 'queued' && operation.sentAt == null) continue;
    if (ack?.command !== command || ack.result !== 0 || !['accepted', 'observed'].includes(operation.state)) {
      return 'GUIDED lateral request pending or unconfirmed · geographic navigation unavailable';
    }
    if (action.kind === 'heading') {
      return 'GUIDED heading request accepted · geographic navigation unavailable; active heading ownership and capture are not reported';
    }
    const target = snapshot.telemetry.positionTarget, requested = action.target;
    // Compare lateral coordinates only: the independent altitude slew may keep
    // the old waypoint altitude in this message without changing the lateral path.
    // The callers enforce telemetry freshness. Repositioning to the same center
    // still clears heading control, so the coordinates need not change after ACK.
    const current = target && requested && Math.abs(target.lat - requested.lat) <= 2e-7 &&
      Math.abs(target.lon - requested.lon) <= 2e-7;
    return current ? null : 'GUIDED geographic target awaiting matching telemetry';
  }
  return 'GUIDED lateral ownership unavailable · external heading overrides are not reported';
}
