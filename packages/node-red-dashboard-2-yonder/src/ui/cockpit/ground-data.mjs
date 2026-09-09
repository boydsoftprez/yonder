// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-11: the ground browser owns public data; aircraft proxying is explicit.
import {
  validateTerrainManifest,
  decodeTerrainTile,
} from "yonder-core/terrain";
import { TrafficFeed } from "./ground/ground-traffic.mjs";
import { AircraftTrafficFeed } from "./ground/aircraft-traffic.mjs";
import {
  ByteCache,
  DataFetchError,
  imageType,
  readBytes,
  signals,
  validTile,
} from "./ground/ground-utils.mjs";
import {
  createOfflineStore,
  importTerrain,
  importMap,
  inflateTerrain,
} from "./ground/offline-store.mjs";
import { importGroundGeoid } from "./ground/ground-geoid.mjs";
const layers = {
  imagery: "World_Imagery",
  places: "Reference/World_Boundaries_and_Places",
  roads: "Reference/World_Transportation",
};
export const GROUND_DATA_DEFAULTS = Object.freeze({
  mode: "ground",
  terrain: false,
  imagery: false,
  traffic: false,
  trafficRadiusNm: 25,
  groundRelayUrl: "",
  trafficRelayUrl: "",
});
export function publicTileUrl(layer, z, x, y) {
  validTile(layer, z, x, y);
  return layer === "elevation"
    ? `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
    : `https://server.arcgisonline.com/ArcGIS/rest/services/${layers[layer]}/MapServer/tile/${z}/${y}/${x}`;
}
const disabledTraffic = (status, message) => ({
  provider: "ADSB.lol",
  sourceUrl: "https://www.adsb.lol/docs/open-data/api/",
  license: "ODbL-1.0",
  attribution: "Traffic © ADSB.lol contributors · ODbL 1.0",
  status,
  message,
  tracks: [],
  altitudeModel: null,
});
export function createGroundDataProvider({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  storage = createOfflineStore(),
  maxCacheBytes = 32 * 1024 * 1024,
  maxTerrainCacheBytes = 16 * 1024 * 1024,
  maxTerrainPackedBytes = 16 * 1024 * 1024,
} = {}) {
  let settings = { ...GROUND_DATA_DEFAULTS },
    controller = new AbortController(),
    closed = false,
    revision = 0,
    active = 0,
    error = null,
    terrainInfo = null,
    streamManifest = null,
    mapInfo = null,
    geoid = null,
    feed;
  const cache = new ByteCache(maxCacheBytes),
    decoded = new ByteCache(maxTerrainCacheBytes, 128),
    terrainPacked = new ByteCache(maxTerrainPackedBytes, 128),
    terrainPending = new Map(),
    listeners = new Set(),
    waiters = [];
  const notify = () => {
    revision++;
    streamManifest = null;
    for (const entry of terrainPending.values()) entry.linked.abort();
    terrainPending.clear();
    for (const fn of listeners) fn(revision);
  };
  const aborted = () => new DOMException("Aborted", "AbortError");
  function currentTerrain(generation, signal) {
    if (closed || generation !== revision || signal?.aborted) throw aborted();
  }
  // A renderer and a lookahead load can share one transfer. Each caller can
  // cancel its own wait; the transfer stops when its last consumer leaves.
  function shareTerrain(key, signal, run) {
    const generation = revision;
    currentTerrain(generation, signal);
    key = generation + "/" + key;
    let entry = terrainPending.get(key);
    if (!entry) {
      if (terrainPending.size >= 70)
        throw new Error("Ground terrain request queue full");
      entry = { linked: signals(controller.signal), users: 0, done: false };
      terrainPending.set(key, entry);
      entry.promise = Promise.resolve()
        .then(() => {
          currentTerrain(generation, entry.linked.signal);
          return run(entry.linked.signal, generation);
        })
        .finally(() => {
          entry.done = true;
          entry.linked.dispose();
          if (terrainPending.get(key) === entry) terrainPending.delete(key);
        });
    }
    return new Promise((resolve, reject) => {
      const linked = signals(entry.linked.signal, signal);
      let settled = false;
      entry.users++;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        linked.signal.removeEventListener("abort", abort);
        linked.dispose();
        entry.users--;
        if (!entry.users && !entry.done) {
          entry.linked.abort();
          if (terrainPending.get(key) === entry) terrainPending.delete(key);
        }
        fn(value);
      };
      const abort = () => finish(reject, aborted());
      linked.signal.addEventListener("abort", abort, { once: true });
      entry.promise.then(
        (value) => finish(resolve, value),
        (reason) => finish(reject, reason),
      );
      if (linked.signal.aborted) abort();
    });
  }
  function groundTerrainManifest(signal) {
    currentTerrain(revision, signal);
    if (streamManifest) return Promise.resolve(streamManifest);
    const origin = settings.groundRelayUrl;
    return shareTerrain("manifest", signal, async (requestSignal, generation) => {
      const result = await request(
        origin + "/terrain/manifest", 4 * 1024 * 1024, requestSignal,
      );
      const manifest = validateTerrainManifest(JSON.parse(new TextDecoder().decode(result.bytes)));
      currentTerrain(generation, requestSignal);
      // Descriptors also supply fetch/inflate limits: callers cannot mutate
      // the validated cached list into an arbitrary file request.
      for (const tile of manifest.tiles) Object.freeze(tile);
      Object.freeze(manifest.tiles);
      streamManifest = Object.freeze(manifest);
      return streamManifest;
    });
  }
  async function groundTerrainTile(descriptor, signal) {
    const generation = revision,
      origin = settings.groundRelayUrl,
      manifest = await groundTerrainManifest(signal);
    currentTerrain(generation, signal);
    const tile = manifest.tiles.find((candidate) => candidate.id === descriptor?.id);
    if (!tile || Object.keys(tile).some((field) => tile[field] !== descriptor[field]))
      throw new Error("Terrain descriptor does not match the selected manifest");
    const key = origin + "/" + tile.id + "/" + tile.sha256,
      cached = decoded.get(key);
    if (cached) return cached.slice();
    const raw = await shareTerrain(key, signal, async (requestSignal, requestGeneration) => {
      let packed = terrainPacked.get(key), value;
      if (!packed) {
        // One keyed read, without scanning or copying the complete import.
        // A previous pack can share tiles even when the relay pack expanded.
        const imported = await storage.get("terrain/tile/" + tile.id).catch(() => null);
        currentTerrain(requestGeneration, requestSignal);
        if (imported) {
          try {
            value = await inflateTerrain(imported, tile);
            packed = imported;
          } catch {
            // A stale/corrupt imported file is not the selected relay tile.
          }
          currentTerrain(requestGeneration, requestSignal);
        }
      }
      if (!packed) {
        packed = (await request(
          origin + "/terrain/files/" + encodeURIComponent(tile.file),
          tile.bytes, requestSignal,
        )).bytes;
      }
      value ??= await inflateTerrain(packed, tile);
      currentTerrain(requestGeneration, requestSignal);
      terrainPacked.put(key, packed, packed.length);
      decoded.put(key, value, value.length);
      return value;
    });
    currentTerrain(generation, signal);
    return raw.slice();
  }
  function acquire(signal) {
    if (signal.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (active < 6) {
      active++;
      return Promise.resolve();
    }
    if (waiters.length >= 64)
      return Promise.reject(new Error("Ground request queue full"));
    return new Promise((ok, no) => {
      const entry = {
        ok: () => {
          signal.removeEventListener("abort", abort);
          active++;
          ok();
        },
        no,
      };
      const abort = () => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        no(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      waiters.push(entry);
    });
  }
  function release() {
    active--;
    waiters.shift()?.ok();
  }
  async function request(url, limit, signal, geographic = true) {
    // Traffic has its own feed lifetime. Range or traffic opt-out must not
    // cancel geographic transfers, and map opt-out need not cancel traffic.
    const linked = signals(geographic ? controller.signal : null, signal),
      timer = setTimeout(linked.abort, 12000);
    let acquired = false;
    try {
      await acquire(linked.signal);
      acquired = true;
      if (linked.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const response = await fetchImpl(url, {
        signal: linked.signal,
        credentials: settings.mode === "aircraft" ? "same-origin" : "omit",
        mode: "cors",
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel();
        const retry = response.headers.get("retry-after"),
          seconds = retry ? (/^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry)-now())/1000) : NaN;
        throw new DataFetchError(
          response.status === 429 ? `${settings.mode} data rate limited · retrying automatically (HTTP 429)` : `${settings.mode} data HTTP ${response.status}`,
          Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : response.status === 429 ? 60000 : 0,
        );
      }
      const bytes = await readBytes(response, limit);
      if (linked.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      return {
        bytes,
        type: response.headers.get("content-type")?.split(";")[0] || "",
      };
    } finally {
      clearTimeout(timer);
      linked.dispose();
      if (acquired) release();
    }
  }
  const groundUrl = (path, direct) =>
    settings.groundRelayUrl ? settings.groundRelayUrl + path : direct;
  function makeFeed() {
    if (settings.mode === "aircraft")
      return new AircraftTrafficFeed({
        now,
        fetcher: async (_c, signal) => {
          const r = await request(
            "/cockpit/api/traffic",
            1024 * 1024,
            signal,
            false,
          );
          const reply = JSON.parse(new TextDecoder().decode(r.bytes));
          return reply.traffic ?? reply;
        },
      });
    return new TrafficFeed({
      now,
      geoid,
      fetcher: async (c, signal) => {
        const path = `/traffic/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}/${c.radiusNm}`;
        let result;
        try { result = await request(
            (settings.trafficRelayUrl || settings.groundRelayUrl)
              ? (settings.trafficRelayUrl || settings.groundRelayUrl) + path
              : `https://api.adsb.lol/v2/point/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}/${c.radiusNm}`,
          4 * 1024 * 1024,
          signal,
          false,
        ); } catch (error) {
          if (error instanceof TypeError)
            throw new DataFetchError(settings.trafficRelayUrl || settings.groundRelayUrl
              ? 'Ground traffic relay connection failed · check the relay address and allowed browser origin'
              : 'ADSB.lol browser connection failed · check ground internet or select a ground relay for browser access');
          throw error;
        }
        return JSON.parse(new TextDecoder().decode(result.bytes));
      },
    });
  }
  feed = makeFeed();
  const provider = {
    get revision() {
      return revision;
    },
    get options() {
      return { ...settings };
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    configure(value) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid ground source options");
      const next = { ...settings };
      for (const key of ["terrain", "imagery", "traffic"])
        if (value[key] !== undefined) {
          if (typeof value[key] !== "boolean")
            throw new Error("Invalid source flag");
          next[key] = value[key];
        }
      if (value.mode !== undefined) {
        if (!["ground", "offline", "aircraft"].includes(value.mode))
          throw new Error("Invalid source mode");
        next.mode = value.mode;
      }
      if (value.trafficRadiusNm !== undefined) {
        if (
          !Number.isInteger(value.trafficRadiusNm) ||
          value.trafficRadiusNm < 1 ||
          value.trafficRadiusNm > 100
        )
          throw new Error("Invalid traffic radius");
        next.trafficRadiusNm = value.trafficRadiusNm;
      }
      for (const key of ['groundRelayUrl', 'trafficRelayUrl']) if (value[key] !== undefined) {
        if (typeof value[key] !== "string")
          throw new Error("Invalid ground relay URL");
        const raw = value[key].trim();
        if (raw) {
          const u = new URL(raw);
          if (
            !["http:", "https:"].includes(u.protocol) ||
            u.username ||
            u.password ||
            u.search ||
            u.hash ||
            u.pathname !== "/" ||
            /\/cockpit/.test(raw)
          )
            throw new Error("Use the origin of an operator-owned ground relay");
          next[key] = u.origin;
        } else next[key] = "";
      }
      const geographicChanged = [
        "mode",
        "groundRelayUrl",
        "terrain",
        "imagery",
      ].some((key) => next[key] !== settings[key]);
      const trafficChanged = [
        "mode",
        "groundRelayUrl",
        "trafficRelayUrl",
        "traffic",
        "trafficRadiusNm",
      ].some((key) => next[key] !== settings[key]);
      if (trafficChanged) feed.close();
      settings = next;
      if (trafficChanged) feed = makeFeed();
      if (geographicChanged) {
        controller.abort();
        controller = new AbortController();
        cache.clear();
        decoded.clear();
        terrainPacked.clear();
        error = null;
        notify();
      }
      return provider.options;
    },
    async tile(layer, z, x, y, { signal } = {}) {
      validTile(layer, z, x, y);
      if (
        closed ||
        !(layer === "elevation" ? settings.terrain : settings.imagery)
      )
        throw new Error("Geographic source disabled");
      const generation = revision,
        key = [settings.mode, layer, z, x, y].join("/"),
        cached = cache.get(key, now());
      if (cached) return cached;
      try {
        let bytes, type;
        if (settings.mode === "offline") {
          const file = await storage.get(
            "map/tile/" + [layer, z, x, y].join("/"),
          );
          if (!file) throw new Error("Offline map tile unavailable");
          ({ bytes, type } = file);
        } else {
          const path = `/tiles/${layer}/${z}/${x}/${y}`,
            url =
              settings.mode === "aircraft"
                ? "/cockpit/api" + path
                : groundUrl(path, publicTileUrl(layer, z, x, y));
          ({ bytes, type } = await request(url, 524288, signal));
        }
        type = imageType(bytes, type);
        if (closed || generation !== revision || signal?.aborted)
          throw new DOMException("Aborted", "AbortError");
        const blob = new Blob([bytes], { type });
        cache.put(key, blob, bytes.length, now() + 60000);
        error = null;
        return blob;
      } catch (e) {
        if (e.name !== "AbortError") error = e.message;
        throw e;
      }
    },
    async terrainManifest({ signal } = {}) {
      if (closed || !settings.terrain) return null;
      if (settings.mode === "ground" && settings.groundRelayUrl)
        return groundTerrainManifest(signal);
      if (settings.mode !== "aircraft") {
        const m = await storage.get("terrain/manifest").catch(() => null);
        if (m) {
          terrainInfo = {
            id: m.id,
            title: m.title,
            tiles: m.tiles.length,
            datum: m.verticalDatum,
          };
          return validateTerrainManifest(m);
        }
        return null;
      }
      const key = "aircraft-manifest",
        cached = decoded.get(key, now());
      if (cached) return cached;
      const r = await request(
          "/cockpit/api/terrain/manifest",
          4 * 1024 * 1024,
          signal,
        ),
        m = validateTerrainManifest(
          JSON.parse(new TextDecoder().decode(r.bytes)),
        );
      decoded.put(key, m, r.bytes.length, now() + 60000);
      return m;
    },
    async terrainTile(descriptor, { signal } = {}) {
      if (closed || !settings.terrain)
        throw new Error("Terrain source disabled");
      if (settings.mode === "ground" && settings.groundRelayUrl)
        return groundTerrainTile(descriptor, signal);
      const generation = revision,
        key = settings.mode + "/" + descriptor.id + "/" + descriptor.sha256,
        cached = decoded.get(key);
      if (cached) return cached.slice();
      let raw;
      if (settings.mode === "aircraft") {
        raw = (
          await request(
            "/cockpit/api/terrain/tile/" + encodeURIComponent(descriptor.id),
            descriptor.decodedBytes,
            signal,
          )
        ).bytes;
        decodeTerrainTile(raw, descriptor);
      } else {
        const packed = await storage.get("terrain/tile/" + descriptor.id);
        if (!packed) throw new Error("Imported terrain tile unavailable");
        raw = await inflateTerrain(packed, descriptor);
      }
      if (closed || generation !== revision || signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      decoded.put(key, raw, raw.length);
      return raw.slice();
    },
    async pollTraffic(center) {
      if (closed || !settings.traffic || settings.mode === "offline" || !center)
        return;
      await feed.poll({ ...center, radiusNm: settings.trafficRadiusNm });
    },
    trafficSnapshot(center, aircraftSnapshot = null) {
      if (closed || !settings.traffic)
        return disabledTraffic("disabled", "Public traffic is off");
      if (settings.mode === "offline")
        return disabledTraffic(
          "unavailable",
          "Offline mode has no live traffic",
        );
      if (!center)
        return disabledTraffic(
          "unavailable",
          "Traffic requires a fresh aircraft position",
        );
      if (settings.mode === "aircraft" && aircraftSnapshot)
        feed.ingest(aircraftSnapshot, {
          ...center,
          radiusNm: settings.trafficRadiusNm,
        });
      return feed.snapshot({ ...center, radiusNm: settings.trafficRadiusNm });
    },
    async refreshOffline() {
      const [terrain, map] = await Promise.all([
        storage.get("terrain/manifest"),
        storage.get("map/manifest"),
      ]);
      terrainInfo = terrain
        ? {
            id: terrain.id,
            title: terrain.title,
            tiles: terrain.tiles.length,
            datum: terrain.verticalDatum,
          }
        : null;
      mapInfo = map
        ? {
            id: map.id,
            title: map.title,
            tiles: map.tiles.length,
            attribution: map.attribution,
          }
        : null;
      notify();
      return provider.status();
    },
    async preloadTerrainPack(origin, { signal } = {}) {
      if (settings.mode === "aircraft")
        throw new Error("Select ground mode for ground preload");
      const u = new URL(origin);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        u.hash
      )
        throw new Error("Use a ground server origin");
      const r = await request(
          u.origin + "/terrain/manifest",
          4 * 1024 * 1024,
          signal,
        ),
        m = validateTerrainManifest(
          JSON.parse(new TextDecoder().decode(r.bytes)),
        );
      if (
        m.tiles.length > 1024 ||
        m.tiles.reduce((sum, t) => sum + t.bytes, 0) > 64 * 1024 * 1024
      )
        throw new Error("Terrain preload exceeds import limit");
      const files = [new File([r.bytes], "manifest.json")];
      for (const t of m.tiles) {
        const result = await request(
          u.origin + "/terrain/files/" + encodeURIComponent(t.file),
          t.bytes,
          signal,
        );
        files.push(new File([result.bytes], t.file));
      }
      return provider.importTerrainPack(files);
    },
    async importTerrainPack(files) {
      terrainInfo = await importTerrain(files, storage);
      decoded.clear();
      terrainPacked.clear();
      notify();
      return terrainInfo;
    },
    async importOfflineMap(files) {
      mapInfo = await importMap(files, storage);
      cache.clear();
      notify();
      return mapInfo;
    },
    async importGeoid(file) {
      geoid = await importGroundGeoid(file);
      feed.close();
      feed = makeFeed();
      notify();
      return { model: "EGM96-5", source: "Imported ground file" };
    },
    async clearOffline() {
      await storage.clear();
      terrainInfo = mapInfo = null;
      cache.clear();
      decoded.clear();
      terrainPacked.clear();
      notify();
    },
    status() {
      return {
        ...settings,
        revision,
        cacheBytes: cache.bytes,
        terrainCacheBytes: decoded.bytes,
        terrainPackedCacheBytes: terrainPacked.bytes,
        terrainStream: streamManifest ? {
          id: streamManifest.id,
          title: streamManifest.title,
          tiles: streamManifest.tiles.length,
          datum: streamManifest.verticalDatum,
          source: "ground-relay",
        } : null,
        pendingRequests: active + waiters.length,
        offlineTerrain: terrainInfo,
        offlineMap: mapInfo,
        error,
        geoid: geoid ? "EGM96-5" : null,
        attribution:
          settings.mode === "offline"
            ? mapInfo?.attribution || "Imported map"
            : "Imagery / labels © Esri and contributors",
      };
    },
    close() {
      closed = true;
      controller.abort();
      feed.close();
      cache.clear();
      decoded.clear();
      terrainPacked.clear();
      streamManifest = null;
      for (const entry of terrainPending.values()) entry.linked.abort();
      terrainPending.clear();
      listeners.clear();
    },
  };
  return provider;
}
