// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-28: optional build capabilities must be observed, not inferred from version.
import {common, standard} from 'node-mavlink';
import type {DecodedFrame} from '../../mav/protocol.js';
import type {VehicleSnapshot} from '../../mav/types.js';

export class TerrainCompatibility {
  private generation: string | null = null;
  private capabilities: bigint | null = null;
  private version: number | null = null;
  private parameters = new Map<string, {value: number; at: number}>();
  private observedAt: number | null = null;
  private lastBootMs: number | null = null;
  private reboot = 0;
  select(vehicle: VehicleSnapshot): void {
    const generation = vehicle.connected ? vehicle.identity?.generation ?? null : null;
    if (generation !== this.generation) {
      this.generation = generation; this.clear(); this.lastBootMs = null;
    }
  }
  private clear(): void { this.capabilities = null; this.version = null; this.parameters.clear(); this.observedAt = null; }
  receive(frame: DecodedFrame, vehicle: VehicleSnapshot, now: number): void {
    this.select(vehicle);
    if (!vehicle.connected || frame.system !== vehicle.identity?.system || frame.component !== vehicle.identity.component) return;
    const message = frame.data;
    // Small backward jitter is not a reboot; boot-counter wrap is also expected.
    if (message instanceof common.GlobalPositionInt || message instanceof common.SystemTime) {
      const boot = message.timeBootMs;
      if (this.lastBootMs !== null && boot + 1000 < this.lastBootMs && !(this.lastBootMs > 0xf0000000 && boot < 0x0fffffff)) {
        this.clear(); this.reboot++;
      }
      this.lastBootMs = boot;
    }
    if (message instanceof standard.AutopilotVersion) {
      this.capabilities = BigInt(message.capabilities); this.version = message.flightSwVersion; this.observedAt = now;
    }
    if (message instanceof common.ParamValue) {
      const name = String(message.paramId).replace(/\0.*$/, '');
      if (['TERRAIN_ENABLE', 'TERRAIN_OPTIONS', 'TERRAIN_SPACING'].includes(name) && Number.isFinite(message.paramValue)) {
        this.parameters.set(name, {value: message.paramValue, at: now});
      }
    }
  }
  snapshot(vehicle: VehicleSnapshot) {
    this.select(vehicle);
    const reasons: string[] = [];
    if (!vehicle.connected || !vehicle.identity) reasons.push('fresh-controller-required');
    if (this.capabilities === null) reasons.push('refresh-terrain-capability');
    else if ((this.capabilities & BigInt(standard.MavProtocolCapability.TERRAIN)) === 0n) reasons.push('terrain-capability-not-advertised');
    const enable = this.parameters.get('TERRAIN_ENABLE'), spacing = this.parameters.get('TERRAIN_SPACING'), options = this.parameters.get('TERRAIN_OPTIONS');
    if (!enable || !spacing || !options) reasons.push('refresh-terrain-parameters');
    if (enable && enable.value !== 1) reasons.push('terrain-disabled-on-controller');
    if (spacing && spacing.value !== 30) reasons.push('terrain-spacing-must-be-30');
    if (options && (!Number.isInteger(options.value) || options.value < 0)) reasons.push('invalid-terrain-options');
    return {compatible: reasons.length === 0, reasons, generation: this.generation, reboot: this.reboot,
      flightSoftwareVersion: this.version, terrainCapability: this.capabilities === null ? null : (this.capabilities & 512n) !== 0n,
      observedAt: this.observedAt, parameters: Object.fromEntries(this.parameters),
      diskDisabled: options ? (Math.trunc(options.value) & 2) !== 0 : null};
  }
}
