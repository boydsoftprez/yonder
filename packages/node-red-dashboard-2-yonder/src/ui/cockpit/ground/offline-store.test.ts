// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment node
import { it, expect, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { importTerrain, importMap } from "./offline-store.mjs";
import { createGroundDataProvider } from "../ground-data.mjs";
import { importGroundGeoid } from "./ground-geoid.mjs";
const file = (name: string, data: Uint8Array | string) => {
  const blob = new Blob([data]);
  return {
    name,
    size: blob.size,
    text: () => blob.text(),
    arrayBuffer: () => blob.arrayBuffer(),
  };
};
function memory() {
  const data = new Map();
  return {
    get: async (k) => data.get(k) || null,
    replace: async (kind, entries) => {
      for (const k of data.keys()) if (k.startsWith(kind + "/")) data.delete(k);
      for (const [k, v] of entries) data.set(kind + "/" + k, v);
    },
    clear: async () => data.clear(),
  };
}
const digest = (b) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const raw = new Uint8Array(
      new Float32Array([300, 301, 302, 303, 310, 311, 312, 313]).buffer,
    ),
    packed = gzipSync(raw);
  const t = {
    id: "l0-0-0",
    file: "l0-0-0.bin.gz",
    sha256: digest(packed),
    bytes: packed.length,
    decodedBytes: 32,
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
    id: "test",
    title: "Local",
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
    tiles: [t],
    limitations: ["Fixture"],
  };
  return {
    raw,
    packed,
    t,
    manifest,
    files: [
      file("manifest.json", JSON.stringify(manifest)),
      file(t.file, packed),
    ],
  };
}
it("imports validated terrain atomically and retrieves offline without any network", async () => {
  const store = memory(),
    f = fixture(),
    fetchImpl = vi.fn();
  expect(await importTerrain(f.files, store)).toMatchObject({
    tiles: 1,
    datum: "EGM96",
  });
  const p = createGroundDataProvider({ storage: store, fetchImpl });
  p.configure({ mode: "offline", terrain: true });
  expect(await p.terrainManifest()).toMatchObject({ id: "test" });
  expect(await p.terrainTile(f.t)).toEqual(f.raw);
  expect(fetchImpl).not.toHaveBeenCalled();
  p.close();
});
it("rejects corrupted or incomplete imports without replacing previous data", async () => {
  const store = memory(),
    f = fixture();
  await importTerrain(f.files, store);
  await expect(
    importTerrain(
      [f.files[0], file(f.t.file, new Uint8Array(f.packed.length))],
      store,
    ),
  ).rejects.toThrow(/checksum/);
  expect(await store.get("terrain/manifest")).toMatchObject({ id: "test" });
  await expect(importTerrain([f.files[0]], store)).rejects.toThrow(/Missing/);
});
it("imports only explicit licensed offline maps and never downloads provider imagery for export", async () => {
  const store = memory(),
    png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    m = {
      schemaVersion: 1,
      id: "map",
      title: "Operator map",
      attribution: "USGS",
      sourceUrl: "https://usgs.gov",
      license: "Public domain",
      offlineAllowed: true,
      tiles: [
        {
          layer: "imagery",
          z: 2,
          x: 1,
          y: 1,
          file: "tile.png",
          sha256: digest(png),
          bytes: png.length,
          type: "image/png",
        },
      ],
    };
  await importMap(
    [file("map-manifest.json", JSON.stringify(m)), file("tile.png", png)],
    store,
  );
  const fetchImpl = vi.fn(),
    p = createGroundDataProvider({ storage: store, fetchImpl });
  p.configure({ mode: "offline", imagery: true });
  expect((await p.tile("imagery", 2, 1, 1)).size).toBe(8);
  expect(fetchImpl).not.toHaveBeenCalled();
  await expect(
    importMap(
      [
        file(
          "map-manifest.json",
          JSON.stringify({ ...m, offlineAllowed: false }),
        ),
        file("tile.png", png),
      ],
      store,
    ),
  ).rejects.toThrow();
  p.close();
});
it("uses the exact locally provisioned EGM96 grid without fetching it", async () => {
  const bytes = await readFile(
    new URL(
      "../../../../../yonder-core/src/cockpit/assets/egm96-5.pgm",
      import.meta.url,
    ),
  );
  const geoid = await importGroundGeoid(file("egm96-5.pgm", bytes));
  expect(geoid.undulation(35.9607874, -83.3668696)).toBeCloseTo(-31.72435, 4);
  await expect(
    importGroundGeoid(file("fake.pgm", "not geoid")),
  ).rejects.toThrow(/EGM96/);
});


it("bounds expanded map entries before reading files or replacing the previous pack", async () => {
  const png = new Uint8Array(524288); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const tile = { layer: "imagery", z: 8, y: 1, file: "shared.png", sha256: digest(png), bytes: png.length, type: "image/png" };
  const manifest = { schemaVersion: 1, id: "repeated", title: "Repeated map", attribution: "Fixture", sourceUrl: "https://example.invalid", license: "Fixture", offlineAllowed: true,
    tiles: Array.from({ length: 129 }, (_, x) => ({ ...tile, x })) };
  const shared = file("shared.png", png), read = vi.spyOn(shared, "arrayBuffer"), replace = vi.fn();
  // Unique input is below 1 MiB, but references expand to more than 64 MiB.
  await expect(importMap([file("map-manifest.json", JSON.stringify(manifest)), shared], { replace })).rejects.toThrow(/64 MiB|limit/);
  expect(read).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});
