// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {fileURLToPath} from 'node:url';
import {TerrainPackService} from './service.js';
import {decodeTerrainTile} from './pack.js';
import {latLonToUtm} from './sample.js';
it('ships checksummed real one-metre USGS terrain, mapped surface, and verified EGM96 conversion provenance',async()=>{
 const service=await TerrainPackService.open(fileURLToPath(new URL('./assets/cove/',import.meta.url)),{maxCacheBytes:1024*1024});
 expect(service.manifest.verticalDatum).toBe('EGM96');expect(service.manifest.verticalTransform.verified).toBe(true);
 expect(service.manifest.verticalTransform.grids.some(s=>s.includes('us_noaa_g2012bu0.tif'))).toBe(true);
 expect(service.manifest.sources.map(s=>s.id)).toContain('2738597SE');
 expect(service.manifest.tiles.filter(t=>t.level===0).every(t=>t.spacingM===1)).toBe(true);
 for(const t of service.manifest.tiles){const tile=decodeTerrainTile(await service.getTile(t.id),t);expect(tile.groundM.length).toBe(t.columns*t.rows);expect(service.cacheBytes).toBeLessThanOrEqual(1024*1024);}
 const p=latLonToUtm(35.9607874,-83.3668696,17);
 expect(p.eastingM).toBeCloseTo(286555.11267587065,3);expect(p.northingM).toBeCloseTo(3982188.9842432635,3);
 const home=await service.sampleAt(p.eastingM,p.northingM);
 expect(home.groundM).toBeGreaterThan(300);expect(home.groundM).toBeLessThan(330);
 // Source coverage includes the southern route, which the NE input tile alone misses.
 const south=latLonToUtm(35.9540135,-83.365674,17);expect((await service.sampleAt(south.eastingM,south.northingM)).groundM).not.toBeNull();
 // Real isolated class-1 returns (~1 km MSL over ~305 m ground) remain unknown DSM.
 for(const [east,north] of [[286386.5,3982257.5],[286457.5,3982191.5],[286363.5,3981588.5]]){
  const suspect=await service.sampleAt(east,north);expect(suspect.groundM).not.toBeNull();expect(suspect.surfaceM).toBeNull();
 }
 expect(service.manifest.limitations.some(s=>s.includes('>80 m above DTM'))).toBe(true);
});
