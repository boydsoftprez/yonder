// SPDX-License-Identifier: GPL-3.0-or-later
import {describe, expect, it} from 'vitest';
import {common, standard} from 'node-mavlink';
import {TerrainCompatibility} from './compatibility.js';
import type {VehicleSnapshot} from '../../mav/types.js';
const vehicle = {connected: true, identity: {system: 1, component: 1, generation: 'first'}} as VehicleSnapshot;
function observed(compatibility: TerrainCompatibility, v = vehicle) {
  const send = (data: any) => compatibility.receive({system: 1, component: 1, id: data.constructor.MSG_ID, data}, v, 100);
  send(Object.assign(new standard.AutopilotVersion(), {capabilities: 512n, flightSwVersion: 0x040701ff}));
  for (const [paramId, paramValue] of [['TERRAIN_ENABLE', 1], ['TERRAIN_SPACING', 30], ['TERRAIN_OPTIONS', 2]]) {
    send(Object.assign(new common.ParamValue(), {paramId, paramValue}));
  }
  return send;
}
describe('terrain compatibility observations', () => {
  it('requires advertised capability and all parameters, not just firmware version', () => {
    const compatibility = new TerrainCompatibility();
    expect(compatibility.snapshot(vehicle).compatible).toBe(false);
    const send = observed(compatibility);
    expect(compatibility.snapshot(vehicle)).toMatchObject({compatible: true, diskDisabled: true});
    send(Object.assign(new standard.AutopilotVersion(), {capabilities: 0n, flightSwVersion: 0x040701ff}));
    expect(compatibility.snapshot(vehicle).reasons).toContain('terrain-capability-not-advertised');
  });
  it('invalidates observations on reconnect and observed reboot', () => {
    const compatibility = new TerrainCompatibility(), send = observed(compatibility);
    send(Object.assign(new common.GlobalPositionInt(), {timeBootMs: 100000}));
    send(Object.assign(new common.GlobalPositionInt(), {timeBootMs: 10}));
    expect(compatibility.snapshot(vehicle)).toMatchObject({compatible: false, reboot: 1});
    observed(compatibility);
    expect(compatibility.snapshot({...vehicle, identity: {...vehicle.identity!, generation: 'second'}}).compatible).toBe(false);
  });
  it('does not admit peripheral or foreign capability evidence', () => {
    const compatibility = new TerrainCompatibility();
    compatibility.receive({system: 2, component: 1, id: 148,
      data: Object.assign(new standard.AutopilotVersion(), {capabilities: 512n})}, vehicle, 100);
    expect(compatibility.snapshot(vehicle).terrainCapability).toBeNull();
  });
});
