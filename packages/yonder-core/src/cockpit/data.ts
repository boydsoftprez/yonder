// SPDX-License-Identifier: GPL-3.0-or-later
import { boundedFetch } from "./fetch.js";
import { GeoidGrid } from "./geoid.js";
import { TrafficFeed, type TrafficCenter } from "./traffic.js";
export interface DataOptions {
  sourceMode: 'ground' | 'offline' | 'aircraft';
  traffic: boolean;
  terrain: boolean;
  imagery: boolean;
  trafficRadiusNm: number;
  cameraId: string | null;
  aircraftDatum: "UNKNOWN" | "EGM96" | "NAVD88" | "WGS84_ELLIPSOID";
}
interface TileReply {
  status: number;
  body: { data?: string; type?: string; error?: string };
}
interface Options {
  fetcher?: typeof boundedFetch;
  now?: () => number;
  traffic?: TrafficFeed;
}
const layers = {
  imagery: "World_Imagery",
  places: "Reference/World_Boundaries_and_Places",
  roads: "Reference/World_Transportation",
} as const;
/** Opt-in, process-local provider data. No background fetches when no cockpit is polling. */
export class CockpitData {
  private settings: DataOptions = {
    sourceMode: 'ground',
    traffic: false,
    terrain: false,
    imagery: false,
    trafficRadiusNm: 25,
    cameraId: null,
    aircraftDatum: "UNKNOWN",
  };
  private readonly fetcher: typeof boundedFetch;
  private readonly now: () => number;
  private readonly feed: TrafficFeed;
  private readonly cache = new Map<
    string,
    { body: TileReply["body"]; bytes: number; at: number }
  >();
  private cacheBytes = 0;
  private readonly pending = new Map<string, Promise<TileReply>>();
  private activeFetches = 0;
  private readonly waiting: ((acquired: boolean) => void)[] = [];
  private abort = new AbortController();
  private closed = false;
  constructor(options: Options = {}) {
    this.fetcher = options.fetcher ?? boundedFetch;
    this.now = options.now ?? Date.now;
    let geoid: GeoidGrid | undefined;
    try {
      geoid = new GeoidGrid();
    } catch {
      /* Feed explicitly reports no altitude model. */
    }
    this.feed = options.traffic ?? new TrafficFeed({ now: this.now, geoid });
  }
  get options(): DataOptions {
    return { ...this.settings };
  }
  configure(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const raw = value as Record<string, unknown>,
      next = { ...this.settings };
    if(raw.sourceMode!==undefined){
      if(!['ground','offline','aircraft'].includes(String(raw.sourceMode)))return false;
      next.sourceMode=raw.sourceMode as DataOptions['sourceMode'];
    }
    for (const key of ["traffic", "terrain", "imagery"] as const)
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "boolean") return false;
        next[key] = raw[key];
      }
    if (raw.trafficRadiusNm !== undefined) {
      if (!Number.isInteger(raw.trafficRadiusNm)||Number(raw.trafficRadiusNm)<1||Number(raw.trafficRadiusNm)>100) return false;
      next.trafficRadiusNm = raw.trafficRadiusNm as number;
    }
    if (raw.cameraId !== undefined) {
      if (
        raw.cameraId !== null &&
        (typeof raw.cameraId !== "string" ||
          !/^[-a-zA-Z0-9_]{1,64}$/.test(raw.cameraId))
      )
        return false;
      next.cameraId = raw.cameraId as string | null;
    }
    if (raw.aircraftDatum !== undefined) {
      if (
        !["UNKNOWN", "EGM96", "NAVD88", "WGS84_ELLIPSOID"].includes(
          String(raw.aircraftDatum),
        )
      )
        return false;
      next.aircraftDatum = raw.aircraftDatum as DataOptions["aircraftDatum"];
    }
    const leavingAircraft = this.settings.sourceMode === 'aircraft' && next.sourceMode !== 'aircraft';
    if (leavingAircraft || (this.settings.terrain && !next.terrain) || (this.settings.imagery && !next.imagery)) {
      // Retire the whole tile batch. A later enablement must not revive its queued requests.
      this.abort.abort();
      this.abort = new AbortController();
      this.waiting.splice(0).forEach(resolve => resolve(false));
    }
    if (leavingAircraft || (this.settings.traffic && !next.traffic)) this.feed.pause();
    this.settings = next;
    return true;
  }
  snapshot(position: {
    lat: number | null;
    lon: number | null;
    valid: boolean;
  }) {
    const center: TrafficCenter | null =
      position.valid &&
      position.lat !== null &&
      position.lon !== null &&
      Number.isFinite(position.lat) &&
      Number.isFinite(position.lon) &&
      Math.abs(position.lat) <= 90 &&
      Math.abs(position.lon) <= 180
        ? {
            lat: position.lat,
            lon: position.lon,
            radiusNm: this.settings.trafficRadiusNm,
          }
        : null;
    if (this.settings.sourceMode==='aircraft' && this.settings.traffic && center && !this.closed)
      void this.feed.poll(center);
    const traffic = this.feed.snapshot(center);
    if (this.settings.sourceMode!=='aircraft'||!this.settings.traffic) {
      traffic.status = "disabled";
      traffic.message = this.settings.sourceMode==='aircraft'?'Public traffic is off':'Public traffic is owned by the ground client';
      traffic.tracks = [];
    } else if (!center) {
      traffic.status = "unavailable";
      traffic.message = "Traffic requires a fresh aircraft position";
      traffic.tracks = [];
    }
    return { dataOptions: this.options, traffic };
  }
  async tile(
    layer: string,
    z: number,
    x: number,
    y: number,
  ): Promise<TileReply> {
    if (
      !["elevation", ...Object.keys(layers)].includes(layer) ||
      ![z, x, y].every(Number.isInteger) ||
      z < 0 ||
      z > 19 ||
      x < 0 ||
      y < 0 ||
      x >= 2 ** z ||
      y >= 2 ** z ||
      (layer === "elevation" && z > 15)
    )
      return { status: 400, body: { error: "Invalid geographic tile" } };
    if (
      this.closed ||
      this.settings.sourceMode!=='aircraft' ||
      !(layer === "elevation" ? this.settings.terrain : this.settings.imagery)
    )
      return {
        status: 403,
        body: { error: "Enable this geographic source in cockpit settings" },
      };
    const key = `${layer}/${z}/${x}/${y}`,
      cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 60000) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { status: 200, body: cached.body };
    }
    if (cached) {
      this.cache.delete(key);
      this.cacheBytes -= cached.bytes;
    }
    const running = this.pending.get(key);
    if (running) return running;
    if (this.pending.size >= 64)
      return {
        status: 429,
        body: { error: "Geographic tiles are busy; retry shortly" },
      };
    // Capture ownership before waiting for a fetch slot, not when the network request starts.
    const controller = this.abort;
    const work = (async (): Promise<TileReply> => {
      const acquired = await this.acquireFetch();
      try {
        if (
          !acquired ||
          this.closed ||
          controller.signal.aborted ||
          this.settings.sourceMode!=='aircraft' ||
          !(layer === "elevation"
            ? this.settings.terrain
            : this.settings.imagery)
        )
          return {
            status: 403,
            body: { error: "Geographic source is disabled" },
          };
        const url =
          layer === "elevation"
            ? `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
            : `https://server.arcgisonline.com/ArcGIS/rest/services/${layers[layer as keyof typeof layers]}/MapServer/tile/${z}/${y}/${x}`;
        const { bytes, type } = await this.fetcher(
          url,
          512 * 1024,
          controller.signal,
        );
        // A provider completion may race abort; obsolete responses cannot be served or cached.
        if (this.closed || controller.signal.aborted)
          return { status: 403, body: { error: "Geographic source was disabled or changed" } };
        const png = bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
          jpeg = bytes[0] === 255 && bytes[1] === 216;
        if (
          !(
            (png && type === "image/png") ||
            (jpeg && (type === "image/jpeg" || type === "image/jpg"))
          )
        )
          throw new Error("Provider did not return an image");
        const body = {
          data: bytes.toString("base64"),
          type: png ? "image/png" : "image/jpeg",
        };
        // Short memory reuse for a live view, not an offline imagery export.
        while (
          this.cache.size >= 128 ||
          this.cacheBytes + bytes.length > 32 * 1024 * 1024
        ) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cacheBytes -= this.cache.get(oldest)!.bytes;
          this.cache.delete(oldest);
        }
        if (!this.closed) {
          this.cache.set(key, { body, bytes: bytes.length, at: this.now() });
          this.cacheBytes += bytes.length;
        }
        return { status: 200, body };
      } catch {
        return {
          status: this.closed || controller.signal.aborted ? 403 : 502,
          body: { error: this.closed || controller.signal.aborted ? "Geographic source was disabled or changed" : "Geographic source unavailable" },
        };
      } finally {
        this.pending.delete(key);
        if (acquired) this.releaseFetch();
      }
    })();
    this.pending.set(key, work);
    return work;
  }
  private acquireFetch(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.activeFetches < 8) {
      this.activeFetches++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }
  private releaseFetch() {
    const next = this.waiting.shift();
    if (next) next(true);
    else this.activeFetches--;
  }
  close() {
    this.closed = true;
    this.abort.abort();
    this.waiting.splice(0).forEach((resolve) => resolve(false));
    this.feed.close();
    this.cache.clear();
    this.cacheBytes = 0;
  }
}
