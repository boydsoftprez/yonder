// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect,vi} from 'vitest';
import {latLonToUtm} from 'yonder-core/terrain';
import {loadTerrainPack} from './terrain-pack-client.mjs';
it('reuses measured mesh geometry for the same tile selection and invalidates on source revision or datum change',async()=>{
 const pose={lat:35.96,lon:-83.36},p=latLonToUtm(pose.lat,pose.lon,17);
 const descriptor={id:'l0-0-0',file:'l0-0-0.bin.gz',sha256:'0'.repeat(64),bytes:200,decodedBytes:9*8,level:0,columns:3,rows:3,spacingM:10,originEastingM:p.eastingM-10,originNorthingM:p.northingM+10,groundCoverage:1,surfaceCoverage:1,minGroundM:100,maxSurfaceM:125};
 const manifest={schemaVersion:1,id:'test',title:'Test',createdAt:'2026-09-07T00:00:00Z',horizontalCrs:{kind:'UTM',datum:'WGS84',zone:17,hemisphere:'north'},verticalDatum:'EGM96',verticalTransform:{verified:true,description:'Test heights',grids:[]},surfaceDescription:'Observed maximum returns',sourceResolutionM:1,sources:[],tiles:[descriptor],limitations:['Test data']};
 const heights=new Float32Array([100,110,120,100,110,120,100,110,120,105,115,125,105,115,125,105,115,125]);
 const provider={revision:1,terrainManifest:vi.fn(async()=>manifest),terrainTile:vi.fn(async()=>new Uint8Array(heights.buffer))};
 const signal=new AbortController().signal;
 const first=await loadTerrainPack(pose,'EGM96',signal,provider);
 const again=await loadTerrainPack({...pose,lat:pose.lat+.00001},'EGM96',signal,provider);
 expect(again).toBe(first);expect(provider.terrainTile).toHaveBeenCalledTimes(1);
 expect(first.meshes[0].positions[1]).toBe(100);expect(first.meshes[0].positions[7]).toBe(120);
 expect(first.sampleBoth(pose.lat,pose.lon).groundM).toBeCloseTo(110,2);
 expect(await loadTerrainPack(pose,'UNKNOWN',signal,provider)).toBeNull();
 expect(await loadTerrainPack({...pose,lat:36},'EGM96',signal,provider)).toBeNull();
 provider.revision++;
 const changed=await loadTerrainPack(pose,'EGM96',signal,provider);expect(changed).not.toBe(first);
 expect(provider.terrainTile).toHaveBeenCalledTimes(2);
});
it('retains native mesh objects and a stable origin while the nearby tile set changes',async()=>{
 const pose={lat:35.96,lon:-83.36},p=latLonToUtm(pose.lat,pose.lon,17);
 const tiles=Array.from({length:100},(_,i)=>({id:'t'+i,file:'t'+i+'.bin',sha256:'0'.repeat(64),bytes:72,decodedBytes:72,level:0,columns:3,rows:3,spacingM:64,originEastingM:p.eastingM+(i%10-5)*128,originNorthingM:p.northingM+(Math.floor(i/10)-5)*128,groundCoverage:1,surfaceCoverage:1,minGroundM:100,maxSurfaceM:125}));
 const manifest={schemaVersion:1,id:'grid',title:'Grid',createdAt:'2026-09-07T00:00:00Z',horizontalCrs:{kind:'UTM',datum:'WGS84',zone:17,hemisphere:'north'},verticalDatum:'EGM96',verticalTransform:{verified:true,description:'Test heights',grids:[]},surfaceDescription:'Observed heights',sourceResolutionM:1,sources:[],tiles,limitations:['Test data']};
 const provider={revision:1,terrainManifest:async()=>manifest,terrainTile:async()=>new Uint8Array(new Float32Array([100,110,120,100,110,120,100,110,120,105,115,125,105,115,125,105,115,125]).buffer)};
 const signal=new AbortController().signal;
 const first=await loadTerrainPack(pose,'EGM96',signal,provider);
 const second=await loadTerrainPack({...pose,lat:pose.lat+.001},'EGM96',signal,provider);
 expect(second).not.toBe(first);expect(second.origin).toEqual(first.origin);
 const common=first.meshes.filter(a=>second.meshes.some(b=>a.x===b.x&&a.surface===b.surface));
 expect(common.length).toBeGreaterThan(4);
 for(const a of common)expect(second.meshes.find(b=>a.x===b.x&&a.surface===b.surface)).toBe(a);
});
