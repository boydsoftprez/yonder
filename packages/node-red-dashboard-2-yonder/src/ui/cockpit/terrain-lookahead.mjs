// SPDX-License-Identifier: GPL-3.0-or-later
import {latLonToUtm, selectTerrainTiles} from 'yonder-core/terrain';
import {destination} from './cockpit-state.mjs';
/** Bounded warm-up using measured motion, independent of mission/autopilot targets. */
export function terrainLookaheadTiles(manifest, pose, motion = {}, cached = () => false) {
  if (!Number.isFinite(motion.trackDeg) || !Number.isFinite(motion.groundspeedMps) || motion.groundspeedMps <= 1) return [];
  const metres = Math.min(1500, motion.groundspeedMps * 30), wanted = new Map();
  const native = {...manifest, tiles: manifest.tiles.filter(t => t.level === 0)};
  for (let distance = 200; distance <= metres + 200; distance += 200) {
    const ll = destination(pose, motion.trackDeg, Math.min(distance, metres));
    const ahead = latLonToUtm(ll.lat, ll.lon, manifest.horizontalCrs.zone);
    for (const tile of selectTerrainTiles(native, ahead.eastingM, ahead.northingM, 150, 8)) {
      if (!cached(tile) && wanted.size < 16) wanted.set(tile.id, tile);
    }
  }
  return [...wanted.values()];
}
