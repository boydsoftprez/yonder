// SPDX-License-Identifier: GPL-3.0-or-later
import {expect,it,vi} from 'vitest';
import {latLonToUtm} from 'yonder-core/terrain';
import {loadMissionTerrain} from './mission-terrain.mjs';
import {planRoute} from './mission-profile.mjs';
const evidence={available:true,provider:'ardupilot-srtm1',generation:'official-1',spacingM:30,datum:'MSL',datumEvidence:'Official source; no additional datum correction applied'};
function source(items=[{seq:1,lat:35,lon:-84,alt:50,frame:3,command:16},{seq:2,lat:35.001,lon:-84,alt:70,frame:10,command:16}]){
 const mission={home:{lat:35,lon:-84,alt:100},items},client={samples:vi.fn(async points=>({samples:points.map(()=>({...evidence,heightM:100}))}))};
 return {mission,route:planRoute(mission),client};
}
function displaySource(mode='ground'){
 const pose={lat:35,lon:-84},p=latLonToUtm(pose.lat,pose.lon,17);
 const descriptor={id:'native',file:'native.bin',sha256:'0'.repeat(64),bytes:72,decodedBytes:72,level:0,columns:3,rows:3,spacingM:100,
  originEastingM:p.eastingM-100,originNorthingM:p.northingM+150,groundCoverage:1,surfaceCoverage:1,minGroundM:900,maxSurfaceM:125};
 const manifest={schemaVersion:1,id:'display-test',title:'Detailed Cove display',createdAt:'2026-09-07T00:00:00Z',horizontalCrs:{kind:'UTM',datum:'WGS84',zone:17,hemisphere:'north'},
  verticalDatum:'EGM96',verticalTransform:{verified:true,description:'Verified display transform',grids:[]},surfaceDescription:'Mapped surface display overlay',sourceResolutionM:1,
  sources:[{id:'survey',url:'https://example.test/survey.laz',sha256:'1'.repeat(64),bytes:1234,attribution:'Display survey',surveyStart:'2016-01-01',surveyEnd:'2016-12-31',horizontalCrs:'EPSG:32617',verticalDatum:'NAVD88',units:'metre'}],tiles:[descriptor],limitations:['Display only']};
 const heights=new Float32Array([...Array(9).fill(900),...Array(9).fill(125)]);
 const provider={revision:1,options:{mode},terrainManifest:vi.fn(async()=>manifest),terrainTile:vi.fn(async()=>new Uint8Array(heights.buffer))};
 return {provider,manifest};
}
it('samples a terrain-relative target at its actual coordinate and preserves native mission altitudes',async()=>{
 const {mission,route,client}=source(),before=structuredClone(mission);const report=await loadMissionTerrain({route,home:mission.home,client,signal:new AbortController().signal});
 expect(report.waypoints[0]).toMatchObject({alt:50,altitudeM:150,groundM:100,aglM:50});
 expect(report.waypoints[1]).toMatchObject({alt:70,altitudeM:170,groundM:100,aglM:70});
 expect(client.samples.mock.calls.flatMap(call=>call[0])).toContainEqual({lat:35.001,lon:-84});
 expect(report.source).toMatchObject({provider:'ardupilot-srtm1',datum:'MSL',spacingM:30,generations:['official-1']});expect(mission).toEqual(before);
});
it('batches the route within the authenticated 128-point API cap',async()=>{
 const {mission,route,client}=source([{seq:1,lat:35,lon:-84,alt:100,frame:0,command:16},{seq:2,lat:35.03,lon:-84,alt:100,frame:0,command:16}]);
 await loadMissionTerrain({route,home:mission.home,client,signal:new AbortController().signal});expect(client.samples.mock.calls.length).toBeGreaterThan(1);expect(client.samples.mock.calls.every(call=>call[0].length<=128)).toBe(true);
});
it('fails source and datum mismatches closed without display-terrain fallback',async()=>{
 const {mission,route,client}=source();client.samples.mockImplementation(async points=>({samples:points.map(()=>({...evidence,provider:'other',datum:'EGM96',heightM:999}))}));
 const report=await loadMissionTerrain({route,home:mission.home,client,signal:new AbortController().signal});expect(report.groundCount).toBe(0);expect(report.waypoints[0].aglM).toBeNull();expect(report.source).toBeNull();expect(report.reason).toMatch(/source-unverified/);
});
it('keeps official ground and terrain-relative conversion unavailable while drawing a separately sourced surface',async()=>{
 const {mission,route,client}=source(),{provider}=displaySource();
 const report=await loadMissionTerrain({route,home:mission.home,client,signal:new AbortController().signal,
  officialEnabled:false,display:{enabled:true,provider,datum:'EGM96',aircraftConsent:false}});
 expect(report.waypoints[0]).toMatchObject({groundM:null,aglM:null,altitudeM:150,surfaceM:125,clearanceM:25});
 expect(report.waypoints[1]).toMatchObject({groundM:null,aglM:null,altitudeM:null,clearanceM:null});expect(report.waypoints[1].surfaceM).toBeCloseTo(125);
 expect(report.displaySource).toMatchObject({title:'Detailed Cove display',verticalDatum:'EGM96',surfaceDescription:'Mapped surface display overlay'});
 expect(report.source).toBeNull();expect(report.groundCount).toBe(0);expect(report.errors).toBe(0);expect(report.surfaceCount).toBeGreaterThan(0);expect(client.samples).not.toHaveBeenCalled();
});
it('bounds and reuses display tiles while exposing their provenance separately',async()=>{
 const {mission,route,client}=source(),{provider}=displaySource(),options={route,home:mission.home,client,signal:new AbortController().signal,
  display:{enabled:true,provider,datum:'EGM96',aircraftConsent:false}};
 const first=await loadMissionTerrain(options);expect(first.displaySource).toMatchObject({title:'Detailed Cove display',sourceResolutionM:1,sources:[{attribution:'Display survey'}]});
 await loadMissionTerrain(options);expect(provider.terrainTile).toHaveBeenCalledTimes(1);
 provider.revision++;await loadMissionTerrain(options);expect(provider.terrainTile).toHaveBeenCalledTimes(2);
});
it.each(['UNKNOWN','NAVD88'])('hides the display overlay for non-EGM96 display datum %s',async datum=>{
 const {mission,route,client}=source(),{provider}=displaySource();
 const report=await loadMissionTerrain({route,home:mission.home,client,signal:new AbortController().signal,
  display:{enabled:true,provider,datum,aircraftConsent:false}});
 expect(report.surfaceCount).toBe(0);expect(report.displaySource).toBeNull();expect(report.displayReason).toMatch(/verified EGM96/);expect(provider.terrainTile).not.toHaveBeenCalled();
});
it('hides a verified ellipsoid surface even when the selected display datum matches',async()=>{
 const {mission,route,client}=source(),{provider,manifest}=displaySource();manifest.verticalDatum='WGS84_ELLIPSOID';
 const report=await loadMissionTerrain({route,home:mission.home,client,signal:new AbortController().signal,
  display:{enabled:true,provider,datum:'WGS84_ELLIPSOID',aircraftConsent:false}});
 expect(report.surfaceCount).toBe(0);expect(report.displaySource).toBeNull();expect(report.displayReason).toMatch(/verified EGM96/);expect(provider.terrainTile).not.toHaveBeenCalled();
});
it('does not start an aircraft-backed display download without explicit consent',async()=>{
 const {mission,route,client}=source(),{provider}=displaySource('aircraft');
 const options={route,home:mission.home,client,signal:new AbortController().signal,display:{enabled:true,provider,datum:'EGM96',aircraftConsent:false}};
 const pending=await loadMissionTerrain(options);expect(pending.displayReason).toMatch(/explicit load/);expect(provider.terrainManifest).not.toHaveBeenCalled();
 await loadMissionTerrain({...options,display:{...options.display,aircraftConsent:true}});expect(provider.terrainManifest).toHaveBeenCalledTimes(1);
});
