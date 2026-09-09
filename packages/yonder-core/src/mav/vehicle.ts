// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { ardupilotmega, common, minimal, standard, MavLinkProtocolV2, type MavLinkData } from "node-mavlink";
import { decodeDatagram, type DecodedFrame } from "./protocol.js";
import { decodeMissionItem, encodeMissionItem, MAX_MISSION_ITEMS, missionFrame, missionRevision, validateCommandParameters, validateMission, verifyMission } from "./mission.js";
import { isPlane, PLANE_MODES, VehicleTelemetry } from "./vehicle-telemetry.js";
import type { MissionItem, MissionSnapshot, OperatorRequest, OperationAdmission, VehicleAction, VehicleIdentity, VehicleOperation, VehicleServiceOptions, VehicleSnapshot } from "./types.js";
import { AircraftInstrumentation } from './instrumentation.js';
import type { InstrumentationSnapshot } from './instrumentation-types.js';
import { OwnTrail } from './own-trail.js';

export const VEHICLE_SOURCE_SYSTEM = 254;
export const VEHICLE_SOURCE_COMPONENT = 191;
const HEARTBEAT_MS = 3000, COMMAND_MS = 5000, MAX_OPERATIONS = 256;
const IMMEDIATE = new Set([178, 181, 182, 183, 184, 206]);
const FLIGHT_COMMANDS = { heading: 43002, altitude: 43001, speed: 43000, loiter: 192 } as const;
type Step = { name: string; command: number; params: number[]; int?: { frame: number; x: number; y: number; z: number }; observes?: (frame: DecodedFrame) => boolean; requiredMode?: number; acceptedMessage?: string; optional?: boolean };
interface Work {
  op: VehicleOperation; stage: "command" | "upload" | "count" | "items";
  steps: Step[]; step: number; stepSent: boolean; sentSequence: number; deadline: number; absoluteDeadline: number;
  uploaded: Set<number>; received: Map<number, MissionItem>; count: number | null; requested: number | null;
  expected: MissionItem[] | null; retries: number;
}
const emptyMission = (): MissionSnapshot => ({ revision: null, items: [], synchronization: "unknown", currentSeq: null, currentFresh: false, reachedSeq: null, transfer: null, message: "No mission downloaded" });
const number = (v: unknown, min = -1e9, max = 1e9): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min: number, max: number): v is number => number(v, min, max) && Number.isInteger(v);
const readonlyAction = (a: VehicleAction) => a.kind === "stream-setup" || a.kind === "mission-download";
const validHome = (v: any) => v && number(v.lat, -90, 90) && number(v.lon, -180, 180) && number(v.alt, -1000, 30000);
const sameHome = (a: any, b: any) => a === null || b === null ? a === b : validHome(a) && validHome(b) &&
  Math.abs(a.lat-b.lat)<=2e-7 && Math.abs(a.lon-b.lon)<=2e-7 && Math.abs(a.alt-b.alt)<=0.1;

/** One selected aircraft, one transaction, and one explicitly injected send path. R-CMD-04/05/09. */
export class VehicleService {
  private identity: VehicleIdentity | null = null;
  private lastHeartbeat: number | null = null;
  private flightSwVersion: number | null = null;
  private telemetry = new VehicleTelemetry();
  private instruments = new AircraftInstrumentation();
  private ownTrail = new OwnTrail();
  private mission = emptyMission();
  private missionAt: number | null = null;
  private missionOpaqueId = 0;
  private operations: VehicleOperation[] = [];
  private requests = new Map<string, string>();
  private active: Work | null = null;
  private uncertain = new Set<number>();
  private missionUncertain = false;
  private texts: VehicleSnapshot["statustext"] = [];
  private receiveSequence = 0;
  private sequence = 0;
  private protocol = new MavLinkProtocolV2(VEHICLE_SOURCE_SYSTEM, VEHICLE_SOURCE_COMPONENT);
  private wireSequence = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private timer: unknown;
  private closed = false;
  constructor(private readonly options: VehicleServiceOptions) { this.schedule(); }
  private now(): number { return this.options.clock.now(); }
  private connected(): boolean { return !this.closed && this.lastHeartbeat !== null && this.now() >= this.lastHeartbeat && this.now() - this.lastHeartbeat < HEARTBEAT_MS; }
  private schedule(): void { this.timer = this.options.clock.setTimer(200, () => { this.tick(); if (!this.closed) this.schedule(); }); }

