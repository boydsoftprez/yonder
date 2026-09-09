// SPDX-License-Identifier: GPL-3.0-or-later
// Port of the working cockpit's traffic_feed.py; timestamps are observations.
import { boundedFetch, DataFetchError } from "./fetch.js";
export interface TrafficCenter {
  lat: number;
  lon: number;
  radiusNm: number;
}
export interface TrafficPoint {
  lat: number;
  lon: number;
  altitudeMslM: number | null;
  observedAtMs: number;
  breakBefore: boolean;
}
export interface TrafficTrack extends Omit<TrafficPoint, "breakBefore"> {
  id: string;
  callSign: string | null;
  registration: string | null;
  aircraftType: string | null;
  sourceType: string | null;
  altitudeBaroFt: number | null;
  altitudeGeomFt: number | null;
  altitudeSource: string | null;
  ground: boolean;
  groundspeedKt: number | null;
  trackDeg: number | null;
  verticalSpeedFpm: number | null;
  history: TrafficPoint[];
}
interface Options {
  now?: () => number;
  geoid?: { undulation: (lat: number, lon: number) => number };
  fetcher?: (center: TrafficCenter, signal: AbortSignal) => Promise<unknown>;
}
const n = (value: unknown, min = -Infinity, max = Infinity): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
    ? value
    : null;
const txt = (value: unknown, max = 32) =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, max) || null
    : null;
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const TTL = 60000,
  STALE = 15000,
  HISTORY = 300000,
  MAX_TRACKS = 128,
  MAX_HISTORY = 150;
export function distance(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const r = Math.PI / 180,
    h =
      Math.sin(((b.lat - a.lat) * r) / 2) ** 2 +
      Math.cos(a.lat * r) *
        Math.cos(b.lat * r) *
        Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
function validCenter(c: TrafficCenter) {
  if (
    n(c.lat, -90, 90) === null ||
    n(c.lon, -180, 180) === null ||
    !Number.isInteger(c.radiusNm)||c.radiusNm<1||c.radiusNm>100
  )
    throw new Error("Invalid traffic region");
}
export class TrafficFeed {
  private readonly now: () => number;
  private readonly fetcher: NonNullable<Options["fetcher"]>;
  private readonly geoid: Options["geoid"];
  private tracks = new Map<string, TrafficTrack>();
  private breaks = new Set<string>();
  private controller = new AbortController();
  private received: number | null = null;
  private source: number | null = null;
  private retry: number | null = null;
  private error: string | null = null;
  private next = 0;
  private failures = 0;
  private active: Promise<void> | null = null;
  private closed = false;
  constructor(options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.geoid = options.geoid;
    this.fetcher =
      options.fetcher ??
      (async (c, signal) =>
        JSON.parse(
          (
            await boundedFetch(
              `https://api.adsb.lol/v2/point/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}/${c.radiusNm}`,
              4 * 1024 * 1024,
              signal,
            )
          ).bytes.toString("utf8"),
        ));
  }
  private normalize(value: unknown, source: number): TrafficTrack | null {
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
    let msl: number | null = null;
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
  private expire() {
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
  ingest(payload: unknown, center: TrafficCenter): void {
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
    const rows: TrafficTrack[] = [];
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
      const point: TrafficPoint = {
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
    for (const id of this.breaks) if (!this.tracks.has(id)) this.breaks.delete(id);
    this.received = now;
    this.source = source;
    this.error = null;
    this.failures = 0;
    this.retry = null;
  }
  snapshot(center: TrafficCenter | null) {
    this.expire();
    const now = this.now(),
      status = this.error
        ? "error"
        : this.received === null
          ? "loading"
          : now - this.received >= STALE || now - this.source! >= STALE
            ? "stale"
            : "live";
    return {
      provider: "ADSB.lol",
      sourceUrl: "https://www.adsb.lol/docs/open-data/api/",
      license: "ODbL-1.0",
      attribution: "Traffic © ADSB.lol contributors · ODbL 1.0",
      status,
      message:
        this.error ??
        (status === "live"
          ? "Observed internet traffic · coverage and latency vary"
          : status === "stale"
            ? "Traffic feed is stale"
            : "Waiting for public traffic"),
      receivedAtMs: this.received,
      sourceAtMs: this.source,
      retryAtMs: this.retry,
      center,
      altitudeModel: this.geoid ? "EGM96-5" : null,
      tracks: center
        ? [...this.tracks.values()]
            .filter((t) => distance(center, t) <= center.radiusNm * 1852)
            .sort((a, b) => distance(center, a) - distance(center, b))
            .map((t) => ({ ...t, history: t.history.map((p) => ({ ...p })) }))
        : [],
    };
  }
  async poll(center: TrafficCenter): Promise<void> {
    validCenter(center);
    if (this.closed || this.now() < this.next) return;
    if (this.active) return this.active;
    this.next = this.now() + 2000;
    const controller=this.controller;
    this.active = (async () => {
      try {
        const value = await this.fetcher(center, controller.signal);
        if (!this.closed&&!controller.signal.aborted) this.ingest(value, center);
      } catch (error) {
        if (this.closed||controller.signal.aborted) return;
        this.failures = Math.min(10, this.failures + 1);
        this.retry =
          this.now() +
          Math.max(
            2000,
            Math.min(120000, 2 ** this.failures * 1000),
            error instanceof DataFetchError ? error.retryMs : 0,
          );
        this.next = this.retry;
        this.error =
          error instanceof DataFetchError
            ? error.message
            : "ADSB.lol connection or response error";
      } finally {
        if(controller===this.controller)this.active = null;
      }
    })();
    return this.active;
  }
  /** Stop an optional source immediately without losing service ownership. */
  pause() {
    this.controller.abort();this.controller=new AbortController();this.active=null;this.next=0;
    this.tracks.clear();this.breaks.clear();this.received=null;this.source=null;
  }
  close() {
    this.closed = true;
    this.controller.abort();
    this.tracks.clear();
    this.breaks.clear();
  }
}
