// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-08/09: bounded terrain data and calibrated advisory presentation.
import type { TerrainManifest, TerrainTile, TerrainTileDescriptor } from './types.js';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const text = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function assert(ok: unknown, reason: string): asserts ok { if (!ok) throw new Error(`Invalid terrain pack: ${reason}`); }
/** Bounds apply before allocation or filesystem access. No arbitrary resource URLs. */
export function validateTerrainManifest(input: unknown): TerrainManifest {
  assert(input && typeof input === 'object', 'manifest');
  const m = input as TerrainManifest;
  assert(m.schemaVersion === 1 && text(m.id, 80) && /^[a-zA-Z0-9_-]+$/.test(m.id) && text(m.title, 200), 'identity');
  assert(text(m.createdAt) && Number.isFinite(Date.parse(m.createdAt)), 'creation time');
  assert(m.horizontalCrs?.kind === 'UTM' && m.horizontalCrs.datum === 'WGS84' && Number.isInteger(m.horizontalCrs.zone) && m.horizontalCrs.zone >= 1 && m.horizontalCrs.zone <= 60 && ['north','south'].includes(m.horizontalCrs.hemisphere), 'horizontal CRS');
  assert(['NAVD88','EGM96','WGS84_ELLIPSOID','UNKNOWN'].includes(m.verticalDatum), 'vertical datum');
  assert(typeof m.verticalTransform?.verified === 'boolean' && text(m.verticalTransform.description) && Array.isArray(m.verticalTransform.grids) && m.verticalTransform.grids.length <= 32 && m.verticalTransform.grids.every(x => text(x)), 'vertical transform');
  assert(finite(m.sourceResolutionM) && m.sourceResolutionM >= 0.1 && m.sourceResolutionM <= 1000 && text(m.surfaceDescription), 'resolution/surface');
  assert(Array.isArray(m.limitations) && m.limitations.length <= 32 && m.limitations.every(x => text(x)), 'limitations');
  assert(Array.isArray(m.sources) && m.sources.length <= 256, 'sources');
  for (const s of m.sources) {
    assert(s && text(s.id) && text(s.url) && /^https:\/\//.test(s.url) && hash(s.sha256) && finite(s.bytes) && s.bytes > 0 && text(s.attribution), 'source provenance');
    assert(text(s.surveyStart) && text(s.surveyEnd) && text(s.horizontalCrs, 20000) && text(s.verticalDatum) && text(s.units), 'source references');
  }
  assert(Array.isArray(m.tiles) && m.tiles.length > 0 && m.tiles.length <= 16384, 'tile count');
  const ids = new Set<string>(); const files = new Set<string>();
  for (const t of m.tiles) {
    assert(t && text(t.id, 80) && /^[a-zA-Z0-9_-]+$/.test(t.id) && !ids.has(t.id), 'tile identity'); ids.add(t.id);
    assert(text(t.file, 100) && /^[a-zA-Z0-9_-]+\.bin(?:\.gz)?$/.test(t.file) && !files.has(t.file), 'tile path'); files.add(t.file);
    assert(Number.isInteger(t.columns) && Number.isInteger(t.rows) && t.columns >= 2 && t.rows >= 2 && t.columns <= 257 && t.rows <= 257, 'tile dimensions');
    assert(Number.isInteger(t.level) && t.level >= 0 && t.level <= 16 && finite(t.spacingM) && t.spacingM >= m.sourceResolutionM && t.spacingM <= 65536, 'tile spacing');
    assert(finite(t.originEastingM) && finite(t.originNorthingM) && Math.abs(t.originEastingM) <= 2e6 && Math.abs(t.originNorthingM) <= 1.1e7, 'tile origin');
    assert(hash(t.sha256) && Number.isInteger(t.bytes) && t.bytes > 0 && t.bytes <= 1024*1024 && t.decodedBytes === t.columns*t.rows*8, 'tile bytes/hash');
    assert([t.groundCoverage,t.surfaceCoverage].every(x => finite(x) && x >= 0 && x <= 1), 'tile coverage');
    assert([t.minGroundM,t.maxSurfaceM].every(x => x === null || (finite(x) && x >= -15000 && x <= 100000)), 'height range');
  }
  return m;
}
/** Wire format: all DTM float32 LE values, followed by all DSM float32 LE values. NaN means unobserved. */
export function decodeTerrainTile(bytes: Uint8Array, descriptor: TerrainTileDescriptor): TerrainTile {
  const count = descriptor.columns*descriptor.rows;
  if (!Number.isInteger(count) || count < 4 || count > 257*257 || bytes.byteLength !== count*8 || descriptor.decodedBytes !== count*8) throw new Error('Invalid terrain tile length');
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const groundM = new Float32Array(count); const surfaceM = new Float32Array(count);
  for (let i=0; i<count; i++) {
    groundM[i]=view.getFloat32(i*4,true); surfaceM[i]=view.getFloat32((i+count)*4,true);
    for (const value of [groundM[i],surfaceM[i]]) if (!Number.isNaN(value) && (!Number.isFinite(value) || value < -15000 || value > 100000)) throw new Error('Invalid terrain elevation');
  }
  return {descriptor,groundM,surfaceM};
}
/** Select one LOD. Near-first bounded results cannot generate duplicate overlaid levels. */
export function selectTerrainTiles(manifest: TerrainManifest, east: number, north: number, radiusM: number, maxTiles = 64): TerrainTileDescriptor[] {
  if (![east,north,radiusM,maxTiles].every(Number.isFinite) || radiusM < 0 || maxTiles < 1) return [];
  const cap = Math.min(256,Math.floor(maxTiles));
  const distance = (t:TerrainTileDescriptor) => {
    const right=t.originEastingM+(t.columns-1)*t.spacingM, bottom=t.originNorthingM-(t.rows-1)*t.spacingM;
    return Math.hypot(Math.max(t.originEastingM-east,0,east-right),Math.max(bottom-north,0,north-t.originNorthingM));
  };
  let selected:TerrainTileDescriptor[]=[];
  for (const level of [...new Set(manifest.tiles.map(t=>t.level))].sort((a,b)=>a-b)) {
    const candidates=manifest.tiles.filter(t=>t.level===level && distance(t)<=radiusM).sort((a,b)=>distance(a)-distance(b));
    if (!candidates.length) continue;
    selected=candidates;
    if (candidates.length<=cap) break;
  }
  return selected.slice(0,cap);
}
