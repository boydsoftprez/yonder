// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomUUID } from "node:crypto";
import { common, minimal, MavLinkProtocolV2, type MavLinkData } from "node-mavlink";
import { decodeDatagram, type DecodedFrame } from "./protocol.js";
import { decodeMissionItem, encodeMissionItem, MAX_MISSION_ITEMS, missionFrame, missionRevision, validateCommandParameters, validateMission, verifyMission } from "./mission.js";
import { isPlane, PLANE_MODES, VehicleTelemetry } from "./vehicle-telemetry.js";
import type { MissionItem, MissionSnapshot, OperatorRequest, OperationAdmission, VehicleAction, VehicleIdentity, VehicleOperation, VehicleServiceOptions, VehicleSnapshot } from "./types.js";

export const VEHICLE_SOURCE_SYSTEM = 254;
export const VEHICLE_SOURCE_COMPONENT = 191;
const HEARTBEAT_MS = 3000, COMMAND_MS = 5000, MAX_OPERATIONS = 256;
const IMMEDIATE = new Set([178, 181, 182, 183, 184, 206]);
type Step = { name: string; command: number; params: number[]; int?: { frame: number; x: number; y: number; z: number }; observes?: (frame: DecodedFrame) => boolean };
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

/** One selected aircraft, one transaction, and one explicitly injected send path. R-CMD-04/05/09. */
export class VehicleService {
  private identity: VehicleIdentity | null = null;
  private lastHeartbeat: number | null = null;
  private telemetry = new VehicleTelemetry();
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
        this.abort("Selected autopilot changed or reconnected; previous outcome is unknown");
        this.identity = { system: frame.system, component: frame.component, autopilot: m.autopilot, vehicleType: m.type, generation: randomUUID() };
        this.telemetry = new VehicleTelemetry(); this.mission = emptyMission(); this.missionAt = null; this.missionOpaqueId = 0;
        this.uncertain.clear(); this.missionUncertain = false;
      }
      this.lastHeartbeat = now;
    }
    if (!this.identity || frame.system !== this.identity.system || frame.component !== this.identity.component || !this.connected()) return;
    this.receiveSequence++; this.sequence++;
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
        if (m.result !== 0) { this.finish(work, "rejected", `Autopilot refused command (${m.result})`, "unavailable"); return; }
        this.status(work, "accepted", "Autopilot accepted; awaiting observed effect");
        if (!step.observes) this.nextStep(work, "accepted", "Autopilot accepted; physical effect is not measured by this command");
      }
      if (this.active === work && step?.observes && work.stepSent && this.receiveSequence > work.sentSequence && step.observes(frame)) this.nextStep(work, "observed", "Requested aircraft state observed");
    } else this.receiveMission(frame, work);
  }
  private recipient(m: { targetSystem: number; targetComponent: number; missionType?: number }): boolean {
    return [0, VEHICLE_SOURCE_SYSTEM].includes(m.targetSystem) && [0, VEHICLE_SOURCE_COMPONENT].includes(m.targetComponent) && (m.missionType === undefined || m.missionType === 0);
  }
  snapshot(): VehicleSnapshot {
    this.tick();
    const now = this.now(), connected = this.connected(), telemetry = this.telemetry.snapshot(now, connected, this.identity);
    return structuredClone({ at: now, sequence: this.sequence, identity: this.identity, connected, ready: connected,
      telemetry, mission: { ...this.mission, currentFresh: connected && this.missionAt !== null && now - this.missionAt < 2000 && this.mission.synchronization === "verified" },
      operations: this.operations, busy: this.active !== null,
      capabilities: { modes: isPlane(this.identity) ? Object.entries(PLANE_MODES).map(([id, name]) => ({ name, customMode: Number(id), source: "firmware-known" as const })) : [],
        commands: isPlane(this.identity) ? [...IMMEDIATE].map(command => ({ command, source: "firmware-known" as const })) : [], terrainTargets: false, signing: "unsigned-only" as const },
      statustext: this.texts });
  }
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
    const missionChange = ["mission-upload", "mission-clear", "set-current", "continue-auto", "mission-start"].includes(kind);
    if (missionChange && ["changed", "failed"].includes(this.mission.synchronization)) return reject(409, "Vehicle mission synchronization was lost; download and review it before changing it");
    if (missionChange && this.mission.revision !== null && request.expectedMissionRevision !== this.mission.revision) return reject(409, "Vehicle mission changed; review the current revision");
    if (["set-current", "continue-auto", "mission-start"].includes(kind) && this.mission.synchronization !== "verified") return reject(409, "Download and verify the current vehicle mission first");
    const action = request.action;
    if ((action.kind === "set-current" || action.kind === "continue-auto") && !this.mission.items.some(i => i.seq === action.seq)) return reject(400, "Selected sequence is not in the downloaded mission");
    if (this.missionUncertain && ["mission-upload", "mission-clear"].includes(kind)) return reject(409, "Prior transfer outcome is unknown; download the vehicle mission before another upload");
    const steps = this.steps(request.action);
    if (steps.some(s => this.uncertain.has(s.command))) return reject(409, "A previous command of this type has an unknown outcome; reconnect and review aircraft state before repeating it");
    const summary = action.kind === "mission-upload" ? { kind: "mission-upload" as const, itemCount: action.items.length, revision: missionRevision(action.items) } : structuredClone(action);
    const now = this.now(), op: VehicleOperation = { id: request.id, sessionId: request.sessionId, vehicleGeneration: request.vehicleGeneration, action: summary, createdAt: now, sentAt: null, updatedAt: now, state: "queued", ack: null, effect: { state: "waiting", at: null, message: "Awaiting operator-requested operation" }, message: "Queued", steps: [] };
    this.operations.push(op); this.requests.set(key, fingerprint);
    const work: Work = { op, steps, step: 0, stepSent: false, sentSequence: this.receiveSequence, stage: "command", deadline: now + COMMAND_MS, absoluteDeadline: now + 120_000,
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
      case "mode": return integer(action.customMode, 0, 0xffffffff) && PLANE_MODES[action.customMode] ? null : "Unsupported mode for the current command adapter";
      case "arm": return typeof action.armed === "boolean" ? null : "Arm state must be boolean";
      case "set-current": return integer(action.seq, 1, MAX_MISSION_ITEMS - 1) ? null : "Invalid mission sequence";
      case "continue-auto": return integer(action.seq, 1, MAX_MISSION_ITEMS - 1) && action.autoMode === 10 ? null : "Continue AUTO requires a valid ArduPlane mission sequence and AUTO mode";
      case "goto": return action.target && number(action.target.lat, -90, 90) && number(action.target.lon, -180, 180) && number(action.target.altitudeM, -1000, 30000) && ["msl", "home"].includes(action.target.datum) ? null : "GUIDED requires valid coordinates and MSL or home-relative altitude; terrain datum is not supported by this adapter";
      case "mission-upload": return !Array.isArray(action.items) || !action.items.length ? "Use the explicit clear-mission action for an empty mission" : validateMission(action.items);
      case "immediate": return IMMEDIATE.has(action.command) && Array.isArray(action.params) && action.params.length === 7 && action.params.every(p => p === null || number(p)) && (action.frame === undefined || action.frame === 2) ? validateCommandParameters(action.command, action.params) : "Immediate command or parameters are unsupported";
      default: return "Unsupported operator action";
    }
  }
  private steps(action: VehicleAction): Step[] {
    const mode = (id: number): Step => ({ name: `Mode ${PLANE_MODES[id] ?? id}`, command: 176, params: [1, id, 0, 0, 0, 0, 0], observes: f => f.data instanceof minimal.Heartbeat && f.data.customMode === id });
    const current = (seq: number): Step => ({ name: `Current mission item ${seq}`, command: 224, params: [seq, 0, 0, 0, 0, 0, 0], observes: f => f.data instanceof common.MissionCurrent && f.data.seq === seq });
    switch (action.kind) {
      case "mode": return [mode(action.customMode)];
      case "arm": return [{ name: action.armed ? "Arm" : "Disarm", command: 400, params: [action.armed ? 1 : 0, 0, 0, 0, 0, 0, 0], observes: f => f.data instanceof minimal.Heartbeat && !!(f.data.baseMode & 128) === action.armed }];
      case "set-current": return [current(action.seq)];
      case "continue-auto": return [current(action.seq), mode(action.autoMode)];
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
      case "immediate": return [{ name: `Command ${action.command}`, command: action.command, params: action.params.map(p => p === null ? NaN : p) }];
      case "stream-setup": return [
        ...[[30, 10], [33, 10], [74, 10], [62, 10], [24, 2], [1, 2], [42, 2], [87, 2]].map(([id, hz]) => ({ name: `Request message ${id} at ${hz} Hz`, command: 511, params: [id, Math.round(1e6 / hz), 0, 0, 0, 0, 0] })),
        ...[148, 242].map(id => ({ name: `Request message ${id}`, command: 512, params: [id, 0, 0, 0, 0, 0, 0] })),
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
  private nextStep(work: Work, state: "accepted" | "observed", message: string): void {
    work.op.steps.push({ action: work.steps[work.step].name, state, message });
    work.step++;
    if (work.step < work.steps.length) this.sendStep(work);
    else this.finish(work, state, message, state === "observed" ? "observed" : "unavailable");
  }
  private send(message: MavLinkData, work: Work, after?: () => void): void {
    const identity = this.identity;
    Object.assign(message, { targetSystem: identity?.system, targetComponent: identity?.component });
    const bytes = this.protocol.serialize(message, this.wireSequence++ % 256);
    this.writeChain = this.writeChain.then(async () => {
      if (this.active !== work || !this.connected() || this.identity?.generation !== work.op.vehicleGeneration) return;
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
