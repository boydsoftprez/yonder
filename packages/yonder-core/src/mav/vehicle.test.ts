// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { common, minimal, MavLinkProtocolV2, type MavLinkData } from "node-mavlink";
import { VehicleService } from "./vehicle.js";
import { decodeDatagram } from "./protocol.js";
import type { Clock } from "../apply/types.js";
import type { MissionItem, OperatorRequest, VehicleAction } from "./types.js";

class FakeClock implements Clock {
  time = 100; timers = new Map<number, { at: number; fn: () => void }>(); next = 0;
  now = () => this.time;
  setTimer = (ms: number, fn: () => void) => { const id = ++this.next; this.timers.set(id, { at: this.time + ms, fn }); return id; };
  clearTimer = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) { const end = this.time + ms; for (;;) { const next = [...this.timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; this.time = next[1].at; this.timers.delete(next[0]); next[1].fn(); } this.time = end; }
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function rig() {
  const clock = new FakeClock(), sent: ReturnType<typeof decodeDatagram> = [];
  const service = new VehicleService({ clock, send: async bytes => { sent.push(...decodeDatagram(bytes)); } });
  let sequence = 0;
  const feed = (m: MavLinkData, system = 1, component = 1) => service.receive(new MavLinkProtocolV2(system, component).serialize(m, sequence++ % 256));
  const heartbeat = (mode = 0, armed = false, autopilot = 3, type = 1) => feed(Object.assign(new minimal.Heartbeat(), { autopilot, type, customMode: mode, baseMode: 1 | (armed ? 128 : 0) }));
  const request = (action: VehicleAction, extra: Partial<OperatorRequest> = {}) => service.submit({ id: `op-${sent.length}-${clock.now()}`, sessionId: "verified-session", vehicleGeneration: service.snapshot().identity?.generation ?? "absent", confirmed: true, action, ...extra });
  const ack = (command: number, result = 0, targetSystem = 0) => feed(Object.assign(new common.CommandAck(), { command, result, targetSystem }));
  return { clock, sent, service, feed, heartbeat, request, ack };
}
const sample = (): MissionItem[] => [
  { seq: 0, command: 16, frame: 0, params: [0, 0, 0, 0], x: 35, y: -83, z: 300, current: false, autocontinue: true },
  { seq: 1, command: 16, frame: 3, params: [0, 0, 0, null], x: 35.1234567, y: -83.1234567, z: 100, current: false, autocontinue: true },
];
function missionWire(item: MissionItem) { return Object.assign(new common.MissionItemInt(), { seq: item.seq, command: item.command, frame: item.frame, param1: item.params[0] ?? NaN, param2: item.params[1] ?? NaN, param3: item.params[2] ?? NaN, param4: item.params[3] ?? NaN, x: Math.round(item.x! * 1e7), y: Math.round(item.y! * 1e7), z: item.z!, autocontinue: 1 }); }

describe("vehicle telemetry", () => {
  it("starts passive and selects an actual autopilot without assuming system one", () => {
    const r = rig(); expect(r.sent).toHaveLength(0);
    r.feed(Object.assign(new minimal.Heartbeat(), { autopilot: 8, type: 6 }), 255);
    expect(r.service.snapshot().identity).toBeNull();
    r.feed(Object.assign(new minimal.Heartbeat(), { autopilot: 3, type: 2, customMode: 987 }), 42, 1);
    expect(r.service.snapshot().identity).toMatchObject({ system: 42, component: 1, vehicleType: 2 });
    expect(r.service.snapshot().telemetry.mode).toBe("Mode 987");
    expect(r.service.snapshot().capabilities.modes).toEqual([]);
    expect(r.sent).toHaveLength(0); r.service.close();
  });
  it("decodes actual flight fields and expires each field independently", () => {
    const r = rig(); r.heartbeat();
    r.feed(Object.assign(new common.Attitude(), { roll: 0.2, pitch: -0.1, yawspeed: 0.05 }));
    r.feed(Object.assign(new common.VfrHud(), { airspeed: 20, groundspeed: 21, alt: 400, climb: 2, heading: 80 }));
    r.feed(Object.assign(new common.GlobalPositionInt(), { lat: 350000000, lon: -830000000, alt: 410000, relativeAlt: 110000, vx: 2000, vy: 0 }));
    r.feed(Object.assign(new common.GpsRawInt(), { fixType: 3, satellitesVisible: 12, alt: 415000 }));
    const t = r.service.snapshot().telemetry;
    expect(t.ready).toBe(true); expect(t.rollDeg).toBeCloseTo(11.459156);
    expect([t.globalAltitudeM, t.gpsAltitudeM, t.relativeAltitudeM]).toEqual([410, 415, 110]);
    r.clock.advance(2100); r.heartbeat();
    expect(r.service.snapshot().telemetry).toMatchObject({ ready: false, rollDeg: null, mode: "MANUAL" });
    r.service.close();
  });
  it("invalidates controller targets on a mode/current/target context change", () => {
    const r = rig(); r.heartbeat(10);
    r.feed(Object.assign(new common.MissionCurrent(), { seq: 1 }));
    r.feed(Object.assign(new common.NavControllerOutput(), { navRoll: 5, navPitch: 2, navBearing: 30, targetBearing: 31, wpDist: 100, xtrackError: -8 }));
    expect(r.service.snapshot().telemetry.navController?.missionSeq).toBe(1);
    r.heartbeat(15); expect(r.service.snapshot().telemetry.navController).toBeNull(); expect(r.service.snapshot().telemetry.fdReady).toBe(false);
    r.service.close();
  });
});

describe("operator commands", () => {
  it("refuses malformed runtime inputs without throwing or dispatching", () => {
    const r = rig(); r.heartbeat();
    for (const input of [null, false, [], {}, {id:"bad",sessionId:42}, {id:"bad",sessionId:"s",vehicleGeneration:r.service.snapshot().identity!.generation,action:null}, {id:"bad",sessionId:"s",vehicleGeneration:r.service.snapshot().identity!.generation,action:{kind:"mission-upload",items:[null]}}]) {
      expect(() => r.service.submit(input as unknown as OperatorRequest)).not.toThrow();
      expect(r.service.submit(input as unknown as OperatorRequest).accepted).toBe(false);
    }
    expect(r.sent).toHaveLength(0); r.service.close();
  });
  it("requires confirmation/context and is idempotent without repeating actuation", async () => {
    const r = rig(); r.heartbeat();
    expect(r.request({ kind: "arm", armed: true }, { confirmed: false }).accepted).toBe(false);
    expect(r.request({ kind: "arm", armed: true }, { vehicleGeneration: "old" }).accepted).toBe(false);
    expect(r.sent).toHaveLength(0);
    expect(r.request({ kind: "mode", customMode: 10 }, { id: "one" }).accepted).toBe(true); await flush();
    expect(r.sent).toHaveLength(1); expect((r.sent[0].data as common.CommandLong)).toMatchObject({ command: 176, targetSystem: 1, _param2: 10 });
    expect(r.request({ kind: "mode", customMode: 10 }, { id: "one" }).accepted).toBe(true); await flush(); expect(r.sent).toHaveLength(1);
    expect(r.request({ kind: "mode", customMode: 11 }, { id: "one" }).accepted).toBe(false);
    r.service.close();
  });
  it("keeps ACK acceptance separate from freshly observed aircraft state", async () => {
    const r = rig(); r.heartbeat(); r.request({ kind: "mode", customMode: 10 }); await flush();
    r.ack(176, 0, 99); expect(r.service.snapshot().operations[0].state).toBe("sent");
    r.ack(176, 5); expect(r.service.snapshot().operations[0].state).toBe("in-progress");
    r.ack(176); expect(r.service.snapshot().operations[0].state).toBe("accepted");
    r.heartbeat(10); expect(r.service.snapshot().operations[0].state).toBe("observed"); r.service.close();
  });
  it("can observe an effect without inventing a missing ACK", async () => {
    const r = rig(); r.heartbeat(); r.request({ kind: "arm", armed: true }); await flush(); r.heartbeat(0, true);
    expect(r.service.snapshot().operations[0]).toMatchObject({ state: "observed", ack: null }); r.service.close();
  });
  it("times out as unknown and neither retries nor associates a late ACK with a new action", async () => {
    const r = rig(); r.heartbeat(); r.request({ kind: "arm", armed: true }); await flush();
    for (let i = 0; i < 6; i++) { r.clock.advance(1000); r.heartbeat(); }
    expect(r.service.snapshot().operations[0].state).toBe("unknown"); expect(r.sent).toHaveLength(1);
    r.ack(400); expect(r.service.snapshot().operations[0].state).toBe("unknown");
    expect(r.request({ kind: "arm", armed: false }).accepted).toBe(false); r.service.close();
  });
  it("preserves autopilot refusal and aborts on link loss or identity replacement", async () => {
    const r = rig(); r.heartbeat(); r.request({ kind: "mode", customMode: 11 }); await flush(); r.ack(176, 2);
    expect(r.service.snapshot().operations[0].state).toBe("rejected");
    r.request({ kind: "arm", armed: true }); await flush(); r.clock.advance(3100);
    expect(r.service.snapshot().operations[1].state).toBe("unknown"); expect(r.service.snapshot().connected).toBe(false); r.service.close();
  });
  it("encodes a reviewed GUIDED datum without silently changing it", async () => {
    const r = rig(); r.heartbeat();
    expect(r.request({ kind: "goto", target: { lat: 35, lon: -83, altitudeM: 100, datum: "terrain" } }).accepted).toBe(false);
    r.request({ kind: "goto", target: { lat: 35.1234567, lon: -83.1234567, altitudeM: 100, datum: "home" } }); await flush();
    expect(r.sent[0].data).toMatchObject({ command: 192, frame: 3, _param5: 351234567, _param6: -831234567, _param7: 100, _param2: 1 });
    r.ack(192); expect(r.service.snapshot().operations[0].state).toBe("accepted");
    r.heartbeat(15); r.feed(Object.assign(new common.PositionTargetGlobalInt(), { latInt: 351234567, lonInt: -831234567, alt: 100, coordinateFrame: 3 }));
    expect(r.service.snapshot().operations[0].state).toBe("observed"); r.service.close();
  });
  it("recognizes a home-relative target reported as MSL using the actual vehicle home", async () => {
    const r=rig();r.heartbeat();r.feed(Object.assign(new common.HomePosition(),{latitude:350000000,longitude:-830000000,altitude:315740}));
    r.request({kind:"goto",target:{lat:35.01,lon:-83.01,altitudeM:100,datum:"home"}});await flush();r.ack(192);r.heartbeat(15);
    r.feed(Object.assign(new common.PositionTargetGlobalInt(),{latInt:350100000,lonInt:-830100000,alt:415.74,coordinateFrame:0}));
    expect(r.service.snapshot().operations[0].state).toBe("observed");r.service.close();
  });
  it("waits through IN_PROGRESS within the overall deadline", async () => {
    const r = rig(); r.heartbeat(); r.request({kind:"arm",armed:true}); await flush();
    for (let i=0;i<4;i++) {r.clock.advance(1000);r.heartbeat();}
    r.ack(400,5); r.clock.advance(1500); r.heartbeat();
    expect(r.service.snapshot().operations[0].state).toBe("in-progress");
    r.heartbeat(0,true); expect(r.service.snapshot().operations[0].state).toBe("observed"); r.service.close();
  });
  it("only configures message streams after the explicit stream-setup action", async () => {
    const r=rig();r.heartbeat();await flush();expect(r.sent).toEqual([]);
    r.request({kind:"stream-setup"},{confirmed:false});await flush();
    expect(r.sent[0].data).toMatchObject({command:511,_param1:30,_param2:100000});
    r.ack(511);await flush();expect(r.sent[1].data).toMatchObject({command:511,_param1:33});
    r.service.close();await flush();expect(r.sent).toHaveLength(2);
  });
  it("bounds operation history without evicting idempotency guards", async () => {
    const r=rig();r.heartbeat();
    for(let i=0;i<256;i++){ expect(r.request({kind:"mode",customMode:0},{id:`capacity-${i}`}).accepted).toBe(true);await flush();r.heartbeat(); }
    expect(r.request({kind:"mode",customMode:0},{id:"over-capacity"}).accepted).toBe(false);
    expect(r.service.snapshot().operations).toHaveLength(256);r.service.close();
  });
});

describe("mission transactions", () => {
  it("requires fresh observation of each compound step after that step was sent", async () => {
    const r=rig();r.heartbeat();r.request({kind:"mission-download"});await flush();
    r.feed(Object.assign(new common.MissionCount(),{count:2}));await flush();
    for(const item of sample()){r.feed(missionWire(item));await flush();}
    const revision=r.service.snapshot().mission.revision!;
    r.request({kind:"continue-auto",seq:1,autoMode:10},{expectedMissionRevision:revision});await flush();
    r.ack(224);expect(r.sent.at(-1)!.data).toMatchObject({command:224});
    r.feed(Object.assign(new common.MissionCurrent(),{seq:1}));
    r.heartbeat(10); // arriving before the second command was dispatched cannot confirm it.
    expect(r.service.snapshot().operations.at(-1)!.state).not.toBe("observed");
    await flush();expect(r.sent.at(-1)!.data).toMatchObject({command:176,_param2:10});
    r.heartbeat(10);expect(r.service.snapshot().operations.at(-1)!.state).toBe("observed");r.service.close();
  });
  it("publishes a complete download atomically and preserves all wire fields", async () => {
    const r = rig(); r.heartbeat(); r.request({ kind: "mission-download" }, { confirmed: false }); await flush();
    expect(r.sent[0].id).toBe(43);
    r.feed(Object.assign(new common.MissionCount(), { count: 2 })); await flush();
    r.feed(missionWire(sample()[1])); await flush(); expect(r.service.snapshot().mission.items).toEqual([]);
    r.feed(missionWire(sample()[0])); await flush();
    expect(r.service.snapshot().mission).toMatchObject({ synchronization: "verified", items: sample() });
    expect(r.service.snapshot().operations[0].state).toBe("observed"); r.service.close();
  });
  it("requires upload ACK and matching readback before reporting a verified mission", async () => {
    const r = rig(); r.heartbeat(); r.request({ kind: "mission-upload", items: sample() }); await flush();
    expect(r.sent[0].data).toMatchObject({ count: 2 });
    for (const seq of [0, 1]) { r.feed(Object.assign(new common.MissionRequestInt(), { seq })); await flush(); }
    expect(r.sent.filter(x => x.id === 73)[1].data).toMatchObject({ x: 351234567, y: -831234567 });
    r.feed(Object.assign(new common.MissionAck(), { type: 0 })); await flush();
    expect(r.service.snapshot().operations[0].state).toBe("accepted"); expect(r.service.snapshot().mission.synchronization).not.toBe("verified");
    r.feed(Object.assign(new common.MissionCount(), { count: 2 })); await flush();
    const changedHome = sample(); changedHome[0].z = 301;
    for (const item of changedHome) { r.feed(missionWire(item)); await flush(); }
    expect(r.service.snapshot().operations[0].state).toBe("observed"); expect(r.service.snapshot().mission.items[0].z).toBe(301); r.service.close();
  });
  it("reports a readback mismatch without pretending the prior mission survived", async () => {
    const r = rig(); r.heartbeat(); r.request({ kind: "mission-upload", items: sample() }); await flush();
    for (const seq of [0, 1]) { r.feed(Object.assign(new common.MissionRequestInt(), { seq })); await flush(); }
    r.feed(Object.assign(new common.MissionAck(), { type: 0 })); await flush(); r.feed(Object.assign(new common.MissionCount(), { count: 2 })); await flush();
    const actual = sample(); actual[1].z = 222;
    for (const item of actual) { r.feed(missionWire(item)); await flush(); }
    expect(r.service.snapshot().operations[0]).toMatchObject({ state: "accepted", effect: { state: "mismatch" } });
    expect(r.service.snapshot().mission.items[1].z).toBe(222); r.service.close();
  });
  it("rejects conflicting duplicate download items and never publishes a partial replacement", async () => {
    const r=rig();r.heartbeat();r.request({kind:"mission-download"});await flush();r.feed(Object.assign(new common.MissionCount(),{count:2}));await flush();
    r.feed(missionWire(sample()[1]));await flush();const changed=sample()[1];changed.z=101;r.feed(missionWire(changed));await flush();
    expect(r.service.snapshot().mission).toMatchObject({items:[],synchronization:"failed"});expect(r.service.snapshot().operations[0].state).toBe("unknown");r.service.close();
  });
  it("requires mission revision guard and detects external upload acceptance", async () => {
    const r=rig();r.heartbeat();r.request({kind:"mission-download"});await flush();r.feed(Object.assign(new common.MissionCount(),{count:2}));await flush();
    for(const item of sample()){r.feed(missionWire(item));await flush();}
    expect(r.request({kind:"set-current",seq:1},{expectedMissionRevision:"old"}).accepted).toBe(false);
    r.feed(Object.assign(new common.MissionAck(),{type:0,targetSystem:255,targetComponent:190}));
    expect(r.service.snapshot().mission.synchronization).toBe("changed");r.service.close();
  });
  it("summarizes uploaded plans in history rather than duplicating them in every snapshot", async () => {
    const r=rig();r.heartbeat();r.request({kind:"mission-upload",items:sample()});await flush();
    expect(r.service.snapshot().operations[0].action).toMatchObject({kind:"mission-upload",itemCount:2});
    expect(r.service.snapshot().operations[0].action).not.toHaveProperty("items");r.service.close();
  });
  it("updates a downloaded ArduPilot home record when the vehicle reports a new home", async () => {
    const r=rig();r.heartbeat();r.request({kind:"mission-download"});await flush();r.feed(Object.assign(new common.MissionCount(),{count:2}));await flush();
    for(const item of sample()){r.feed(missionWire(item));await flush();}
    const before=r.service.snapshot().mission.revision;
    r.feed(Object.assign(new common.HomePosition(),{latitude:350100000,longitude:-830100000,altitude:315740}));
    expect(r.service.snapshot().mission.items[0]).toMatchObject({x:35.01,y:-83.01,z:315.74});
    expect(r.service.snapshot().mission.revision).not.toBe(before);r.service.close();
  });
});
