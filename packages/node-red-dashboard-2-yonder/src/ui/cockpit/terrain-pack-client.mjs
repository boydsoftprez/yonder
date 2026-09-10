// SPDX-License-Identifier: GPL-3.0-or-later
import {
  validateTerrainManifest,
  decodeTerrainTile,
  selectTerrainTiles,
  latLonToUtm,
  sampleTerrain,
} from "yonder-core/terrain";
import { terrainLookaheadTiles } from "./terrain-lookahead.mjs";
import { tileCoordinate, tilePosition } from "./terrain-state.mjs";
import { rendererMesh, terrainImageCoordinate } from "./terrain-adapter.mjs";
const providerStates = new WeakMap();
async function readTile(descriptor, signal, provider, state) {
  const key = descriptor.id + "/" + descriptor.sha256;
  if (state.tiles.has(key)) return state.tiles.get(key);
  const tile = decodeTerrainTile(
    await provider.terrainTile(descriptor, { signal }),
    descriptor,
  );
  state.tiles.set(key, tile);
  while (state.tiles.size > 64)
    state.tiles.delete(state.tiles.keys().next().value);
  return tile;
}
export async function loadTerrainPack(pose, datum, signal, provider, motion = {}) {
  if (!provider) return null;
  let state = providerStates.get(provider);
  if (!state || state.revision !== provider.revision) {
    state = { revision: provider.revision, tiles: new Map(), nativeMeshes: new Map(), manifest: null };
    providerStates.set(provider, state);
  }
  if (!state.manifest) {
    const candidate = await provider.terrainManifest({ signal });
    if (candidate) state.manifest = validateTerrainManifest(candidate);
  }
  if (!state.manifest) return null;
  const manifest = state.manifest;
  if (datum !== manifest.verticalDatum || !manifest.verticalTransform.verified)
    return null;
  let point;
  try {
    point = latLonToUtm(pose.lat, pose.lon, manifest.horizontalCrs.zone);
  } catch {
    return null;
  }
  if (point.hemisphere !== manifest.horizontalCrs.hemisphere) return null;
  const near = selectTerrainTiles(
    {
      ...manifest,
      tiles: manifest.tiles.filter((t) => t.level === 0),
    },
    point.eastingM,
    point.northingM,
    300,
    24,
  );
  if (
    !near.length ||
    !selectTerrainTiles(manifest, point.eastingM, point.northingM, 0, 1).length
  )
    return null;
  const far = selectTerrainTiles(
    manifest,
    point.eastingM,
    point.northingM,
    7000,
    16,
  ).filter((t) => !near.some((n) => n.id === t.id));
  const warmAhead = () => {
    const queue = terrainLookaheadTiles(manifest, pose, motion, t => state.tiles.has(t.id + "/" + t.sha256));
    let next = 0;
    // Visible tiles finish first. Two workers share the provider's bounded
    // request queue; aborted/reconfigured pages never continue downloading.
    void Promise.all(Array.from({length: 2}, async () => {
      while (next < queue.length && !signal?.aborted) {
        try { await readTile(queue[next++], signal, provider, state); } catch { return; }
      }
    }));
  };
  const selectionKey = JSON.stringify([
    near.map(t => t.id).sort(), far.map(t => t.id).sort(),
  ]);
  // The source revision scopes this one-region cache; moving the camera does
  // not require a new origin, normals, UVs, triangle masks, or GPU uploads.
  if (state.region?.key === selectionKey) { warmAhead(); return state.region.value; }
  const origin = {
      eastingM: manifest.tiles[0].originEastingM,
      northingM: manifest.tiles[0].originNorthingM,
      hemisphere: manifest.horizontalCrs.hemisphere,
      heightM: 0,
      zone: manifest.horizontalCrs.zone,
      utm: true,
    },
    loaded = [];
  let next = 0;
  await Promise.all(
    Array.from(
      {
        length: 3,
      },
      async () => {
        while (next < near.length + far.length) {
          const descriptor = [...near, ...far][next++];
          loaded.push(await readTile(descriptor, signal, provider, state));
        }
      },
    ),
  );
  const meshes = [];
  for (const tile of loaded) {
    const native = near.some((n) => n.id === tile.descriptor.id);
    const cached = native && state.nativeMeshes.get(tile.descriptor.id);
    if (cached) {
      state.nativeMeshes.delete(tile.descriptor.id);
      state.nativeMeshes.set(tile.descriptor.id, cached);
      meshes.push(...cached);
      continue;
    }
    const tileMeshes = [];
    const mesh = rendererMesh(tile, origin, "ground");
    if (!native) {
      const inside = (i) => {
        const east = mesh.positions[i * 3] + origin.eastingM,
          north = origin.northingM - mesh.positions[i * 3 + 2];
        return near.some(
          (t) =>
            east >= t.originEastingM &&
            east <= t.originEastingM + (t.columns - 1) * t.spacingM &&
            north <= t.originNorthingM &&
            north >= t.originNorthingM - (t.rows - 1) * t.spacingM,
        );
      };
      const kept = [];
      for (let n = 0; n < mesh.indices.length; n += 3)
        if (![0, 1, 2].every((k) => inside(mesh.indices[n + k])))
          kept.push(mesh.indices[n], mesh.indices[n + 1], mesh.indices[n + 2]);
      mesh.indices = new mesh.indices.constructor(kept);
      mesh.chunks[0].count = kept.length;
    }
    const t = tile.descriptor,
      corners = [
        [0, 0],
        [t.columns - 1, 0],
        [0, t.rows - 1],
        [t.columns - 1, t.rows - 1],
      ].map(([x, y]) => {
        const ll = terrainImageCoordinate(
          t.originEastingM + x * t.spacingM,
          t.originNorthingM - y * t.spacingM,
          manifest.horizontalCrs.zone,
          pose,
        );
        return tilePosition(ll.lat, ll.lon, 17);
      });
    for (let row = 0; row < t.rows; row++)
      for (let col = 0; col < t.columns; col++) {
        const u = col / (t.columns - 1),
          v = row / (t.rows - 1),
          i = (row * t.columns + col) * 2;
        mesh.uv[i] =
          (corners[0].x * (1 - u) + corners[1].x * u) * (1 - v) +
          (corners[2].x * (1 - u) + corners[3].x * u) * v;
        mesh.uv[i + 1] =
          (corners[0].y * (1 - u) + corners[1].y * u) * (1 - v) +
          (corners[2].y * (1 - u) + corners[3].y * u) * v;
      }
    mesh.packImagery = true;
    tileMeshes.push(mesh);
    if (native) {
      const surface = rendererMesh(tile, origin, "surface");
      const raised = [];
      for (let n = 0; n < surface.indices.length; n += 3)
        if (
          [0, 1, 2].some((k) => {
            const i = surface.indices[n + k];
            return tile.surfaceM[i] - tile.groundM[i] > 1;
          })
        )
          raised.push(
            surface.indices[n],
            surface.indices[n + 1],
            surface.indices[n + 2],
          );
      surface.indices = new surface.indices.constructor(raised);
      surface.chunks[0].count = raised.length;
      surface.uv = mesh.uv;
      surface.packImagery = true;
      surface.surface = true;
      if (raised.length) tileMeshes.push(surface);
      state.nativeMeshes.set(tile.descriptor.id, tileMeshes);
      while (state.nativeMeshes.size > 32) state.nativeMeshes.delete(state.nativeMeshes.keys().next().value);
    }
    meshes.push(...tileMeshes);
    await new Promise((r) => setTimeout(r, 0));
  }
  const groundTiles = [...loaded].sort((a, b) => a.descriptor.spacingM - b.descriptor.spacingM);
  const nativeTiles = groundTiles.filter(t => t.descriptor.level === 0);
  const groundSampler = (x, y, u, v) => {
    const coordinate = tileCoordinate(x + u, y + v);
    const p = latLonToUtm(
      coordinate.lat,
      coordinate.lon,
      manifest.horizontalCrs.zone,
    );
    for (const tile of groundTiles) {
      const result = sampleTerrain(tile, p.eastingM, p.northingM);
      if (result.groundM !== null) return result.groundM;
    }
    return null;
  };
  const sampleBoth = (lat, lon) => {
    const p = latLonToUtm(lat, lon, manifest.horizontalCrs.zone);
    for (const tile of nativeTiles) {
      const sample = sampleTerrain(tile, p.eastingM, p.northingM);
      if (sample.groundM !== null)
        return {
          ...sample,
          datum: manifest.verticalDatum,
          covered: sample.groundM !== null && sample.surfaceM !== null,
        };
    }
    return {
      groundM: null,
      surfaceM: null,
      datum: manifest.verticalDatum,
      covered: false,
    };
  };
  const value = {
    meshes,
    origin,
    groundSampler,
    sampleBoth,
    manifest,
    spacingM: Math.min(...near.map((t) => t.spacingM)),
    farSpacingM: Math.max(...far.map((t) => t.spacingM), 1),
  };
  if (signal?.aborted) throw new DOMException("Terrain load aborted", "AbortError");
  state.region = { key: selectionKey, value };
  warmAhead();
  return value;
}
