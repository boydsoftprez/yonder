// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect,vi} from 'vitest';
import {latLonToUtm} from 'yonder-core/terrain';
import {loadMissionTerrain} from './mission-terrain.mjs';
import {planRoute} from './mission-profile.mjs';
function source(){
 const pose={lat:35.96,lon:-83.36},p=latLonToUtm(pose.lat,pose.lon,17);
 const descriptor={id:'native',file:'native.bin',sha256:'0'.repeat(64),bytes:72,decodedBytes:72,level:0,columns:3,rows:3,spacingM:10,originEastingM:p.eastingM-10,originNorthingM:p.northingM+10,groundCoverage:1,surfaceCoverage:1,minGroundM:100,maxSurfaceM:125};
 const manifest={schemaVersion:1,id:'test',title:'Test',createdAt:'2026-09-07T00:00:00Z',horizontalCrs:{kind:'UTM',datum:'WGS84',zone:17,hemisphere:'north'},verticalDatum:'EGM96',verticalTransform:{verified:true,description:'Test',grids:[]},surfaceDescription:'Mapped heights',sourceResolutionM:1,sources:[],tiles:[descriptor],limitations:[]};
 const heights=new Float32Array([...Array(9).fill(100),...Array(9).fill(125)]);
 const provider={revision:1,terrainManifest:vi.fn(async()=>manifest),terrainTile:vi.fn(async()=>new Uint8Array(heights.buffer))};
 const mission={home:{...pose,alt:100},items:[{seq:1,...pose,alt:50,frame:3,command:16},{seq:2,lat:pose.lat+.00005,lon:pose.lon,alt:70,frame:3,command:16}]};
 return {provider,mission,route:planRoute(mission)};
}
it('uses native terrain, reuses bounded decoded tiles and invalidates source revisions',async()=>{
 const {provider,mission,route}=source(),options={provider,route,home:mission.home,datum:'EGM96',signal:new AbortController().signal};
 const a=await loadMissionTerrain(options);expect(a.waypoints[0]).toMatchObject({aglM:50,clearanceM:25});
 await loadMissionTerrain(options);expect(provider.terrainTile).toHaveBeenCalledTimes(1);
 provider.revision++;await loadMissionTerrain(options);expect(provider.terrainTile).toHaveBeenCalledTimes(2);
});
it('does not fetch or invent terrain clearance for an unknown datum; tile failures leave gaps',async()=>{
 const {provider,mission,route}=source(),options={provider,route,home:mission.home,datum:'UNKNOWN',signal:new AbortController().signal};
 const a=await loadMissionTerrain(options);expect(a.compatible).toBe(false);expect(provider.terrainTile).not.toHaveBeenCalled();
 provider.terrainTile.mockRejectedValue(new Error('Offline'));const b=await loadMissionTerrain({...options,datum:'EGM96'});
 expect(b.errors).toBe(1);expect(b.groundCount).toBe(0);expect(b.waypoints[0].aglM).toBe(null);
});