  receive(datagram: Uint8Array): void {
    if (this.closed) return;
    this.tick();
    for (const frame of decodeDatagram(datagram)) this.receiveFrame(frame);
  }
  private receiveFrame(frame: DecodedFrame): void {
    const now = this.now(), m = frame.data;
    if (m instanceof minimal.Heartbeat && m.autopilot !== 8 && m.type !== 6) {
      const samePeer = this.identity?.system === frame.system && this.identity.component === frame.component;
      if (this.connected() && !samePeer) return;
      const changed = !this.connected() || !samePeer || this.identity?.autopilot !== m.autopilot || this.identity.vehicleType !== m.type;
      if (changed) {
        if(!samePeer||this.identity?.autopilot!==m.autopilot||this.identity.vehicleType!==m.type)this.ownTrail=new OwnTrail();
        else this.ownTrail.break();
        this.abort("Selected autopilot changed or reconnected; previous outcome is unknown");
        const sameDevice = samePeer && this.identity?.autopilot === m.autopilot && this.identity.vehicleType === m.type;
        this.identity = { system: frame.system, component: frame.component, autopilot: m.autopilot, vehicleType: m.type, generation: randomUUID() };
        this.instruments.select(this.identity, sameDevice);
        this.telemetry = new VehicleTelemetry(); this.mission = emptyMission(); this.missionAt = null; this.missionOpaqueId = 0;
        this.uncertain.clear(); this.missionUncertain = false; this.flightSwVersion = null;
      }
      this.lastHeartbeat = now;
    }
    if (!this.identity || frame.system !== this.identity.system || !this.connected()) return;
    this.instruments.receive(frame, now, this.identity);
    // Peripheral instrumentation never grants mission/command or fast-flight admission.
    if (frame.component !== this.identity.component) return;
    this.receiveSequence++; this.sequence++;
    if (m instanceof standard.AutopilotVersion) this.flightSwVersion = m.flightSwVersion;
    if (m instanceof common.MissionCurrent) {
      if (this.mission.currentSeq !== m.seq) this.telemetry.clearGuidance();
      if (m.missionId && this.missionOpaqueId && m.missionId !== this.missionOpaqueId) this.changedMission("Autopilot reports a different mission revision");
      if (m.missionId) this.missionOpaqueId = m.missionId;
      this.mission.currentSeq = m.seq; this.missionAt = now;
    } else if (m instanceof common.MissionItemReached) this.mission.reachedSeq = m.seq;
    else if (m instanceof common.StatusText) {
      this.texts.push({ at: now, severity: m.severity, text: String(m.text).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 250) });
      this.texts = this.texts.slice(-30);
    }
    const current = this.missionAt !== null && now - this.missionAt < 2000 && this.mission.synchronization !== "receiving" ? this.mission.currentSeq : null;
    this.telemetry.receive(frame, now, this.identity, current);
    if(m instanceof common.GlobalPositionInt){
      const fix=this.telemetry.snapshot(now,true,this.identity).fixType;
      this.ownTrail.observe(m.timeBootMs,m.lat/1e7,m.lon/1e7,fix!==null&&fix>=3,now);
    }
    if (m instanceof common.HomePosition && isPlane(this.identity) && this.mission.synchronization === "verified") {
      const home = this.telemetry.snapshot(now, true, this.identity).homePosition, first = this.mission.items[0];
      if (home && first?.seq === 0 && first.command === 16 && missionFrame(first.frame) === 0) {
        this.mission.items[0] = { ...first, x: home.lat, y: home.lon, z: home.alt };
        this.mission.revision = missionRevision(this.mission.items);
      }
    }
    if ((m instanceof common.MissionAck && m.type === 0 || m instanceof common.MissionRequestInt || m instanceof common.MissionRequest) && m.missionType === 0 && !this.recipient(m)) this.changedMission("Another ground station is changing the vehicle mission; download it again");
    const work = this.active;
    if (!work) return;
    if (work.stage === "command") {
      const step = work.steps[work.step];
      if (m instanceof common.CommandAck && this.recipient(m) && m.command === step?.command && this.receiveSequence > work.sentSequence && work.stepSent) {
        work.op.ack = { command: m.command, result: m.result, progress: m.progress <= 100 ? m.progress : null, at: now };
        if (m.result === 5) { work.deadline = this.now() + COMMAND_MS; this.status(work, "in-progress", "Autopilot reports command in progress"); return; }
        if (m.result !== 0 && step.optional) { this.nextStep(work, "rejected", `Optional stream unavailable: autopilot refused request (${m.result})`); return; }
        if (m.result !== 0) { this.finish(work, "rejected", `Autopilot refused command (${m.result})`, "unavailable"); return; }
        this.status(work, "accepted", "Autopilot accepted; awaiting observed effect");
        if (!step.observes) this.nextStep(work, "accepted", step.acceptedMessage ?? "Autopilot accepted; physical effect is not measured by this command");
      }
      if (this.active === work && step?.observes && work.stepSent && this.receiveSequence > work.sentSequence && step.observes(frame)) this.nextStep(work, "observed", "Requested aircraft state observed");
    } else this.receiveMission(frame, work);
  }
  private recipient(m: { targetSystem: number; targetComponent: number; missionType?: number }): boolean {
    return [0, VEHICLE_SOURCE_SYSTEM].includes(m.targetSystem) && [0, VEHICLE_SOURCE_COMPONENT].includes(m.targetComponent) && (m.missionType === undefined || m.missionType === 0);
  }
  private flightControlReason(): string | null {
    if (!this.connected()) return "A fresh autopilot heartbeat is required";
    if (!isPlane(this.identity)) return "Flight controls are verified for ArduPlane only";
    if (this.flightSwVersion === null) return "Request aircraft streams to obtain AUTOPILOT_VERSION before using flight controls";
    // The firmware version proves the adapter family, not optional build features. ACK is authoritative.
    if (this.flightSwVersion !== 0x040701ff) return "Flight controls are currently verified for ArduPlane 4.7.1 stable only";
    return null;
  }
  instrumentation(): InstrumentationSnapshot {
    this.tick();
    return this.instruments.snapshot(this.now(), this.connected(), this.identity);
  }
  snapshot(options: { details?: boolean } = {}): VehicleSnapshot {
    this.tick();
    const now = this.now(), connected = this.connected(), telemetry = this.telemetry.snapshot(now, connected, this.identity);
    const reason = this.flightControlReason(), lastOperation = this.operations.at(-1), lastText = this.texts.at(-1);
    const detailKey = createHash("sha256").update(JSON.stringify([this.identity, connected, this.flightSwVersion,
      this.mission.revision, this.mission.synchronization, this.mission.message, this.mission.transfer,
      this.operations.length, lastOperation, this.texts.length, lastText])).digest("hex").slice(0, 24);
    return structuredClone({ at: now, sequence: this.sequence, detailKey, identity: this.identity, connected, ready: connected,
      telemetry, trail:this.ownTrail.summary(), mission: { ...this.mission, items: options.details === false ? [] : this.mission.items, currentFresh: connected && this.missionAt !== null && now - this.missionAt < 2000 && this.mission.synchronization === "verified" },
      operations: options.details === false ? [] : this.operations, busy: this.active !== null,
      capabilities: { modes: isPlane(this.identity) ? Object.entries(PLANE_MODES).map(([id, name]) => ({ name, customMode: Number(id), source: "firmware-known" as const })) : [],
        homeControl: { available:isPlane(this.identity), reason:isPlane(this.identity)?null:"Controller home handling is verified for ArduPlane only", confirmation:"readback" as const },
        commands: isPlane(this.identity) ? [...IMMEDIATE].map(command => ({ command, source: "firmware-known" as const })) : [], terrainTargets: false, signing: "unsigned-only" as const,
        flightControl: Object.entries(FLIGHT_COMMANDS).map(([kind, command]) => ({ kind: kind as keyof typeof FLIGHT_COMMANDS, command, source: "firmware-known" as const, available: reason === null, reason, requiredMode: 15 as const, entersGuided: true as const, confirmation: "acknowledgement" as const })) },
      statustext: options.details === false ? [] : this.texts });
  }
  trailPage(epoch?:string,after=0,minimumBootMs=0,minimumDistanceM=0){return this.ownTrail.page(epoch,after,minimumBootMs,minimumDistanceM);}
  submit(request: OperatorRequest): OperationAdmission {
    this.tick();
    const reject = (status: 400 | 409 | 503, message: string): OperationAdmission => ({ accepted: false, status, message });
    if (!request || typeof request !== "object" || typeof request.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(request.id) || typeof request.sessionId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(request.sessionId)) return reject(400, "A bounded operation ID and authenticated session are required");
    if (typeof request.vehicleGeneration !== "string" || request.vehicleGeneration.length > 128 || typeof request.confirmed !== "boolean" || (request.expectedMissionRevision !== undefined && (typeof request.expectedMissionRevision !== "string" || request.expectedMissionRevision.length > 128))) return reject(400, "Invalid vehicle context, revision or confirmation");
    let fingerprint: string;
    try { fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex"); } catch { return reject(400, "Invalid command request"); }
    const key = `${request.sessionId}:${request.id}`, prior = this.requests.get(key);
    if (prior !== undefined) return prior === fingerprint ? { accepted: true, operationId: request.id } : reject(409, "Operation ID already names a different request");
    if (!this.connected() || !this.identity) return reject(503, "A fresh autopilot heartbeat is required");
    if (request.vehicleGeneration !== this.identity.generation) return reject(409, "The selected autopilot changed; review the command again");
    const error = this.validateAction(request.action); if (error) return reject(400, error);
    if (!readonlyAction(request.action) && request.confirmed !== true) return reject(400, "Review and confirm this aircraft-changing action");
    if (!readonlyAction(request.action) && !isPlane(this.identity)) return reject(400, "Aircraft command handling is currently verified for ArduPlane only");
    if (this.active) return reject(409, "Another vehicle operation is in progress");
    if (this.operations.length >= MAX_OPERATIONS) return reject(409, "This service has reached its bounded operation-history limit; completed IDs cannot be reused");
    const kind = request.action.kind;
    if (kind in FLIGHT_COMMANDS) { const reason = this.flightControlReason(); if (reason) return reject(400, reason); }
    const missionChange = ["mission-upload", "mission-clear", "set-current", "continue-auto", "mission-start"].includes(kind);
    if (missionChange && ["changed", "failed"].includes(this.mission.synchronization)) return reject(409, "Vehicle mission synchronization was lost; download and review it before changing it");
    if (missionChange && this.mission.revision !== null && request.expectedMissionRevision !== this.mission.revision) return reject(409, "Vehicle mission changed; review the current revision");
    if (["set-current", "continue-auto", "mission-start"].includes(kind) && this.mission.synchronization !== "verified") return reject(409, "Download and verify the current vehicle mission first");
    const action = request.action;
    if (action.kind === "set-home" && !sameHome(action.expectedHome,this.telemetry.snapshot(this.now(),true,this.identity).homePosition)) return reject(409,"Controller home changed; reopen Home and review again");
    if ((action.kind === "set-current" || action.kind === "continue-auto") && !this.mission.items.some(i => i.seq === action.seq)) return reject(400, "Selected sequence is not in the downloaded mission");
    if (this.missionUncertain && ["mission-upload", "mission-clear"].includes(kind)) return reject(409, "Prior transfer outcome is unknown; download the vehicle mission before another upload");
    const steps = this.steps(request.action);
    if (steps.some(s => this.uncertain.has(s.command))) return reject(409, "A previous command of this type has an unknown outcome; reconnect and review aircraft state before repeating it");
    const summary = action.kind === "mission-upload" ? { kind: "mission-upload" as const, itemCount: action.items.length, revision: missionRevision(action.items) } : structuredClone(action);
    const now = this.now(), op: VehicleOperation = { id: request.id, sessionId: request.sessionId, vehicleGeneration: request.vehicleGeneration, action: summary, createdAt: now, sentAt: null, updatedAt: now, state: "queued", ack: null, effect: { state: "waiting", at: null, message: "Awaiting operator-requested operation" }, message: "Queued", steps: [] };
    this.operations.push(op); this.requests.set(key, fingerprint);
    const work: Work = { op, steps, step: 0, stepSent: false, sentSequence: this.receiveSequence, stage: "command", deadline: now + COMMAND_MS, absoluteDeadline: now + (kind === "stream-setup" ? Math.max(120_000, (steps.length + 1) * COMMAND_MS) : 120_000),
      uploaded: new Set(), received: new Map(), count: null, requested: null, expected: request.action.kind === "mission-upload" ? structuredClone(request.action.items) : request.action.kind === "mission-clear" ? [] : null, retries: 0 };
    this.active = work; this.sequence++;
    this.options.log?.(`vehicle-command at=${now} session=${request.sessionId} id=${request.id} request=${JSON.stringify(request.action)}`);
    void Promise.resolve().then(() => { if (this.active !== work) return; if (kind === "mission-download") this.download(work); else if (work.expected !== null) this.upload(work); else this.sendStep(work); });
    return { accepted: true, operationId: request.id };
  }
  private validateAction(action: VehicleAction): string | null {
    if (!action || typeof action !== "object") return "An action is required";
    switch (action.kind) {
      case "stream-setup": case "mission-download": case "mission-clear": case "mission-start": return null;
      case "set-home": return validHome(action.home) && (action.expectedHome === null || validHome(action.expectedHome)) &&
        (Math.round(action.home.lat*1e7)!==0 || Math.round(action.home.lon*1e7)!==0) ? null : "Home requires explicit latitude, longitude and MSL elevation (-1000 to 30000 m). Zero/zero is ArduPlane's current-location sentinel";
      case "mode": return integer(action.customMode, 0, 0xffffffff) && PLANE_MODES[action.customMode] ? null : "Unsupported mode for the current command adapter";
      case "arm": return typeof action.armed === "boolean" ? null : "Arm state must be boolean";
      case "set-current": return integer(action.seq, 1, MAX_MISSION_ITEMS - 1) ? null : "Invalid mission sequence";
      case "continue-auto": return integer(action.seq, 1, MAX_MISSION_ITEMS - 1) && action.autoMode === 10 ? null : "Continue AUTO requires a valid ArduPlane mission sequence and AUTO mode";
      case "goto": return action.target && number(action.target.lat, -90, 90) && number(action.target.lon, -180, 180) && number(action.target.altitudeM, -1000, 30000) && ["msl", "home"].includes(action.target.datum) ? null : "GUIDED requires valid coordinates and MSL or home-relative altitude; terrain datum is not supported by this adapter";
      case "heading": return number(action.headingDeg, 0, 360) && action.headingDeg < 360 && action.reference === "true" && number(action.turnAccelerationMps2, 0.05, 20) ? null : "Heading requires 0–359.99 degrees true and 0.05–20 m/s² turn acceleration";
      case "altitude": return number(action.altitudeM, -1000, 30000) && ![-1, 0].includes(action.altitudeM) && ["msl", "home"].includes(action.datum) && number(action.verticalRateMps, 0, 100) ? null : "Altitude requires MSL or home-relative metres (except -1 and 0) and a 0–100 m/s vertical rate; zero rate selects the aircraft maximum";
      case "speed": return number(action.airspeedMps, 0.01, 300) && number(action.accelerationMps2, 0, 20) ? null : "Speed requires positive airspeed up to 300 m/s and 0–20 m/s² acceleration; aircraft tuning limits also apply";
      case "loiter": return this.validateAction({ kind: "goto", target: action.target }) ?? (integer(action.radiusM, 1, 65535) && ["cw", "ccw"].includes(action.direction) ? null : "Loiter requires a whole-metre radius from 1–65535 and cw or ccw direction");
      case "mission-upload": return !Array.isArray(action.items) || !action.items.length ? "Use the explicit clear-mission action for an empty mission" : validateMission(action.items);
      case "immediate": return IMMEDIATE.has(action.command) && Array.isArray(action.params) && action.params.length === 7 && action.params.every(p => p === null || number(p)) && (action.frame === undefined || action.frame === 2) ? validateCommandParameters(action.command, action.params) : "Immediate command or parameters are unsupported";
      default: return "Unsupported operator action";
    }
  }
  private steps(action: VehicleAction): Step[] {
    const mode = (id: number): Step => ({ name: `Mode ${PLANE_MODES[id] ?? id}`, command: 176, params: [1, id, 0, 0, 0, 0, 0], observes: f => f.data instanceof minimal.Heartbeat && f.data.customMode === id });
    const current = (seq: number): Step => ({ name: `Current mission item ${seq}`, command: 224, params: [seq, 0, 0, 0, 0, 0, 0], observes: f => f.data instanceof common.MissionCurrent && f.data.seq === seq });
    const guided = (step: Step): Step[] => this.telemetry.snapshot(this.now(), this.connected(), this.identity).customMode === 15 ? [step] : [mode(15), step];
    switch (action.kind) {
      case "mode": return [mode(action.customMode)];
      case "arm": return [{ name: action.armed ? "Arm" : "Disarm", command: 400, params: [action.armed ? 1 : 0, 0, 0, 0, 0, 0, 0], observes: f => f.data instanceof minimal.Heartbeat && !!(f.data.baseMode & 128) === action.armed }];
      case "set-current": return [current(action.seq)];
      case "continue-auto": return [current(action.seq), mode(action.autoMode)];
      // ArduPlane 4.7.1 guided slew commands persist in the autopilot; never repeat from a timer.
      case "heading": return guided({ name: "GUIDED heading", command: 43002, params: [1, action.headingDeg, action.turnAccelerationMps2, 0], int: { frame: 0, x: 0, y: 0, z: 0 }, requiredMode: 15,
        acceptedMessage: "Autopilot accepted true-heading request; heading capture is not reported by this protocol" });
      case "altitude": return guided({ name: "GUIDED altitude", command: 43001, params: [0, 0, action.verticalRateMps, 0], int: { frame: action.datum === "msl" ? 0 : 3, x: 0, y: 0, z: action.altitudeM }, requiredMode: 15,
        acceptedMessage: "Autopilot accepted altitude request; monitor reported altitude and vertical speed, capture is not reported" });
      case "speed": return guided({ name: "GUIDED airspeed", command: 43000, params: [0, action.airspeedMps, action.accelerationMps2, 0], int: { frame: 0, x: 0, y: 0, z: 0 }, requiredMode: 15,
        acceptedMessage: "Autopilot accepted airspeed request; speed capture is not reported by this protocol" });
      case "loiter": return guided({ name: "GUIDED loiter", command: 192, params: [-1, 1, action.radiusM, action.direction === "ccw" ? 1 : 0],
        int: { frame: action.target.datum === "msl" ? 0 : 3, x: Math.round(action.target.lat * 1e7), y: Math.round(action.target.lon * 1e7), z: action.target.altitudeM }, requiredMode: 15,
        acceptedMessage: "Autopilot accepted loiter request; monitor GUIDED target and aircraft track, radius and direction are not reported" });
      case "goto": {
        const t = action.target, frame = t.datum === "msl" ? 0 : 3;
        return [{ name: "GUIDED target", command: 192, params: [-1, 1, 0, 0], int: { frame, x: Math.round(t.lat * 1e7), y: Math.round(t.lon * 1e7), z: t.altitudeM }, observes: f => {
          const m = f.data, state = this.telemetry.snapshot(this.now(), this.connected(), this.identity);
          if (!(m instanceof common.PositionTargetGlobalInt) || state.mode !== "GUIDED" || (m.typeMask & 7)) return false;
          const reportedFrame = missionFrame(m.coordinateFrame), home = state.homePosition;
          const requestedMsl = frame === 0 ? t.altitudeM : home ? home.alt + t.altitudeM : null;
          const reportedMsl = reportedFrame === 0 ? m.alt : reportedFrame === 3 && home ? home.alt + m.alt : null;
          const altitudeMatches = reportedFrame === frame ? Math.abs(m.alt - t.altitudeM) <= 0.05 : requestedMsl !== null && reportedMsl !== null && Math.abs(requestedMsl - reportedMsl) <= 0.05;
          return altitudeMatches && Math.abs(m.latInt / 1e7 - t.lat) <= 2e-7 && Math.abs(m.lonInt / 1e7 - t.lon) <= 2e-7;
        } }];
      }
      case "mission-start": return [{ name: "Mission start", command: 300, params: [0, 0, 0, 0, 0, 0, 0] }];
      case "set-home": return [
        {name:"Set controller home",command:179,params:[0,0,0,0],int:{frame:0,x:Math.round(action.home.lat*1e7),y:Math.round(action.home.lon*1e7),z:action.home.alt},acceptedMessage:"Controller accepted home command; requesting home readback"},
        {name:"Verify controller home",command:512,params:[242,0,0,0,0,0,0],observes:frame=>frame.data instanceof common.HomePosition && sameHome(action.home,{lat:frame.data.latitude/1e7,lon:frame.data.longitude/1e7,alt:frame.data.altitude/1000})},
      ];
      case "immediate": return [{ name: `Command ${action.command}`, command: action.command, params: action.params.map(p => p === null ? NaN : p) }];
      case "stream-setup": return [
        ...[[30, 10], [33, 10], [74, 10], [62, 10], [24, 2], [1, 2], [42, 2], [87, 2]].map(([id, hz]) => ({ name: `Request message ${id} at ${hz} Hz`, command: 511, params: [id, Math.round(1e6 / hz), 0, 0, 0, 0, 0] })),
        ...[148, 242].map(id => ({ name: `Request message ${id}`, command: 512, params: [id, 0, 0, 0, 0, 0, 0] })),
        { name: "Request wind estimate at 1 Hz", command: 511, params: [168, 1000000, 0, 0, 0, 0, 0] },
        { name: "Request calibrated primary acceleration at 5 Hz", command: 511, params: [27, 200000, 0, 0, 0, 0, 0] },
        ...[
          common.SystemTime, common.BatteryStatus, common.ExtendedSysState, common.Gps2Raw,
          common.EstimatorStatus, ardupilotmega.EkfStatusReport, common.Vibration,
          ardupilotmega.Rpm, ardupilotmega.EscTelemetry1To4, ardupilotmega.EscTelemetry5To8,
          ardupilotmega.EscTelemetry9To12, ardupilotmega.EscTelemetry13To16,
          ardupilotmega.EscTelemetry17To20, ardupilotmega.EscTelemetry21To24,
          ardupilotmega.EscTelemetry25To28, ardupilotmega.EscTelemetry29To32,
          common.EfiStatus, common.GeneratorStatus, common.DistanceSensor, ardupilotmega.RangeFinder,
          common.TerrainReport, common.FenceStatus, common.PowerStatus, ardupilotmega.HwStatus, ardupilotmega.McuStatus,
          ardupilotmega.MemInfo, common.RadioStatus, common.RcChannels, common.ServoOutputRaw,
          common.CameraInformation, common.CameraCaptureStatus, common.StorageInformation,
          common.GimbalDeviceAttitudeStatus,
        ].map(type => ({ name: `Request optional ${type.MSG_NAME} at 1 Hz`, command: 511,
          params: [type.MSG_ID, 1000000, 0, 0, 0, 0, 0], optional: true })),
      ];
      default: return [];
    }
  }
  private sendStep(work: Work): void {
    const step = work.steps[work.step]; if (!step) return;
    work.stage = "command"; work.stepSent = false; work.op.ack = null; work.sentSequence = this.receiveSequence; work.deadline = this.now() + COMMAND_MS;
    const message = step.int ? new common.CommandInt() : new common.CommandLong();
    Object.assign(message, { command: step.command, confirmation: 0, _param1: step.params[0], _param2: step.params[1], _param3: step.params[2], _param4: step.params[3] });
    if (step.int) Object.assign(message, { frame: step.int.frame, _param5: step.int.x, _param6: step.int.y, _param7: step.int.z });
    else Object.assign(message, { _param5: step.params[4], _param6: step.params[5], _param7: step.params[6] });
    this.send(message, work);
  }
  private nextStep(work: Work, state: "accepted" | "observed" | "rejected", message: string): void {
    work.op.steps.push({ action: work.steps[work.step].name, state, message });
    work.step++;
    if (work.step < work.steps.length) this.sendStep(work);
    else if (work.op.action.kind === "stream-setup") {
      const refused = work.op.steps.filter(step => step.state === "rejected").length;
      this.finish(work, "accepted", refused ? `Essential streams requested; ${refused} optional instrumentation streams unavailable` : "Aircraft stream requests acknowledged; readings appear when reported by installed sensors", "unavailable");
    } else this.finish(work, state, message, state === "observed" ? "observed" : "unavailable");
  }
  private send(message: MavLinkData, work: Work, after?: () => void): void {
    const identity = this.identity;
    Object.assign(message, { targetSystem: identity?.system, targetComponent: identity?.component });
    const bytes = this.protocol.serialize(message, this.wireSequence++ % 256);
    this.writeChain = this.writeChain.then(async () => {
      if (this.active !== work || !this.connected() || this.identity?.generation !== work.op.vehicleGeneration) return;
      if (work.op.action.kind === "set-home" && work.step === 0 && !sameHome(work.op.action.expectedHome,this.telemetry.snapshot(this.now(),true,this.identity).homePosition)) {
        this.finish(work,"failed","Controller home changed before sending; reopen Home and review again","unavailable");return;
      }
      if (work.op.action.kind in FLIGHT_COMMANDS && this.flightControlReason()) {
        this.finish(work, "failed", "Aircraft firmware evidence changed before the flight control was sent; review again", "unavailable"); return;
      }
      if (work.stage === "command" && work.steps[work.step]?.requiredMode !== undefined && this.telemetry.snapshot(this.now(), true, this.identity).customMode !== work.steps[work.step].requiredMode) {
        this.finish(work, "failed", "Aircraft mode changed before the GUIDED control was sent; review again", "unavailable"); return;
      }
      work.op.sentAt ??= this.now();
      if (work.stage === "command") { work.stepSent = true; work.sentSequence = this.receiveSequence; this.status(work, "sent", "Sent; awaiting autopilot response"); }
      else if (work.op.state === "queued") this.status(work, "sent", "Sent; awaiting autopilot response");
      await this.options.send(bytes);
      if (this.active === work) after?.();
    }).catch(() => { if (this.active === work) this.abort("MAVLink send failed; outcome is unknown"); });
  }
  private status(work: Work, state: VehicleOperation["state"], message: string): void { work.op.state = state; work.op.message = message; work.op.updatedAt = this.now(); this.sequence++; }
  private finish(work: Work, state: VehicleOperation["state"], message: string, effect: VehicleOperation["effect"]["state"]): void {
    this.status(work, state, message); work.op.effect = { state: effect, at: this.now(), message };
    if (this.active === work) this.active = null;
    this.mission.transfer = null;
    this.options.log?.(`vehicle-result at=${this.now()} session=${work.op.sessionId} id=${work.op.id} state=${state} ${message}`);
  }
  private abort(message: string): void {
    const work = this.active; if (!work) return;
    if (work.stage === "command" && work.steps[work.step]) this.uncertain.add(work.steps[work.step].command);
    else { this.missionUncertain = work.expected !== null; this.mission.synchronization = "failed"; this.mission.message = message; }
    this.finish(work, work.op.sentAt === null ? "failed" : "unknown", message, "unavailable");
  }
  private changedMission(message: string): void {
    this.mission.synchronization = "changed"; this.mission.message = message; this.telemetry.clearGuidance();
    if (this.active) this.abort(message);
  }
  private tick(): void {
    if (this.closed) return;
    if (!this.connected()) { this.abort("Autopilot heartbeat expired; outcome is unknown"); return; }
    const work = this.active; if (!work) return;
    if (this.now() >= work.absoluteDeadline) { this.abort("Operation exceeded its bounded deadline; outcome is unknown"); return; }
    if (this.now() < work.deadline) return;
    if ((work.stage === "count" || work.stage === "items") && work.retries++ < 2) {
      work.deadline = this.now() + COMMAND_MS;
      if (work.stage === "count") this.send(Object.assign(new common.MissionRequestList(), { missionType: 0 }), work);
      else this.requestItem(work, true);
      return;
    }
    if (work.stage === "command" && work.steps[work.step]?.optional) {
      // COMMAND_ACK for SET_MESSAGE_INTERVAL carries no requested message ID. A late
      // ACK after timeout cannot safely be assigned to another optional request.
      this.uncertain.add(work.steps[work.step].command);
      work.op.steps.push({ action: work.steps[work.step].name, state: "unknown", message: "Optional stream request timed out; remaining optional requests stopped" });
      this.finish(work, "accepted", "Essential streams requested; optional instrumentation setup incomplete after timeout, remaining requests stopped", "unavailable");
      return;
    }
    if (work.stage === "command" && work.op.ack?.result === 0) {
      this.uncertain.add(work.steps[work.step].command);
      this.finish(work, "accepted", "Autopilot accepted, but the requested effect has not been observed", "mismatch");
    } else this.abort("No final autopilot response before timeout; outcome is unknown");
  }
  private upload(work: Work): void {
    work.stage = "upload"; work.deadline = this.now() + Math.max(15_000, (work.expected?.length ?? 0) * 400);
    work.absoluteDeadline = this.now() + Math.max(120_000, (work.expected?.length ?? 0) * 1500);
    this.mission.synchronization = "receiving"; this.mission.message = "Uploading; awaiting autopilot requests"; this.telemetry.clearGuidance();
    this.mission.transfer = { operationId: work.op.id, received: 0, total: work.expected!.length };
    this.send(Object.assign(new common.MissionCount(), { count: work.expected!.length, missionType: 0 }), work);
  }
  private download(work: Work): void {
    work.stage = "count"; work.received.clear(); work.count = null; work.requested = null; work.retries = 0; work.deadline = this.now() + COMMAND_MS;
    this.mission.synchronization = "receiving"; this.mission.message = "Downloading vehicle mission"; this.telemetry.clearGuidance();
    this.mission.transfer = { operationId: work.op.id, received: 0, total: null };
    this.send(Object.assign(new common.MissionRequestList(), { missionType: 0 }), work);
  }
  private requestItem(work: Work, retry = false): void {
    const seq = Array.from({ length: work.count ?? 0 }, (_, i) => i).find(i => !work.received.has(i));
    if (seq === undefined) return;
    if (!retry && work.requested === seq) return;
    work.requested = seq; work.deadline = this.now() + COMMAND_MS;
    this.send(Object.assign(new common.MissionRequestInt(), { seq, missionType: 0 }), work);
  }
  private receiveMission(frame: DecodedFrame, work: Work): void {
    const m = frame.data;
    if (!(m instanceof common.MissionCount || m instanceof common.MissionItemInt || m instanceof common.MissionItem || m instanceof common.MissionRequestInt || m instanceof common.MissionRequest || m instanceof common.MissionAck)) return;
    if (!this.recipient(m)) return;
    if (work.stage === "upload") {
      if (m instanceof common.MissionAck) {
        work.op.ack = { command: 44, result: m.type, progress: null, at: this.now() };
        if (m.type !== 0) { this.mission.synchronization = "failed"; this.finish(work, "rejected", `Autopilot refused mission (${m.type})`, "unavailable"); return; }
        if (work.uploaded.size !== work.expected!.length) { this.abort("Mission ACK arrived before every requested item was sent"); return; }
        this.status(work, "accepted", "Mission accepted; downloading to verify"); this.download(work);
      } else if (m instanceof common.MissionRequestInt || m instanceof common.MissionRequest) {
        if (!integer(m.seq, 0, work.expected!.length - 1)) { this.abort("Autopilot requested an invalid mission sequence"); return; }
        this.send(encodeMissionItem(work.expected![m.seq]), work, () => { work.uploaded.add(m.seq); if (this.mission.transfer) this.mission.transfer.received = work.uploaded.size; });
      }
      return;
    }
    if (m instanceof common.MissionCount) {
      if (work.stage !== "count") { if (m.count !== work.count) this.abort("Mission count changed during download"); return; }
      if (!integer(m.count, 0, MAX_MISSION_ITEMS)) { this.abort("Vehicle mission exceeds the supported bound"); return; }
      work.count = m.count; work.stage = "items"; work.retries = 0;
      if (m.opaqueId) this.missionOpaqueId = m.opaqueId;
      if (this.mission.transfer) this.mission.transfer.total = m.count;
      if (!m.count) this.completeDownload(work); else this.requestItem(work);
    } else if ((m instanceof common.MissionItemInt || m instanceof common.MissionItem) && work.stage === "items") {
      if (!integer(m.seq, 0, (work.count ?? 0) - 1) || ![0, 1].includes(m.current) || ![0, 1].includes(m.autocontinue)) { this.abort("Invalid mission item sequence or flags"); return; }
      const item = decodeMissionItem(m), prior = work.received.get(item.seq);
      if (prior && JSON.stringify(prior) !== JSON.stringify(item)) { this.abort("Conflicting duplicate mission item"); return; }
      if (!prior) { work.received.set(item.seq, item); work.retries = 0; work.deadline = this.now() + COMMAND_MS; }
      if (this.mission.transfer) this.mission.transfer.received = work.received.size;
      if (work.received.size === work.count) this.completeDownload(work); else this.requestItem(work);
    } else if (m instanceof common.MissionAck && m.type !== 0) { this.abort(`Mission download refused (${m.type})`); }
  }
  private completeDownload(work: Work): void {
    const items = [...work.received.values()].sort((a, b) => a.seq - b.seq), error = validateMission(items, false);
    if (error) { this.abort(`Downloaded mission cannot be represented: ${error}`); return; }
    const issues = work.expected === null ? [] : verifyMission(work.expected, items);
    // The final protocol ACK must leave before the operation reservation is released.
    this.send(Object.assign(new common.MissionAck(), { type: 0, missionType: 0 }), work, () => {
      this.mission = { ...this.mission, items, revision: missionRevision(items), synchronization: "verified", transfer: null, message: issues.length ? "Downloaded actual vehicle mission differs from requested upload" : "Vehicle mission downloaded and verified" };
      this.missionUncertain = false;
      if (issues.length) this.finish(work, "accepted", issues.join("; "), "mismatch");
      else this.finish(work, "observed", work.expected === null ? "Complete vehicle mission downloaded" : "Mission accepted and downloaded copy verified; home is the actual vehicle home", "observed");
    });
  }
  close(): void { if (this.closed) return; this.abort("Vehicle service closed; unfinished outcome is unknown"); this.closed = true; this.options.clock.clearTimer(this.timer); }
}
