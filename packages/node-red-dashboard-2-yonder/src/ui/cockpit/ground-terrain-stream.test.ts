// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node
// R-FLT-11: prepared terrain streams only from an explicitly selected ground relay.
import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createGroundDataProvider } from "./ground-data.mjs";

const origin = "http://127.0.0.1:4197";
const providers = [];
afterEach(() => providers.splice(0).forEach((provider) => provider.close()));
function memory() {
  const entries = new Map();
  return {
    entries,
    get: async (key) => entries.get(key) ?? null,
    replace: async (kind, values) => {
      for (const key of entries.keys())
        if (key.startsWith(kind + "/")) entries.delete(key);
      for (const [key, value] of values) entries.set(kind + "/" + key, value);
    },
    clear: async () => entries.clear(),
  };
}
function fixture(count = 3, height = 300) {
  const raw = new Uint8Array(new Float32Array([
    height, height + 1, height + 2, height + 3,
    height + 10, height + 11, height + 12, height + 13,
  ]).buffer);
  const packed = new Uint8Array(gzipSync(raw));
  const manifest = {
    schemaVersion: 1, id: "fixture", title: "Ground fixture",
    createdAt: "2026-09-07T00:00:00Z",
    horizontalCrs: { kind: "UTM", datum: "WGS84", zone: 17, hemisphere: "north" },
    verticalDatum: "EGM96",
    verticalTransform: { verified: true, description: "Fixture", grids: [] },
    surfaceDescription: "Fixture", sourceResolutionM: 1, sources: [],
    limitations: ["Fixture"],
    tiles: Array.from({ length: count }, (_, i) => ({
      id: `tile-${i}`, file: `tile-${i}.bin.gz`,
      sha256: createHash("sha256").update(packed).digest("hex"),
      bytes: packed.length, decodedBytes: raw.length,
      level: 0, columns: 2, rows: 2, spacingM: 1,
      originEastingM: 100 + i, originNorthingM: 200,
      groundCoverage: 1, surfaceCoverage: 1,
      minGroundM: height, maxSurfaceM: height + 13,
    })),
  };
  return {
    raw, packed, manifest,
    files: [new File([JSON.stringify(manifest)], "manifest.json"),
      ...manifest.tiles.map((tile) => new File([packed], tile.file))],
  };
}
function setup(f = fixture(), options = {}) {
  const storage = options.storage ?? memory();
  const fetchImpl = options.fetchImpl ?? vi.fn(async (url) => {
    if (url === origin + "/terrain/manifest")
      return new Response(JSON.stringify(f.manifest));
    if (f.manifest.tiles.some((t) => url === origin + "/terrain/files/" + t.file))
      return new Response(f.packed);
    throw new Error("Unexpected network target: " + url);
  });
  const provider = createGroundDataProvider({ ...options, fetchImpl, storage });
  providers.push(provider);
  provider.configure({ mode: "ground", terrain: true, groundRelayUrl: origin });
  return { provider, storage, fetchImpl };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

it("fetches a ground manifest and only requested files, sharing requests and returning independent bytes", async () => {
  const f = fixture(), { provider, storage, fetchImpl } = setup(f);
  const [first, second] = await Promise.all([provider.terrainManifest(), provider.terrainManifest()]);
  expect(first).toEqual(f.manifest);
  expect(second).toEqual(f.manifest);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([origin + "/terrain/manifest"]);
  const [a, b] = await Promise.all([
    provider.terrainTile(first.tiles[1]), provider.terrainTile(first.tiles[1]),
  ]);
  expect(a).toEqual(f.raw);
  expect(b).toEqual(f.raw);
  a.fill(0);
  expect(b).toEqual(f.raw);
  expect(await provider.terrainTile(first.tiles[1])).toEqual(f.raw);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    origin + "/terrain/manifest", origin + "/terrain/files/tile-1.bin.gz",
  ]);
  expect(fetchImpl.mock.calls.every(([, options]) => options.credentials === "omit")).toBe(true);
  expect(storage.entries.size).toBe(0);
  expect(provider.status().offlineTerrain).toBeNull();
  expect(provider.status().terrainStream).toMatchObject({ id: "fixture", tiles: 3 });
});

