// SPDX-License-Identifier: GPL-3.0-or-later
import {ardupilotmega, common, standard, type MavLinkData} from 'node-mavlink';
import {describe, expect, it} from 'vitest';
import type {Clock} from '../../apply/types.js';
import {decodeDatagram, type DecodedFrame} from '../../mav/protocol.js';
import type {VehicleSnapshot} from '../../mav/types.js';
import {TerrainControllerRefresh} from './refresh.js';

class FakeClock implements Clock {
  time = 1_000;
  private next = 0;
  private timers = new Map<number, {at: number; fn: () => void}>();
  now = () => this.time;
  setTimer = (ms: number, fn: () => void) => {
    const id = ++this.next;
    this.timers.set(id, {at: this.time + ms, fn});
    return id;
  };
  clearTimer = (handle: unknown) => { this.timers.delete(handle as number); };
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter(([, timer]) => timer.at <= end)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
    }
    this.time = end;
  }
}

const flush = async () => { for (let count = 0; count < 40; count += 1) await Promise.resolve(); };

function messageFrame(data: MavLinkData, system = 1, component = 1): DecodedFrame {
  const messageType = data.constructor as typeof MavLinkData;
  return {system, component, id: messageType.MSG_ID, data};
}

function rig(send?: (bytes: Uint8Array) => Promise<void>) {
  const clock = new FakeClock();
  const sent: Uint8Array[] = [];
  const vehicle = {
    connected: true,
    busy: false,
    identity: {system: 1, component: 1, generation: 'vehicle-one'},
  } as VehicleSnapshot;
  const refresh = new TerrainControllerRefresh({
    vehicle: () => vehicle,
    clock,
    send: send ?? (async bytes => { sent.push(bytes); }),
  });
  const feed = (message: MavLinkData, system = 1, component = 1) => {
    refresh.receive(messageFrame(message, system, component));
  };
  return {clock, feed, refresh, sent, vehicle};
}

function parameter(id: string, value: number): common.ParamValue {
  return Object.assign(new common.ParamValue(), {paramId: id, paramValue: value});
}

function answerNonRally(r: ReturnType<typeof rig>) {
  r.feed(new standard.AutopilotVersion());
  r.feed(parameter('TERRAIN_ENABLE', 1));
  r.feed(parameter('TERRAIN_OPTIONS', 2));
  r.feed(parameter('TERRAIN_SPACING', 30));
}

async function completeWithOnePoint(r: ReturnType<typeof rig>) {
  r.refresh.start('operator-session', 'vehicle-one');
  await flush();
  answerNonRally(r);
  r.feed(parameter('RALLY_TOTAL', 1));
  await flush();
  r.feed(Object.assign(new ardupilotmega.RallyPoint(), {
    targetSystem: 254, targetComponent: 193, idx: 0, count: 1,
    lat: 35_7000_000, lng: -83_3600_000,
  }));
  expect(r.refresh.snapshot().state).toBe('complete');
}

