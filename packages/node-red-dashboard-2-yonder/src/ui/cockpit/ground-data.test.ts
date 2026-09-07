// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node
import { it, expect, vi } from "vitest";
import { createGroundDataProvider } from "./ground-data.mjs";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const image = () =>
  new Response(png, { headers: { "content-type": "image/png" } });
it("defaults to ground and opt-out performs no requests; failure never falls back to aircraft", async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error("ground offline");
  });
  const provider = createGroundDataProvider({ fetchImpl });
  expect(provider.status().mode).toBe("ground");
  await expect(provider.tile("elevation", 2, 1, 1)).rejects.toThrow(/disabled/);
  expect(fetchImpl).not.toHaveBeenCalled();
  provider.configure({ terrain: true });
  await expect(provider.tile("elevation", 2, 1, 1)).rejects.toThrow();
  expect(fetchImpl.mock.calls).toHaveLength(1);
  expect(String(fetchImpl.mock.calls[0][0])).toMatch(
    /^https:\/\/s3.amazonaws.com/,
  );
  expect(await provider.terrainManifest()).toBeNull();
  expect(fetchImpl.mock.calls).toHaveLength(1);
  provider.close();
});
it("routes only explicitly selected aircraft mode to same-origin proxy and aborts opt-out", async () => {
  const fetchImpl = vi.fn(async () => image());
  const provider = createGroundDataProvider({ fetchImpl });
  provider.configure({ mode: "aircraft", terrain: true });
  await provider.tile("elevation", 2, 1, 1);
  expect(fetchImpl.mock.calls[0][0]).toBe("/cockpit/api/tiles/elevation/2/1/1");
  provider.configure({ mode: "offline" });
  await expect(provider.tile("elevation", 2, 1, 1)).rejects.toThrow(
    /offline|Offline/,
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  provider.close();
  const pending = vi.fn(
    (_url, options) =>
      new Promise((_ok, no) =>
        options.signal.addEventListener("abort", () =>
          no(new DOMException("Aborted", "AbortError")),
        ),
      ),
  );
  const p = createGroundDataProvider({ fetchImpl: pending });
  p.configure({ terrain: true });
  const work = p.tile("elevation", 2, 1, 1);
  await Promise.resolve();
  p.configure({ terrain: false });
  await expect(work).rejects.toThrow();
  p.close();
});
it("bounds live image cache and rejects oversized responses and invalid source options", async () => {
  const fetchImpl = vi.fn(async () => image());
  const p = createGroundDataProvider({ fetchImpl, maxCacheBytes: 32 });
  p.configure({ imagery: true, trafficRadiusNm: 1 });
  for (let x = 0; x < 10; x++) await p.tile("imagery", 5, x, 1);
  expect(p.status().cacheBytes).toBeLessThanOrEqual(32);
  expect(() => p.configure({ mode: "automatic" })).toThrow();
  expect(() => p.configure({ trafficRadiusNm: 0 })).toThrow();
  p.configure({ imagery: false });
  expect(p.status().cacheBytes).toBe(0);
  p.close();
  const big = createGroundDataProvider({
    fetchImpl: async () =>
      new Response(new Uint8Array(524289), {
        headers: { "content-type": "image/png" },
      }),
  });
  big.configure({ terrain: true });
  await expect(big.tile("elevation", 2, 1, 1)).rejects.toThrow(/limit|large/);
  big.close();
});
it("polls only the chosen traffic origin and keeps aircraft trails in the browser", async () => {
  let now = 1788790000000;
  const point = {
    id: "abc123",
    lat: 35.96,
    lon: -83.36,
    observedAtMs: now,
    altitudeMslM: 500,
    altitudeSource: "WGS84/EGM96",
  };
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          traffic: {
            status: "live",
            sourceAtMs: now,
            tracks: [
              {
                ...point,
                observedAtMs: now,
                lat: point.lat + (now - 1788790000000) / 1e7,
              },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const p = createGroundDataProvider({ fetchImpl, now: () => now });
  const center = { lat: 35.96, lon: -83.36 };
  await p.pollTraffic(center);
  expect(fetchImpl).not.toHaveBeenCalled();
  p.configure({ mode: "aircraft", traffic: true, trafficRadiusNm: 1 });
  await p.pollTraffic(center);
  now += 2001;
  await p.pollTraffic(center);
  expect(
    fetchImpl.mock.calls.every((call) => call[0] === "/cockpit/api/traffic"),
  ).toBe(true);
  expect(p.trafficSnapshot(center).tracks[0].history).toHaveLength(2);
  p.configure({ mode: "offline" });
  await p.pollTraffic(center);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(p.trafficSnapshot(center).tracks).toEqual([]);
  p.close();
});

it("preserves aircraft image, manifest and decoded terrain caches across traffic-only settings", async () => {
  const raw = new Uint8Array(
    new Float32Array([300, 301, 302, 303, 310, 311, 312, 313]).buffer,
  );
  const descriptor = {
    id: "tile",
    file: "tile.bin",
    sha256: "0".repeat(64),
    bytes: raw.length,
    decodedBytes: raw.length,
    level: 0,
    columns: 2,
    rows: 2,
    spacingM: 1,
    originEastingM: 100,
    originNorthingM: 200,
    groundCoverage: 1,
    surfaceCoverage: 1,
    minGroundM: 300,
    maxSurfaceM: 313,
  };
  const manifest = {
    schemaVersion: 1,
    id: "fixture",
    title: "Fixture",
    createdAt: "2026-09-07T00:00:00Z",
    horizontalCrs: {
      kind: "UTM",
      datum: "WGS84",
      zone: 17,
      hemisphere: "north",
    },
    verticalDatum: "EGM96",
    verticalTransform: { verified: true, description: "Fixture", grids: [] },
    surfaceDescription: "Fixture",
    sourceResolutionM: 1,
    sources: [],
    tiles: [descriptor],
    limitations: ["Fixture"],
  };
  const fetchImpl = vi.fn(async (url) =>
    url.endsWith("/manifest")
      ? new Response(JSON.stringify(manifest))
      : url.includes("/terrain/tile/")
        ? new Response(raw)
        : image(),
  );
  const provider = createGroundDataProvider({ fetchImpl });
  provider.configure({ mode: "aircraft", imagery: true, terrain: true });
  const blob = await provider.tile("imagery", 2, 1, 1);
  await provider.terrainManifest();
  await provider.terrainTile(descriptor);
  const { revision, cacheBytes, terrainCacheBytes } = provider.status(),
    listener = vi.fn();
  provider.subscribe(listener);
  for (const change of [
    { trafficRadiusNm: 5 },
    { traffic: true },
    { trafficRadiusNm: 1 },
    { traffic: false },
  ]) {
    provider.configure(change);
    expect(await provider.tile("imagery", 2, 1, 1)).toBe(blob);
    expect(await provider.terrainManifest()).toMatchObject({ id: "fixture" });
    expect(await provider.terrainTile(descriptor)).toEqual(raw);
    expect(provider.status()).toMatchObject({
      revision,
      cacheBytes,
      terrainCacheBytes,
    });
  }
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(listener).not.toHaveBeenCalled();
  provider.configure({ imagery: false });
  expect(listener).toHaveBeenCalledOnce();
  expect(provider.status().cacheBytes).toBe(0);
  provider.close();
});

it("aborts pending traffic on opt-out without aborting or reissuing an aircraft tile", async () => {
  const requests = new Map();
  const fetchImpl = vi.fn(
    (url, options) =>
      new Promise((resolve, reject) => {
        requests.set(url, { signal: options.signal, resolve });
        options.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  );
  const provider = createGroundDataProvider({ fetchImpl });
  provider.configure({ mode: "aircraft", imagery: true, traffic: true });
  const tile = provider.tile("imagery", 2, 1, 1),
    traffic = provider.pollTraffic({ lat: 35.96, lon: -83.36 });
  await new Promise((resolve) => setImmediate(resolve));
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  const imageRequest = requests.get("/cockpit/api/tiles/imagery/2/1/1"),
    trafficRequest = requests.get("/cockpit/api/traffic");
  provider.configure({ traffic: false });
  expect(trafficRequest.signal.aborted).toBe(true);
  expect(imageRequest.signal.aborted).toBe(false);
  provider.configure({ trafficRadiusNm: 1 });
  expect(imageRequest.signal.aborted).toBe(false);
  imageRequest.resolve(image());
  const blob = await tile;
  await traffic;
  expect(await provider.tile("imagery", 2, 1, 1)).toBe(blob);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  provider.close();
});
