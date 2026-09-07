// SPDX-License-Identifier: GPL-3.0-or-later
import type { Clock } from "../apply/types.js";

export type AltitudeDatum = "msl" | "home" | "terrain";
export interface GeoTarget { lat: number; lon: number; altitudeM: number; datum: AltitudeDatum }
export interface VehicleIdentity { system: number; component: number; autopilot: number; vehicleType: number; generation: string }
export interface FieldValidity { source: string; receivedAt: number | null; ageMs: number | null; valid: boolean; reason?: string }
/** ArduPlane's reported horizontal estimate. WIND carries no estimator confidence flag. */
export interface WindEstimate { directionFromDeg: number; speedKt: number; ageMs: number; source: "WIND" }
/** Calibrated body specific force: right-positive lateral and upward-positive normal load, in g. */
export interface SlipSkidSample { lateralG: number; normalG: number; ageMs: number; source: "RAW_IMU" | "SCALED_IMU" }
/** Canonical decoded values: geographic x/y in degrees, local x/y in metres, other commands raw. */
export interface MissionItem { seq: number; command: number; frame: number; params: [number | null, number | null, number | null, number | null]; x: number | null; y: number | null; z: number | null; current: boolean; autocontinue: boolean }
export interface MissionSnapshot {
  revision: string | null;
  /** Full wire sequence including ArduPilot's home item zero. */
  items: MissionItem[];
  synchronization: "unknown" | "receiving" | "verified" | "changed" | "failed";
  currentSeq: number | null; currentFresh: boolean; reachedSeq: number | null;
  transfer: { operationId: string; received: number; total: number | null } | null;
  message: string;
}
export interface PositionTarget { lat: number; lon: number; alt: number; frame: number; ageMs: number }
export interface NavController {
  crossTrackM: number; navBearingDeg: number; targetBearingDeg: number; waypointDistanceM: number;
  missionSeq: number | null; mode: string | null; autopilotId: number; vehicleType: number;
  position: { latitude: number; longitude: number } | null; positionTarget: Omit<PositionTarget, "ageMs"> | null;
  ageMs: number;
}
/** Flat view for the PFD adapters. Null means unavailable, including expired data. */
export interface FlightTelemetry {
  source: "MAVLink"; ready: boolean; ageMs: number | null;
  altitudeDatum?: "UNKNOWN" | "EGM96" | "NAVD88" | "WGS84_ELLIPSOID";
  rollDeg: number | null; pitchDeg: number | null; yawRateDegS: number | null;
  airspeedKt: number | null; groundspeedKt: number | null; headingDeg: number | null; trackDeg: number | null;
  altitudeFt: number | null; verticalSpeedFpm: number | null;
  latitude: number | null; longitude: number | null; globalAltitudeM: number | null;
  /** GPS_RAW_INT altitude, never GLOBAL_POSITION_INT fused altitude. */
  gpsAltitudeM: number | null; relativeAltitudeM: number | null;
  fixType: number | null; satellites: number | null; batteryV: number | null; currentA: number | null; batteryPercent: number | null;
  throttlePercent: number | null; mode: string | null; customMode: number | null; armed: boolean | null;
  fdReady: boolean; navRollDeg: number | null; navPitchDeg: number | null;
  positionTarget: PositionTarget | null; navController: NavController | null;
  homePosition: { lat: number; lon: number; alt: number } | null;
  wind?: WindEstimate | null;
  slipSkid?: SlipSkidSample | null;
  fields: Record<string, FieldValidity>;
}
export type VehicleAction =
  | { kind: "stream-setup" }
  | { kind: "mode"; customMode: number }
  | { kind: "arm"; armed: boolean }
  | { kind: "goto"; target: GeoTarget }
  | { kind: "heading"; headingDeg: number; reference: "true"; turnAccelerationMps2: number }
  | { kind: "altitude"; altitudeM: number; datum: "msl" | "home"; verticalRateMps: number }
  | { kind: "speed"; airspeedMps: number; accelerationMps2: number }
  | { kind: "loiter"; target: GeoTarget; radiusM: number; direction: "cw" | "ccw" }
  | { kind: "set-current"; seq: number }
  | { kind: "continue-auto"; seq: number; autoMode: number }
  | { kind: "mission-start" }
  | { kind: "mission-upload"; items: MissionItem[] }
  | { kind: "mission-clear" }
  | { kind: "mission-download" }
  | { kind: "immediate"; command: number; params: [number | null, number | null, number | null, number | null, number | null, number | null, number | null]; frame?: number };
/** sessionId is supplied by the authenticated server, never accepted from the browser body. */
export interface OperatorRequest { id: string; sessionId: string; vehicleGeneration: string; expectedMissionRevision?: string; confirmed: boolean; action: VehicleAction }
export type OperationState = "queued" | "sent" | "in-progress" | "accepted" | "observed" | "rejected" | "unknown" | "failed";
export type OperationAction = Exclude<VehicleAction, { kind: "mission-upload" }> | { kind: "mission-upload"; itemCount: number; revision: string };
export interface VehicleOperation {
  id: string; sessionId: string; vehicleGeneration: string; action: OperationAction;
  createdAt: number; sentAt: number | null; updatedAt: number; state: OperationState;
  ack: { command: number; result: number; progress: number | null; at: number } | null;
  effect: { state: "waiting" | "observed" | "unavailable" | "mismatch"; at: number | null; message: string };
  message: string; steps: { action: string; state: OperationState; message: string }[];
}
export interface VehicleSnapshot {
  at: number; sequence: number; identity: VehicleIdentity | null; connected: boolean; ready: boolean;
  /** Stable across flight samples; identifies the separately transferable details. */
  detailKey?: string;
  trail?: OwnTrailSummary;
  telemetry: FlightTelemetry; mission: MissionSnapshot; operations: VehicleOperation[]; busy: boolean;
  capabilities: { modes: { name: string; customMode: number; source: "advertised" | "firmware-known" }[]; commands: { command: number; source: "advertised" | "firmware-known" }[]; terrainTargets: boolean; signing: "unsigned-only";
    flightControl: { kind: "heading" | "altitude" | "speed" | "loiter"; command: number; source: "firmware-known"; available: boolean; reason: string | null; requiredMode: 15; entersGuided: true; confirmation: "acknowledgement" }[] };
  statustext: { at: number; severity: number; text: string }[];
}
export type OperationAdmission = { accepted: true; operationId: string } | { accepted: false; status: 400 | 409 | 503; message: string };
export interface VehicleServiceOptions { send: (bytes: Uint8Array) => Promise<void>; clock: Clock; log?: (line: string) => void }
/** Serial, autopilot boot milliseconds (unwrapped), lat, lon, observed path metres, segment. */
export type OwnTrailPoint = [number,number,number,number,number,number];
export interface OwnTrailSummary {
  epoch:string; revision:number; latest:number; bootMs:number|null; clockAt:number|null; startBootMs:number|null;
  simplified:boolean; truncated:boolean; gaps:number; tail:OwnTrailPoint|null;
}
export interface OwnTrailPage extends OwnTrailSummary { points:OwnTrailPoint[]; next:number; more:boolean; reset:boolean }
