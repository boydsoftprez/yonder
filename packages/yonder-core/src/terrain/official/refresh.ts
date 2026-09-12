// SPDX-License-Identifier: GPL-3.0-or-later
// R-CMD-04/05, R-FLT-28: this read-only aircraft transaction starts only on an authenticated action.
import {ardupilotmega, common, MavLinkProtocolV2, standard, type MavLinkData} from 'node-mavlink';
import {createHash} from 'node:crypto';
import type {VehicleContext} from '../../mav/types.js';
import type {DecodedFrame} from '../../mav/protocol.js';
import type {Clock} from '../../apply/types.js';

export class TerrainControllerRefresh {
  private protocol = new MavLinkProtocolV2(254, 193);
  private sequence = 0;
  private generation: string | null = null;
  private total: number | null = null;
  private points = new Map<number, {lat: number; lon: number}>();
  private waiting = new Set(['AUTOPILOT_VERSION', 'TERRAIN_ENABLE', 'TERRAIN_OPTIONS', 'TERRAIN_SPACING', 'RALLY_TOTAL']);
  private timer: unknown;
  private state: 'idle' | 'refreshing' | 'complete' | 'failed' = 'idle';
  private reason: string | null = null;
  private chain: Promise<void> = Promise.resolve();
  private epoch = 0;
  private closed = false;
  constructor(private options: {vehicle: () => VehicleContext; send: (bytes: Uint8Array) => Promise<void>; clock: Clock}) {}
  get busy(): boolean { return this.state === 'refreshing'; }
  start(operator: string, generation: string): void {
    if (this.closed) throw new Error('Controller refresh service is closed');
    const vehicle = this.options.vehicle();
    if (!operator) throw new Error('Authenticated operator required');
    if (!vehicle.connected || vehicle.identity?.generation !== generation) throw new Error('Fresh selected controller required');
    if (vehicle.busy) throw new Error('Aircraft command or mission transaction is active');
    if (this.busy) return;
    this.generation = generation; this.total = null; this.points.clear();
    this.waiting = new Set(['AUTOPILOT_VERSION', 'TERRAIN_ENABLE', 'TERRAIN_OPTIONS', 'TERRAIN_SPACING', 'RALLY_TOTAL']);
    this.state = 'refreshing'; this.reason = null; this.epoch++;
    this.timer = this.options.clock.setTimer(10000, () => this.fail('Controller refresh timed out; observations may be partial'));
    const versionRequest = new common.RequestMessageCommand();
    versionRequest.messageId = standard.AutopilotVersion.MSG_ID;
    this.enqueue(versionRequest);
    for (const paramId of ['TERRAIN_ENABLE', 'TERRAIN_OPTIONS', 'TERRAIN_SPACING', 'RALLY_TOTAL']) {
      this.enqueue(Object.assign(new common.ParamRequestRead(), {paramId, paramIndex: -1}));
    }
  }
  private enqueue(message: MavLinkData): void {
    const epoch = this.epoch;
    this.chain = this.chain.then(async () => {
      const vehicle = this.options.vehicle();
      if (!this.busy || epoch !== this.epoch) return;
      if (!vehicle.connected || vehicle.identity?.generation !== this.generation || vehicle.busy) {
        this.fail('Controller changed or another aircraft transaction started'); return;
      }
      const targeted = message as MavLinkData & {targetSystem: number; targetComponent: number};
      targeted.targetSystem = vehicle.identity.system; targeted.targetComponent = vehicle.identity.component;
      await this.options.send(this.protocol.serialize(message, this.sequence++ & 255));
    }).catch(error => this.fail(error instanceof Error ? error.message : 'Controller refresh send failed'));
  }
  receive(frame: DecodedFrame): void {
    const vehicle = this.options.vehicle();
    if (this.generation && (!vehicle.connected || vehicle.identity?.generation !== this.generation)) {
      this.invalidate('Controller changed'); return;
    }
    if (this.state === 'complete' && rallyStateMutation(frame)) {
      this.invalidate('Rally state changed after refresh'); return;
    }
    if (!this.busy || frame.system !== vehicle.identity?.system || frame.component !== vehicle.identity.component) return;
    const data = frame.data;
    if (data instanceof standard.AutopilotVersion) this.waiting.delete('AUTOPILOT_VERSION');
    if (data instanceof common.ParamValue) {
      const id = String(data.paramId).replace(/\0.*$/, '');
      if (id === 'RALLY_TOTAL') {
        if (!Number.isSafeInteger(data.paramValue) || data.paramValue < 0 || data.paramValue > 32) {
          this.fail('Controller returned an invalid rally point count'); return;
        }
        this.waiting.delete(id);
        if (this.total !== null && this.total !== data.paramValue) { this.fail('Rally list changed during refresh'); return; }
        if (this.total === null) {
          this.total = data.paramValue;
          for (let idx = 0; idx < this.total; idx++) this.enqueue(Object.assign(new ardupilotmega.RallyFetchPoint(), {idx}));
        }
      } else if (Number.isFinite(data.paramValue)) {
        this.waiting.delete(id);
      }
    }
    if (data instanceof ardupilotmega.RallyPoint && this.total !== null) {
      const valid = data.count === this.total
        && Number.isSafeInteger(data.idx) && data.idx >= 0 && data.idx < this.total
        && [0, 254].includes(data.targetSystem) && [0, 193].includes(data.targetComponent)
        && Number.isInteger(data.lat) && Number.isInteger(data.lng)
        && Math.abs(data.lat) < 900000000 && Math.abs(data.lng) <= 1800000000;
      if (!valid) { this.fail('Controller returned an invalid rally point'); return; }
      this.points.set(data.idx, {lat: data.lat / 1e7, lon: data.lng / 1e7});
    }
    if (this.waiting.size === 0 && this.total !== null && this.points.size === this.total) {
      this.state = 'complete'; this.options.clock.clearTimer(this.timer);
    }
  }
  private fail(reason: string): void {
    this.state = 'failed'; this.reason = reason; this.epoch++;
    this.total = null; this.points.clear(); this.options.clock.clearTimer(this.timer);
  }
  private invalidate(reason: string): void { this.fail(reason); }
  reset(): void {
    this.epoch++; this.options.clock.clearTimer(this.timer);
    this.generation = null; this.total = null; this.points.clear();
    this.waiting.clear(); this.state = 'idle'; this.reason = null;
  }
  rally() {
    const vehicle = this.options.vehicle();
    if (this.state !== 'complete' || !vehicle.connected || vehicle.identity?.generation !== this.generation || this.total === null) return null;
    const points = [...this.points].sort(([a], [b]) => a - b).map(([, point]) => point);
    return {revision: createHash('sha256').update(JSON.stringify([this.generation, points])).digest('hex'), points};
  }
  snapshot() { return {state: this.state, reason: this.reason, generation: this.generation, rally: this.rally()}; }
  close(): void {
    this.closed = true;
    if (this.busy) this.fail('Service stopped');
    else { this.epoch++; this.options.clock.clearTimer(this.timer); }
  }
}

function rallyStateMutation(frame: DecodedFrame): boolean {
  const data = frame.data;
  if (data instanceof common.ParamValue
    && String(data.paramId).replace(/\0.*$/, '') === 'RALLY_TOTAL') return true;
  if (data instanceof ardupilotmega.RallyPoint) return true;
  const missionType = (data as MavLinkData & {missionType?: number | string}).missionType;
  if (missionType !== 2 && missionType !== 'RALLY') return false;
  return data instanceof common.MissionCount
    || data instanceof common.MissionItem
    || data instanceof common.MissionItemInt
    || data instanceof common.MissionClearAll
    || data instanceof common.MissionWritePartialList
    || data instanceof common.MissionRequest
    || data instanceof common.MissionRequestInt
    || data instanceof common.MissionAck;
}
