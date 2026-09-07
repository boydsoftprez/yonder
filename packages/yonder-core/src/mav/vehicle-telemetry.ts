// SPDX-License-Identifier: GPL-3.0-or-later
import { ardupilotmega, common, minimal } from "node-mavlink";
import type { DecodedFrame } from "./protocol.js";
import type { FieldValidity, FlightTelemetry, NavController, PositionTarget, VehicleIdentity } from "./types.js";
export const PLANE_MODES: Record<number, string> = { 0: "MANUAL", 1: "CIRCLE", 2: "STABILIZE", 3: "TRAINING", 4: "ACRO", 5: "FBWA", 6: "FBWB", 7: "CRUISE", 8: "AUTOTUNE", 10: "AUTO", 11: "RTL", 12: "LOITER", 13: "TAKEOFF", 14: "AVOID_ADSB", 15: "GUIDED", 17: "QSTABILIZE", 18: "QHOVER", 19: "QLOITER", 20: "QLAND", 21: "QRTL", 22: "QAUTOTUNE", 23: "QACRO", 24: "THERMAL", 25: "LOITER_ALT_QLAND", 26: "AUTOLAND" };
export const isPlane = (id: VehicleIdentity | null): boolean => id?.autopilot === 3 && id.vehicleType === 1;
const clean = (n: number): number | null => Number.isFinite(n) ? n : null;
const range = (n: number, lo: number, hi: number): number | null => Number.isFinite(n) && n >= lo && n <= hi ? n : null;
const positionValid = (lat: number, lon: number) => range(lat, -90, 90) !== null && range(lon, -180, 180) !== null;
const KEYS = ["rollDeg", "pitchDeg", "yawRateDegS", "airspeedKt", "groundspeedKt", "headingDeg", "trackDeg", "altitudeFt", "verticalSpeedFpm", "latitude", "longitude", "globalAltitudeM", "gpsAltitudeM", "relativeAltitudeM", "fixType", "satellites", "batteryV", "currentA", "batteryPercent", "throttlePercent", "mode", "customMode", "armed", "navRollDeg", "navPitchDeg"] as const;
type Scalar = typeof KEYS[number];
interface Sample { value: number | string | boolean | null; at: number; source: string; ttl: number }
export class VehicleTelemetry {
  private values = new Map<Scalar, Sample>();
  private nav: { value: Omit<NavController, "ageMs">; at: number } | null = null;
  private target: { value: Omit<PositionTarget, "ageMs">; at: number } | null = null;
  private home: { value: { lat: number; lon: number; alt: number }; at: number } | null = null;
  private wind: { directionFromDeg: number; speedKt: number; at: number } | null = null;
  private put(values: Partial<Record<Scalar, Sample["value"]>>, source: string, now: number, ttl = 2000) {
    for (const [key, value] of Object.entries(values)) this.values.set(key as Scalar, { value: value ?? null, source, at: now, ttl });
  }
  clearGuidance(): void { this.nav = null; this.values.delete("navRollDeg"); this.values.delete("navPitchDeg"); }
  private value(key: Scalar, now: number): Sample["value"] { const s = this.values.get(key); return s && now >= s.at && now - s.at < s.ttl ? s.value : null; }
  receive(frame: DecodedFrame, now: number, identity: VehicleIdentity, currentSeq: number | null): void {
    const m = frame.data;
    if (m instanceof minimal.Heartbeat) {
      if (this.values.get("customMode")?.value !== m.customMode) { this.clearGuidance(); this.target = null; }
      this.put({ customMode: m.customMode, mode: isPlane(identity) ? PLANE_MODES[m.customMode] ?? `Mode ${m.customMode}` : `Mode ${m.customMode}`, armed: !!(m.baseMode & 128) }, "HEARTBEAT", now, 3000);
    } else if (m instanceof common.Attitude) {
      this.put({ rollDeg: range(m.roll * 180 / Math.PI, -180, 180), pitchDeg: range(m.pitch * 180 / Math.PI, -90, 90), yawRateDegS: clean(m.yawspeed * 180 / Math.PI) }, "ATTITUDE", now);
    } else if (m instanceof common.VfrHud) {
      this.put({ airspeedKt: range(m.airspeed, 0, 1000) === null ? null : m.airspeed * 1.9438444924406, groundspeedKt: range(m.groundspeed, 0, 1000) === null ? null : m.groundspeed * 1.9438444924406,
        altitudeFt: clean(m.alt * 3.2808398950131), verticalSpeedFpm: clean(m.climb * 196.85039370079), headingDeg: range(m.heading, 0, 360), throttlePercent: range(m.throttle, 0, 100) }, "VFR_HUD (estimated MSL altitude)", now);
    } else if (m instanceof ardupilotmega.Wind && isPlane(identity)) {
      // ArduPlane reports a signed true-north FROM bearing (atan2(-east,-north)).
      this.wind = range(m.direction, -360, 360) !== null && range(m.speed, 0, 1000) !== null
        ? { directionFromDeg: (m.direction + 360) % 360, speedKt: m.speed * 1.9438444924406, at: now } : null;
    } else if (m instanceof common.GlobalPositionInt) {
      this.put({ latitude: range(m.lat / 1e7, -90, 90), longitude: range(m.lon / 1e7, -180, 180), globalAltitudeM: m.alt / 1000, relativeAltitudeM: m.relativeAlt / 1000,
        trackDeg: Math.hypot(m.vx, m.vy) >= 50 ? (Math.atan2(m.vy, m.vx) * 180 / Math.PI + 360) % 360 : null }, "GLOBAL_POSITION_INT (fused position)", now);
    } else if (m instanceof common.GpsRawInt) {
      this.put({ fixType: m.fixType, satellites: m.satellitesVisible === 255 ? null : m.satellitesVisible, gpsAltitudeM: m.fixType >= 3 ? m.alt / 1000 : null }, "GPS_RAW_INT (MSL altitude)", now, 5000);
    } else if (m instanceof common.SysStatus) {
      this.put({ batteryV: m.voltageBattery === 65535 ? null : m.voltageBattery / 1000, currentA: m.currentBattery === -1 ? null : m.currentBattery / 100, batteryPercent: m.batteryRemaining === -1 ? null : range(m.batteryRemaining, 0, 100) }, "SYS_STATUS", now, 5000);
    } else if (m instanceof common.HomePosition) {
      if (positionValid(m.latitude / 1e7, m.longitude / 1e7)) this.home = { value: { lat: m.latitude / 1e7, lon: m.longitude / 1e7, alt: m.altitude / 1000 }, at: now };
    } else if (m instanceof common.PositionTargetGlobalInt) {
      const value = positionValid(m.latInt / 1e7, m.lonInt / 1e7) && Number.isFinite(m.alt) && [0, 3, 5, 6, 10, 11].includes(m.coordinateFrame) && !(m.typeMask & 7)
        ? { lat: m.latInt / 1e7, lon: m.lonInt / 1e7, alt: m.alt, frame: m.coordinateFrame } : null;
      if (JSON.stringify(value) !== JSON.stringify(this.target?.value ?? null)) this.clearGuidance();
      this.target = value ? { value, at: now } : null;
    } else if (m instanceof common.NavControllerOutput) {
      const valid = [m.navRoll, m.navPitch, m.xtrackError, m.navBearing, m.targetBearing, m.wpDist].every(Number.isFinite) && Math.abs(m.navRoll) <= 180 && Math.abs(m.navPitch) <= 90 && m.wpDist >= 0 && m.wpDist < 65535;
      if (!valid) { this.clearGuidance(); return; }
      this.put({ navRollDeg: m.navRoll, navPitchDeg: m.navPitch }, "NAV_CONTROLLER_OUTPUT", now);
      const lat = this.value("latitude", now), lon = this.value("longitude", now);
      this.nav = { at: now, value: { crossTrackM: m.xtrackError, navBearingDeg: (m.navBearing + 360) % 360, targetBearingDeg: (m.targetBearing + 360) % 360, waypointDistanceM: m.wpDist,
        missionSeq: currentSeq, mode: this.value("mode", now) as string | null, autopilotId: identity.autopilot, vehicleType: identity.vehicleType,
        position: typeof lat === "number" && typeof lon === "number" ? { latitude: lat, longitude: lon } : null,
        positionTarget: this.target && now - this.target.at < 2000 ? { ...this.target.value } : null } };
    }
  }
  snapshot(now: number, connected: boolean, identity: VehicleIdentity | null): FlightTelemetry {
    const values: Record<string, unknown> = {}, fields: Record<string, FieldValidity> = {};
    for (const key of KEYS) {
      const s = this.values.get(key), valid = connected && !!s && this.value(key, now) !== null;
      values[key] = valid ? s!.value : null;
      fields[key] = { source: s?.source ?? "Not received", receivedAt: s?.at ?? null, ageMs: s ? now - s.at : null, valid, ...(!valid ? { reason: !connected ? "Autopilot heartbeat unavailable" : s ? "Invalid or stale sample" : "Not received" } : {}) };
    }
    const nav = connected && this.nav && now - this.nav.at < 2000 ? { ...this.nav.value, ageMs: now - this.nav.at } : null;
    const target = connected && this.target && now - this.target.at < 2000 ? { ...this.target.value, ageMs: now - this.target.at } : null;
    const ready = connected && ["rollDeg", "pitchDeg", "airspeedKt", "altitudeFt", "verticalSpeedFpm", "latitude", "longitude"].every(k => fields[k].valid);
    const fdReady = connected && isPlane(identity) && nav !== null && [5, 6, 7, 10, 11, 12, 15].includes(values.customMode as number) && nav.mode === values.mode && fields.rollDeg.valid && fields.pitchDeg.valid;
    const at = Math.max(...[...this.values.values()].map(s => s.at));
    const wind = connected && this.wind && now >= this.wind.at && now - this.wind.at < 5000
      ? { directionFromDeg: this.wind.directionFromDeg, speedKt: this.wind.speedKt, ageMs: now - this.wind.at, source: "WIND" as const } : null;
    return { ...values, source: "MAVLink", ready, ageMs: Number.isFinite(at) ? now - at : null, fdReady,
      navRollDeg: fdReady ? values.navRollDeg : null, navPitchDeg: fdReady ? values.navPitchDeg : null,
      navController: nav, positionTarget: target, homePosition: connected && this.home ? { ...this.home.value } : null, wind, fields } as FlightTelemetry;
  }
}