describe('TerrainControllerRefresh', () => {
  it('has no constructor or snapshot output and sends only after an explicit authenticated start', async () => {
    const r = rig();
    expect(r.sent).toEqual([]);
    expect(r.refresh.snapshot()).toMatchObject({state: 'idle', rally: null});
    expect(r.sent).toEqual([]);
    expect(() => r.refresh.start('', 'vehicle-one')).toThrow(/operator/i);
    expect(r.sent).toEqual([]);

    r.refresh.start('operator-session', 'vehicle-one');
    await flush();
    expect(r.sent).toHaveLength(5);
  });

  it('encodes one AUTOPILOT_VERSION command and four targeted read-only parameter requests', async () => {
    const r = rig();
    r.refresh.start('operator-session', 'vehicle-one');
    await flush();
    const frames = r.sent.flatMap(bytes => decodeDatagram(bytes));

    expect(frames.map(frame => [frame.system, frame.component]))
      .toEqual(Array.from({length: 5}, () => [254, 193]));
    const command = frames[0]!.data as common.CommandLong;
    expect(command).toBeInstanceOf(common.CommandLong);
    expect(command).toMatchObject({targetSystem: 1, targetComponent: 1, command: 512, confirmation: 0});
    expect((command as unknown as {_param1: number})._param1).toBe(standard.AutopilotVersion.MSG_ID);
    expect(frames.slice(1).map(frame => frame.data)).toEqual([
      expect.objectContaining({targetSystem: 1, targetComponent: 1, paramId: 'TERRAIN_ENABLE', paramIndex: -1}),
      expect.objectContaining({targetSystem: 1, targetComponent: 1, paramId: 'TERRAIN_OPTIONS', paramIndex: -1}),
      expect.objectContaining({targetSystem: 1, targetComponent: 1, paramId: 'TERRAIN_SPACING', paramIndex: -1}),
      expect.objectContaining({targetSystem: 1, targetComponent: 1, paramId: 'RALLY_TOTAL', paramIndex: -1}),
    ]);
    expect(frames.every(frame => frame.data instanceof common.CommandLong
      || frame.data instanceof common.ParamRequestRead)).toBe(true);
  });

  it('keeps rally unknown until a matching current reply establishes a known empty list', async () => {
    const r = rig();
    r.refresh.start('operator-session', 'vehicle-one');
    await flush();
    answerNonRally(r);
    r.feed(parameter('RALLY_TOTAL', 0), 2, 1);
    expect(r.refresh.snapshot()).toMatchObject({state: 'refreshing', rally: null});

    r.feed(parameter('RALLY_TOTAL', 0));
    expect(r.refresh.snapshot()).toMatchObject({state: 'complete', rally: {points: []}});
  });

  it('fetches at most 32 legacy rally points and returns them only after the full matching list', async () => {
    const r = rig();
    r.refresh.start('operator-session', 'vehicle-one');
    await flush();
    answerNonRally(r);
    r.feed(parameter('RALLY_TOTAL', 2));
    await flush();
    const fetches = r.sent.flatMap(bytes => decodeDatagram(bytes))
      .map(frame => frame.data).filter(data => data instanceof ardupilotmega.RallyFetchPoint);
    expect(fetches).toEqual([
      expect.objectContaining({targetSystem: 1, targetComponent: 1, idx: 0}),
      expect.objectContaining({targetSystem: 1, targetComponent: 1, idx: 1}),
    ]);

    r.feed(Object.assign(new ardupilotmega.RallyPoint(), {
      targetSystem: 254, targetComponent: 193, idx: 1, count: 2,
      lat: 35_7100_000, lng: -83_3500_000,
    }));
    expect(r.refresh.rally()).toBeNull();
    r.feed(Object.assign(new ardupilotmega.RallyPoint(), {
      targetSystem: 254, targetComponent: 193, idx: 0, count: 2,
      lat: 35_7000_000, lng: -83_3600_000,
    }));
    expect(r.refresh.rally()?.points).toEqual([
      {lat: 35.7, lon: -83.36},
      {lat: 35.71, lon: -83.35},
    ]);
  });

  it.each([1.5, 33, -1])('fails a malformed RALLY_TOTAL count of %s without fetching points', async value => {
    const r = rig();
    r.refresh.start('operator-session', 'vehicle-one');
    await flush();
    r.feed(parameter('RALLY_TOTAL', value));
    await flush();
    expect(r.refresh.snapshot()).toMatchObject({state: 'failed', rally: null});
    expect(r.sent.flatMap(bytes => decodeDatagram(bytes)).some(
      frame => frame.data instanceof ardupilotmega.RallyFetchPoint,
    )).toBe(false);
  });

  it('fails when a rally point disagrees with the current list metadata', async () => {
    const r = rig();
    r.refresh.start('operator-session', 'vehicle-one');
    await flush();
    answerNonRally(r);
    r.feed(parameter('RALLY_TOTAL', 2));
    await flush();

    r.feed(Object.assign(new ardupilotmega.RallyPoint(), {
      targetSystem: 254, targetComponent: 193, idx: 0, count: 3,
      lat: 35_7000_000, lng: -83_3600_000,
    }));

    expect(r.refresh.snapshot()).toMatchObject({state: 'failed', rally: null});
  });

  it('times out at 10 seconds and ignores late matching replies', async () => {
    const r = rig();
    r.refresh.start('operator-session', 'vehicle-one');
    await flush();
    r.clock.advance(9_999);
    expect(r.refresh.busy).toBe(true);
    r.clock.advance(1);
    expect(r.refresh.snapshot()).toMatchObject({state: 'failed', rally: null});

    answerNonRally(r);
    r.feed(parameter('RALLY_TOTAL', 0));
    expect(r.refresh.snapshot()).toMatchObject({state: 'failed', rally: null});
  });

  it.each(['busy', 'generation'] as const)('rechecks vehicle %s between every queued send', async change => {
    let releaseFirst = () => {};
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve; });
    const sent: Uint8Array[] = [];
    const r = rig(async bytes => {
      sent.push(bytes);
      if (sent.length === 1) await firstPending;
    });
    r.refresh.start('operator-session', 'vehicle-one');
    await flush();
    if (change === 'busy') r.vehicle.busy = true;
    else r.vehicle.identity = {...r.vehicle.identity!, generation: 'vehicle-two'};
    releaseFirst();
    await flush();

    expect(sent).toHaveLength(1);
    expect(r.refresh.snapshot()).toMatchObject({state: 'failed', rally: null});
  });

  it('invalidates a completed rally after any observed legacy or mission-type rally update', async () => {
    const changes: Array<{message: MavLinkData; system: number}> = [
      {message: parameter('RALLY_TOTAL', 1), system: 1},
      {message: Object.assign(new ardupilotmega.RallyPoint(), {idx: 0, count: 1}), system: 42},
      {message: Object.assign(new common.MissionItemInt(), {missionType: 2}), system: 42},
      {message: Object.assign(new common.MissionWritePartialList(), {missionType: 2}), system: 42},
    ];
    for (const change of changes) {
      const r = rig();
      await completeWithOnePoint(r);
      expect(r.refresh.rally()).not.toBeNull();
      r.feed(change.message, change.system, 1);
      expect(r.refresh.snapshot()).toMatchObject({state: 'failed', rally: null});
    }
  });

  it('reset invalidates completed and in-flight rally state for a controller reboot', async () => {
    const completed = rig();
    await completeWithOnePoint(completed);
    completed.refresh.reset();
    expect(completed.refresh.snapshot()).toMatchObject({state: 'idle', generation: null, rally: null});

    const active = rig();
    active.refresh.start('operator-session', 'vehicle-one');
    active.refresh.reset();
    await flush();
    expect(active.sent).toEqual([]);
    expect(active.refresh.snapshot()).toMatchObject({state: 'idle', generation: null, rally: null});
  });
});
