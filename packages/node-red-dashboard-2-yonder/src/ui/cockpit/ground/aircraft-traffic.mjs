// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-11: aircraft mode transfers current points; observed trails stay in this browser.
import { TrafficFeed } from "./ground-traffic.mjs";
const finite = (v, min, max) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max
    ? v
    : null;
const text = (v) =>
  typeof v === "string"
    ? v.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64)
    : null;
export class AircraftTrafficFeed extends TrafficFeed {
  normalize(raw) {
    if (
      !raw ||
      typeof raw !== "object" ||
      !/^~?[a-f\d]{6}$/i.test(raw.id) ||
      finite(raw.lat, -90, 90) === null ||
      finite(raw.lon, -180, 180) === null ||
      finite(raw.observedAtMs, 1e9, this.now() + 5000) === null ||
      this.now() - raw.observedAtMs >= 60000
    )
      return null;
    const altitudeMslM =
      raw.altitudeSource === "WGS84/EGM96"
        ? finite(raw.altitudeMslM, -1000, 35000)
        : null;
    return {
      id: raw.id.toLowerCase(),
      lat: raw.lat,
      lon: raw.lon,
      observedAtMs: Math.min(this.now(), raw.observedAtMs),
      altitudeMslM,
      altitudeSource: altitudeMslM === null ? null : "WGS84/EGM96",
      history: [],
      callSign: text(raw.callSign),
      registration: text(raw.registration),
      aircraftType: text(raw.aircraftType),
      sourceType: text(raw.sourceType),
      altitudeBaroFt: finite(raw.altitudeBaroFt, -2000, 100000),
      altitudeGeomFt: finite(raw.altitudeGeomFt, -2000, 100000),
      ground: raw.ground === true,
      groundspeedKt: finite(raw.groundspeedKt, 0, 2000),
      trackDeg: finite(raw.trackDeg, 0, 360),
      verticalSpeedFpm: finite(raw.verticalSpeedFpm, -20000, 20000),
    };
  }
  ingest(report, center) {
    if (!report || !Array.isArray(report.tracks) || report.tracks.length > 128)
      throw new Error("Invalid aircraft traffic response");
    this.report = report;
    super.ingest(
      { now: report.sourceAtMs ?? this.now(), ac: report.tracks },
      center,
    );
  }
  snapshot(center) {
    const result = super.snapshot(center);
    result.altitudeModel =
      this.report?.altitudeModel === "EGM96-5" ? "EGM96-5" : null;
    if (
      result.status !== "error" && this.report &&
      ["disabled", "unavailable", "error", "loading", "stale"].includes(this.report.status)
    ) {
      result.status = this.report.status;
      result.message =
        text(this.report.message) || "Aircraft traffic unavailable";
      if (["disabled", "unavailable", "loading"].includes(result.status)) result.tracks = [];
    }
    return result;
  }
}