it("rejects corrupt relay files without caching them, then permits a verified retry", async () => {
  const f = fixture();
  let corrupt = true;
  const { provider, fetchImpl } = setup(f, { fetchImpl: vi.fn(async (url) =>
    url.endsWith("/manifest") ? new Response(JSON.stringify(f.manifest))
      : new Response(corrupt ? new Uint8Array(f.packed.length) : f.packed)) });
  await provider.terrainManifest();
  await expect(provider.terrainTile(f.manifest.tiles[0])).rejects.toThrow(/checksum/);
  expect(provider.status().terrainPackedCacheBytes).toBe(0);
  expect(provider.status().terrainCacheBytes).toBe(0);
  corrupt = false;
  expect(await provider.terrainTile(f.manifest.tiles[0])).toEqual(f.raw);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it("reuses matching fully imported tiles instead of downloading them again", async () => {
  const f = fixture(), { provider, fetchImpl } = setup(f);
  await provider.importTerrainPack(f.files);
  const manifest = await provider.terrainManifest();
  expect(manifest).toEqual(f.manifest);
  for (const tile of manifest.tiles) expect(await provider.terrainTile(tile)).toEqual(f.raw);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([origin + "/terrain/manifest"]);
  expect(provider.status().offlineTerrain).toMatchObject({ id: "fixture", tiles: 3 });
});

it("replaces a stale imported tile in session memory while retaining the complete offline import", async () => {
  const old = fixture(3, 200), current = fixture(3, 400);
  const { provider, storage, fetchImpl } = setup(current);
  await provider.importTerrainPack(old.files);
  expect((await provider.terrainManifest()).tiles[0].sha256).toBe(current.manifest.tiles[0].sha256);
  expect(await provider.terrainTile(current.manifest.tiles[0])).toEqual(current.raw);
  expect(await storage.get("terrain/tile/tile-0")).toEqual(old.packed);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  provider.configure({ mode: "offline" });
  expect(await provider.terrainTile(old.manifest.tiles[0])).toEqual(old.raw);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it("rejects files absent from the selected manifest before requesting them", async () => {
  const f = fixture(), { provider, fetchImpl } = setup(f);
  await provider.terrainManifest();
  await expect(provider.terrainTile({ ...f.manifest.tiles[0], file: "other.bin.gz" })).rejects.toThrow(/manifest/);
  await expect(provider.terrainTile({ ...f.manifest.tiles[0], decodedBytes: 1e9 })).rejects.toThrow(/manifest/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("aborts an old relay manifest immediately and rejects its late response after a source change", async () => {
  const f = fixture(), pending = [];
  const { provider } = setup(f, { fetchImpl: vi.fn((url, options) => new Promise((resolve) => {
    pending.push({ url, signal: options.signal, resolve });
  })) });
  const old = provider.terrainManifest();
  const rejection = expect(old).rejects.toMatchObject({ name: "AbortError" });
  rejection.catch(() => {});
  await tick();
  provider.configure({ groundRelayUrl: "http://127.0.0.1:4198" });
  await rejection;
  expect(pending[0].signal.aborted).toBe(true);
  const current = provider.terrainManifest();
  await tick();
  pending[1].resolve(new Response(JSON.stringify({ ...f.manifest, id: "current" })));
  expect(await current).toMatchObject({ id: "current" });
  pending[0].resolve(new Response(JSON.stringify(f.manifest)));
  await tick();
  expect(await provider.terrainManifest()).toMatchObject({ id: "current" });
});

it("keeps a shared transfer alive for another consumer but cancels it when all consumers abort", async () => {
  const f = fixture(), pending = [];
  const { provider, fetchImpl } = setup(f, { fetchImpl: vi.fn(async (url, options) => {
    if (url.endsWith("/manifest")) return new Response(JSON.stringify(f.manifest));
    return new Promise((resolve) => pending.push({ resolve, signal: options.signal }));
  }) });
  await provider.terrainManifest();
  const a = new AbortController(), b = new AbortController();
  const first = provider.terrainTile(f.manifest.tiles[0], { signal: a.signal });
  const second = provider.terrainTile(f.manifest.tiles[0], { signal: b.signal });
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  second.catch(() => {});
  rejected.catch(() => {});
  await tick();
  a.abort();
  await rejected;
  expect(pending[0].signal.aborted).toBe(false);
  pending[0].resolve(new Response(f.packed));
  expect(await second).toEqual(f.raw);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const last = new AbortController();
  const work = provider.terrainTile(f.manifest.tiles[1], { signal: last.signal });
  const stopped = expect(work).rejects.toMatchObject({ name: "AbortError" });
  await tick();
  last.abort();
  await stopped;
  expect(pending[1].signal.aborted).toBe(true);
  pending[1].resolve(new Response(f.packed));
});

it.each([{ terrain: false }, { mode: "offline" }, { groundRelayUrl: "" }])(
  "refuses terrain streaming after opting out or leaving the configured ground source: %j", async (change) => {
    const f = fixture(), { provider, fetchImpl } = setup(f);
    provider.configure(change);
    expect(await provider.terrainManifest()).toBeNull();
    await expect(provider.terrainTile(f.manifest.tiles[0])).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);

it("bounds both terrain caches and evicts old requests without writing a partial offline pack", async () => {
  const f = fixture(5), { provider, storage, fetchImpl } = setup(f, {
    maxTerrainCacheBytes: 64, maxTerrainPackedBytes: f.packed.length * 2,
  });
  await provider.terrainManifest();
  for (const tile of f.manifest.tiles) {
    expect(await provider.terrainTile(tile)).toEqual(f.raw);
    expect(provider.status().terrainCacheBytes).toBeLessThanOrEqual(64);
    expect(provider.status().terrainPackedCacheBytes).toBeLessThanOrEqual(f.packed.length * 2);
  }
  expect(fetchImpl).toHaveBeenCalledTimes(6);
  expect(await provider.terrainTile(f.manifest.tiles[0])).toEqual(f.raw);
  expect(fetchImpl).toHaveBeenCalledTimes(7);
  expect(storage.entries.size).toBe(0);
});

it("can reuse compressed session bytes after decoded eviction", async () => {
  const f = fixture(), { provider, fetchImpl } = setup(f, {
    maxTerrainCacheBytes: 32, maxTerrainPackedBytes: f.packed.length * 3,
  });
  await provider.terrainManifest();
  await provider.terrainTile(f.manifest.tiles[0]);
  await provider.terrainTile(f.manifest.tiles[1]);
  expect(await provider.terrainTile(f.manifest.tiles[0])).toEqual(f.raw);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
});

it.each([{ terrain: false }, { mode: "offline" }, { mode: "aircraft" }])(
  "cancels pending terrain before a delayed import lookup can start any transfer: %j", async (change) => {
    const f = fixture();
    let finishLookup;
    const storage = memory();
    storage.get = () => new Promise((resolve) => { finishLookup = resolve; });
    const { provider, fetchImpl } = setup(f, { storage });
    await provider.terrainManifest();
    const load = provider.terrainTile(f.manifest.tiles[0]);
    const rejected = expect(load).rejects.toMatchObject({ name: "AbortError" });
    await tick();
    provider.configure(change);
    await rejected;
    finishLookup(null);
    await tick();
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([origin + "/terrain/manifest"]);
    expect(provider.status().terrainCacheBytes).toBe(0);
    expect(provider.status().terrainPackedCacheBytes).toBe(0);
  },
);

it("does not retain an old relay tile that finishes after the relay changes", async () => {
  const f = fixture(), pending = [];
  const { provider } = setup(f, { fetchImpl: vi.fn(async (url, options) => {
    if (url.endsWith("/manifest")) return new Response(JSON.stringify(f.manifest));
    return new Promise((resolve) => pending.push({ resolve, signal: options.signal }));
  }) });
  await provider.terrainManifest();
  const load = provider.terrainTile(f.manifest.tiles[0]);
  const rejected = expect(load).rejects.toMatchObject({ name: "AbortError" });
  await tick();
  provider.configure({ groundRelayUrl: "http://127.0.0.1:4198" });
  await rejected;
  expect(pending[0].signal.aborted).toBe(true);
  pending[0].resolve(new Response(f.packed));
  await tick();
  expect(provider.status().terrainCacheBytes).toBe(0);
  expect(provider.status().terrainPackedCacheBytes).toBe(0);
  expect(provider.status().terrainStream).toBeNull();
});

it("streams on a cold browser even when persistent storage is unavailable", async () => {
  const f = fixture(), storage = memory();
  storage.get = async () => { throw new Error("Storage unavailable"); };
  const { provider, fetchImpl } = setup(f, { storage });
  expect(await provider.terrainTile(f.manifest.tiles[0])).toEqual(f.raw);
  expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
    origin + "/terrain/manifest", origin + "/terrain/files/tile-0.bin.gz",
  ]);
  expect(provider.status().offlineTerrain).toBeNull();
});

it.each([
  { label: "invalid manifest", response: () => new Response('{"schemaVersion":1}') },
  { label: "oversized manifest", response: () => new Response("{}", { headers: { "content-length": "4194305" } }) },
])("rejects $label without any file request", async ({ response }) => {
  const { provider, fetchImpl } = setup(fixture(), { fetchImpl: vi.fn(response) });
  await expect(provider.terrainManifest()).rejects.toThrow(/Invalid|limit/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(provider.status().terrainStream).toBeNull();
});

it("bounds a relay file response before hashing or retaining it", async () => {
  const f = fixture();
  const { provider } = setup(f, { fetchImpl: vi.fn(async (url) =>
    url.endsWith("/manifest") ? new Response(JSON.stringify(f.manifest))
      : new Response(new Uint8Array(f.packed.length + 1))) });
  await expect(provider.terrainTile(f.manifest.tiles[0])).rejects.toThrow(/limit/);
  expect(provider.status().terrainPackedCacheBytes).toBe(0);
});

it("bounds decompression even when the relay file hash and compressed length are valid", async () => {
  const f = fixture(), inflated = new Uint8Array(64), packed = new Uint8Array(gzipSync(inflated));
  f.manifest.tiles[0] = { ...f.manifest.tiles[0], bytes: packed.length,
    sha256: createHash("sha256").update(packed).digest("hex") };
  const { provider } = setup(f, { fetchImpl: vi.fn(async (url) =>
    url.endsWith("/manifest") ? new Response(JSON.stringify(f.manifest)) : new Response(packed)) });
  await expect(provider.terrainTile(f.manifest.tiles[0])).rejects.toThrow(/limit/);
  expect(provider.status().terrainPackedCacheBytes).toBe(0);
  expect(provider.status().terrainCacheBytes).toBe(0);
});

it("bounds pending terrain jobs before delayed storage reads allocate an unbounded queue", async () => {
  const f = fixture(100), storage = memory();
  const { provider, fetchImpl } = setup(f, { storage });
  await provider.terrainManifest();
  const lookups = [];
  storage.get = () => new Promise((resolve) => lookups.push(resolve));
  const pending = f.manifest.tiles.map((tile) => provider.terrainTile(tile).catch((error) => error));
  await tick();
  expect(lookups.length).toBeLessThanOrEqual(70);
  provider.close();
  for (const resolve of lookups) resolve(null);
  const results = await Promise.all(pending);
  expect(results.filter((error) => /queue full/.test(error.message)).length).toBeGreaterThan(0);
  expect(results.every((error) => error.name === "AbortError" || /queue full/.test(error.message))).toBe(true);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
