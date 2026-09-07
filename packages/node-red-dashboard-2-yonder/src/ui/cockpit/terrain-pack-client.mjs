// SPDX-License-Identifier: GPL-3.0-or-later
import {
  validateTerrainManifest,
  decodeTerrainTile,
  selectTerrainTiles,
  latLonToUtm,
  sampleTerrain
} from 'yonder-core/terrain';
import {
  tileCoordinate,
  tilePosition
} from './terrain-state.mjs';
import {
  rendererMesh,
  terrainImageCoordinate
} from './terrain-adapter.mjs';
const tiles = new Map();
let manifest = null;
async function readTile(descriptor, signal) {
  if (tiles.has(descriptor.id)) return tiles.get(descriptor.id);
  const response = await fetch('/cockpit/api/terrain/tile/' + encodeURIComponent(descriptor.id), {
    credentials: 'same-origin',
    signal
  });
  if (!response.ok) throw new Error('Bundled terrain tile unavailable');
  const tile = decodeTerrainTile(new Uint8Array(await response.arrayBuffer()), descriptor);
  tiles.set(descriptor.id, tile);
  while (tiles.size > 64) tiles.delete(tiles.keys().next().value);
  return tile;
}
export async function loadTerrainPack(pose, datum, signal) {
  if (!manifest) {
    const response = await fetch('/cockpit/api/terrain/manifest', {
      credentials: 'same-origin',
      signal
    });
    if (!response.ok) return null;
    manifest = validateTerrainManifest(await response.json());
  }
  if (datum !== manifest.verticalDatum || !manifest.verticalTransform.verified) return null;
  let point;
  try {
    point = latLonToUtm(pose.lat, pose.lon, manifest.horizontalCrs.zone);
  } catch {
    return null;
  }
  if (point.hemisphere !== manifest.horizontalCrs.hemisphere) return null;
  const near = selectTerrainTiles({
    ...manifest,
    tiles: manifest.tiles.filter(t => t.level === 0)
  }, point.eastingM, point.northingM, 200, 9);
  if (!near.length || !selectTerrainTiles(manifest, point.eastingM, point.northingM, 0, 1).length) return null;
  const far = selectTerrainTiles(manifest, point.eastingM, point.northingM, 7000, 16).filter(t => !near.some(n => n
    .id === t.id));
  const origin = {
      ...point,
      heightM: 0,
      zone: manifest.horizontalCrs.zone,
      utm: true
    },
    loaded = [];
  let next = 0;
  await Promise.all(Array.from({
    length: 3
  }, async () => {
    while (next < near.length + far.length) {
      const descriptor = [...near, ...far][next++];
      loaded.push(await readTile(descriptor, signal));
    }
  }));
  const meshes = [];
  for (const tile of loaded) {
    const native = near.some(n => n.id === tile.descriptor.id),
      mesh = rendererMesh(tile, origin, 'ground');
    if (!native) {
      const inside = (i) => {
        const east = mesh.positions[i * 3] + origin.eastingM,
          north = origin.northingM - mesh.positions[i * 3 + 2];
        return near.some(t => east >= t.originEastingM && east <= t.originEastingM + (t.columns - 1) * t.spacingM &&
          north <= t.originNorthingM && north >= t.originNorthingM - (t.rows - 1) * t.spacingM)
      };
      const kept = [];
      for (let n = 0; n < mesh.indices.length; n += 3)
        if (![0, 1, 2].every(k => inside(mesh.indices[n + k]))) kept.push(mesh.indices[n], mesh.indices[n + 1], mesh
          .indices[n + 2]);
      mesh.indices = new mesh.indices.constructor(kept);
      mesh.chunks[0].count = kept.length;
    }
    const t = tile.descriptor,
      corners = [
        [0, 0],
        [t.columns - 1, 0],
        [0, t.rows - 1],
        [t.columns - 1, t.rows - 1]
      ].map(([x, y]) => {
        const ll = terrainImageCoordinate(t.originEastingM + x * t.spacingM, t.originNorthingM - y * t.spacingM,
          manifest.horizontalCrs.zone, pose);
        return tilePosition(ll.lat, ll.lon, 17)
      });
    for (let row = 0; row < t.rows; row++)
      for (let col = 0; col < t.columns; col++) {
        const u = col / (t.columns - 1),
          v = row / (t.rows - 1),
          i = (row * t.columns + col) * 2;
        mesh.uv[i] = (corners[0].x * (1 - u) + corners[1].x * u) * (1 - v) + (corners[2].x * (1 - u) + corners[3].x *
          u) * v;
        mesh.uv[i + 1] = (corners[0].y * (1 - u) + corners[1].y * u) * (1 - v) + (corners[2].y * (1 - u) + corners[3]
          .y * u) * v;
      }
    mesh.packImagery = true;
    meshes.push(mesh);
    if (native) {
      const surface = rendererMesh(tile, origin, 'surface');
      const raised = [];
      for (let n = 0; n < surface.indices.length; n += 3)
        if ([0, 1, 2].some(k => {
            const i = surface.indices[n + k];
            return tile.surfaceM[i] - tile.groundM[i] > 1
          })) raised.push(surface.indices[n], surface.indices[n + 1], surface.indices[n + 2]);
      surface.indices = new surface.indices.constructor(raised);
      surface.chunks[0].count = raised.length;
      surface.uv = mesh.uv;
      surface.packImagery = true;
      surface.surface = true;
      if (raised.length) meshes.push(surface);
    }
    await new Promise(r => setTimeout(r, 0));
  }
  const groundSampler = (x, y, u, v) => {
    const coordinate = tileCoordinate(x + u, y + v);
    const p = latLonToUtm(coordinate.lat, coordinate.lon, manifest.horizontalCrs.zone);
    for (const tile of loaded.sort((a, b) => a.descriptor.spacingM - b.descriptor.spacingM)) {
      const result = sampleTerrain(tile, p.eastingM, p.northingM);
      if (result.groundM !== null) return result.groundM;
    }
    return null;
  };
  const sampleBoth = (lat, lon) => {
    const p = latLonToUtm(lat, lon, manifest.horizontalCrs.zone);
    for (const tile of loaded.filter(t=>t.descriptor.level===0).sort((a,b)=>a.descriptor.spacingM-b.descriptor.spacingM)) {
      const sample = sampleTerrain(tile, p.eastingM, p.northingM);
      if (sample.groundM !== null) return {
        ...sample,
        datum: manifest.verticalDatum,
        covered: sample.groundM!==null&&sample.surfaceM!==null
      };
    }
    return {
      groundM: null,
      surfaceM: null,
      datum: manifest.verticalDatum,
      covered: false
    };
  };
  return {
    meshes,
    origin,
    groundSampler,
    sampleBoth,
    manifest,
    spacingM: Math.min(...near.map(t => t.spacingM)),
    farSpacingM: Math.max(...far.map(t => t.spacingM), 1)
  };
}
