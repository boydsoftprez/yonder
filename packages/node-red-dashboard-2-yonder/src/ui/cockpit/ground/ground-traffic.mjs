// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-11: browser port of core cockpit/traffic.ts; observations, limits and datum rules preserved.
import { DataFetchError } from "./ground-utils.mjs";
const n = (value, min = -Infinity, max = Infinity) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
    ? value
    : null;
const txt = (value, max = 32) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, max) || null
    : null;
const record = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
const TTL = 60000,
  STALE = 15000,
  HISTORY = 300000,
  MAX_TRACKS = 128,
  MAX_HISTORY = 150;
export function distance(a, b) {
  const r = Math.PI / 180,
    h =
      Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
      Math.cos(a.lat * r) *
        Math.cos(b.lat * r) *
        Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
function validCenter(c) {
  if (
    n(c.lat, -90, 90) === null ||
    n(c.lon, -180, 180) === null ||
    !Number.isInteger(c.radiusNm) ||
    c.radiusNm < 1 ||
    c.radiusNm > 100
  )
    throw new Error("Invalid traffic region");
}
export class TrafficFeed {
  pollInterval = 5000;
  now;
  fetcher;
  geoid;
  tracks = new Map();
  breaks = new Set();
  controller = new AbortController();
  received = null;
  source = null;
  retry = null;
  error = null;
  next = 0;
  failures = 0;
  active = null;
  closed = false;
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.geoid = options.geoid;
    this.fetcher =
      options.fetcher ??
      (async () => {
        throw new Error("Ground traffic fetcher unavailable");
      });
  }
  normalize(value, source) {
    const raw = record(value);
    if (!raw) return null;
    const lat = n(raw.lat, -90, 90),
      lon = n(raw.lon, -180, 180),
      age = n(raw.seen_pos, 0, 86400);
    if (
      typeof raw.hex !== "string" ||
      !/^~?[a-f\d]{6}$/i.test(raw.hex) ||
      lat === null ||
      lon === null ||
      age === null ||
      this.now() - (source - age * 1000) >= TTL
    )
      return null;
    const geom = n(raw.alt_geom, -2000, 100000);
    let msl = null;
    if (geom !== null && this.geoid) {
      try {
        const correction = n(this.geoid.undulation(lat, lon), -150, 150);
        if (correction !== null) msl = geom * 0.3048 - correction;
      } catch {
        /* Map-only when datum is unavailable. */
      }
    }
    return {
      id: raw.hex.toLowerCase(),
      lat,
      lon,
      altitudeMslM: msl,
      observedAtMs: source - age * 1000,
      history: [],
      callSign: txt(raw.flight, 16),
      registration: txt(raw.r, 16),
      aircraftType: txt(raw.t, 16),
      sourceType: txt(raw.type),
      altitudeBaroFt: n(raw.alt_baro, -2000, 100000),
      altitudeGeomFt: geom,
      altitudeSource: msl === null ? null : "WGS84/EGM96",
      ground: raw.alt_baro === "ground",
      groundspeedKt: n(raw.gs, 0, 2000),
      trackDeg: n(raw.track, 0, 360),
      verticalSpeedFpm:
        n(raw.geom_rate, -20000, 20000) ?? n(raw.baro_rate, -20000, 20000),
    };
  }
  expire() {
    const now = this.now();
    for (const [id, t] of this.tracks) {
      if (now - t.observedAtMs >= TTL) {
        this.tracks.delete(id);
        this.breaks.delete(id);
      } else
        t.history = t.history
          .filter((p) => now - p.observedAtMs <= HISTORY)
          .slice(-MAX_HISTORY);
    }
  }
  ingest(payload, center) {
    validCenter(center);
    const data = record(payload),
      now = this.now();
    let source = n(data?.now, 1e9, 1e14);
    if (
      !data ||
      !Array.isArray(data.ac) ||
      data.ac.length > 10000 ||
      source === null
    )
      throw new Error("Invalid traffic response");
    if (source < 1e11) source *= 1000;
    if (source > now + 5000) throw new Error("Future traffic timestamp");
    source = Math.min(source, now);
    this.expire();
    const rows = [];
    for (const raw of data.ac) {
      const track = this.normalize(raw, source);
      if (track && distance(center, track) <= center.radiusNm * 1852)
        rows.push(track);
      else {
        const hex = record(raw)?.hex;
        if (typeof hex === "string" && this.tracks.has(hex.toLowerCase()))
          this.breaks.add(hex.toLowerCase());
      }
    }
    rows.sort((a, b) => distance(center, a) - distance(center, b));
    for (const track of rows.slice(0, MAX_TRACKS)) {
      const old = this.tracks.get(track.id);
      if (old && track.observedAtMs <= old.observedAtMs) continue;
      const history = old?.history.slice() ?? [],
        previous = history.at(-1),
        pending = this.breaks.has(track.id);
      const point = {
        lat: track.lat,
        lon: track.lon,
        altitudeMslM: track.altitudeMslM,
        observedAtMs: track.observedAtMs,
        breakBefore: !previous || pending,
      };
      if (previous) {
        const delta = (point.observedAtMs - previous.observedAtMs) / 1000;
        point.breakBefore ||=
          delta > 30 || distance(previous, point) > Math.max(3000, delta * 772);
        if (previous.altitudeMslM !== null && point.altitudeMslM !== null)
          point.breakBefore ||=
            Math.abs(previous.altitudeMslM - point.altitudeMslM) >
            Math.max(1000, delta * 150);
      }
      if (
        !previous ||
        pending ||
        point.lat !== previous.lat ||
        point.lon !== previous.lon ||
        point.altitudeMslM !== previous.altitudeMslM
      )
        history.push(point);
      track.history = history.slice(-MAX_HISTORY);
      this.breaks.delete(track.id);
      this.tracks.set(track.id, track);
    }
    this.tracks = new Map(
      [...this.tracks.values()]
        .sort((a, b) => distance(center, a) - distance(center, b))
        .slice(0, MAX_TRACKS)
        .map((t) => [t.id, t]),
    );
    for (const id of this.breaks)
      if (!this.tracks.has(id)) this.breaks.delete(id);
    this.received = now;
    this.source = source;
    this.error = null;
    this.failures = 0;
    this.retry = null;
  }
  snapshot(center) {
    this.expire();
    const now = this.now(),
      status = this.error
        ? "error"
        : this.received === null
          ? "loading"
          : now - this.received >= STALE || now - this.source >= STALE
            ? "stale"
            : "live";
    const tracks = center
      ? [...this.tracks.values()]
          .filter((t) => distance(center, t) <= center.radiusNm * 1852)
          .sort((a, b) => distance(center, a) - distance(center, b))
          .map((t) => ({ ...t, history: t.history.map((p) => ({ ...p })) }))
      : [];
    return {
      provider: "ADSB.lol",
      sourceUrl: "https://www.adsb.lol/docs/open-data/api/",
      license: "ODbL-1.0",
      attribution: "Traffic © ADSB.lol contributors · ODbL 1.0",
      status,
      message:
        this.error ??
        (status === "live"
          ? `ADSB.lol · ${tracks.length ? `${tracks.length} target${tracks.length === 1 ? '' : 's'} observed` : 'No targets reported'} within ${center?.radiusNm ?? '—'} NM`
          : status === "stale"
            ? "Traffic feed is stale"
            : "Waiting for public traffic"),
      receivedAtMs: this.received,
      sourceAtMs: this.source,
      retryAtMs: this.retry,
      center,
      altitudeModel: this.geoid ? "EGM96-5" : null,
      tracks,
    };
  }
  async poll(center) {
    validCenter(center);
    if (this.closed || this.now() < this.next) return;
    if (this.active) return this.active;
    this.next = this.now() + this.pollInterval;
    this.active = (async () => {
      try {
        const value = await this.fetcher(center, this.controller.signal);
        if (!this.closed) this.ingest(value, center);
      } catch (error) {
        if (this.closed) return;
        this.failures = Math.min(10, this.failures + 1);
        this.retry =
          this.now() +
          Math.max(
            this.pollInterval,
            Math.min(120000, 2 ** this.failures * 1000),
            error instanceof DataFetchError ? error.retryMs : 0,
          );
        this.next = this.retry;
        this.error =
          error instanceof DataFetchError
            ? error.message
            : "ADSB.lol connection or response error";
      } finally {
        this.active = null;
      }
    })();
    return this.active;
  }
  close() {
    this.closed = true;
    this.controller.abort();
    this.tracks.clear();
    this.breaks.clear();
  }
}
