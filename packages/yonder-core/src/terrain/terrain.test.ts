// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, it, expect } from 'vitest';
import { validateTerrainManifest, decodeTerrainTile, sampleTerrain, selectTerrainTiles, latLonToUtm, projectCameraPoint, bodyPointToCamera, registrationValidity, clearanceAdvisory, validateCameraCalibration } from './index.js';
import type { CameraCalibration, RegistrationContext, TerrainManifest, TerrainTileDescriptor } from './types.js';
const descriptor: TerrainTileDescriptor = { id:'l0-0-0',file:'l0-0-0.bin.gz',sha256:'0'.repeat(64),bytes:40,decodedBytes:32,level:0,columns:2,rows:2,spacingM:1,originEastingM:100,originNorthingM:200,groundCoverage:1,surfaceCoverage:1,minGroundM:10,maxSurfaceM:30 };
const manifest: TerrainManifest = {schemaVersion:1,id:'test',title:'Test',createdAt:'2026-09-07T00:00:00Z',horizontalCrs:{kind:'UTM',datum:'WGS84',zone:17,hemisphere:'north'},verticalDatum:'NAVD88',verticalTransform:{verified:false,description:'Native heights',grids:[]},surfaceDescription:'Observed maximum returns',sourceResolutionM:1,sources:[],tiles:[descriptor],limitations:['Test data']};
function bytes(values:number[]) { const out = new Uint8Array(values.length*4); const d = new DataView(out.buffer); values.forEach((x,i)=>d.setFloat32(i*4,x,true)); return out; }
const calibration: CameraCalibration = {id:'c1',cameraId:'elp',profileId:'720p',validated:true,width:1280,height:720,fx:600,fy:600,cx:640,cy:360,distortion:{model:'brown-conrady',k1:0,k2:0,p1:0,p2:0,k3:0},bodyToCamera:[0,1,0,0,0,1,1,0,0],cameraOffsetBodyM:[0,0,0],mirrorX:false,rotation:0,residualPx:1,maxResidualPx:2,timingVerified:true,maxTimeErrorMs:10};
const context:RegistrationContext={cameraId:'elp',profileId:'720p',nowMs:1000,frameCaptureMs:900,poseTimeMs:900,timeErrorMs:3,telemetryMaxAgeMs:500,frameMaxAgeMs:500,poseBracketed:true,terrainDatum:'NAVD88',aircraftDatum:'NAVD88',verticalTransformVerified:true,terrainCovered:true};
describe('bounded terrain packs',()=>{
 it('accepts an explicit unverified datum for display but rejects traversal and huge dimensions',()=>{
  expect(validateTerrainManifest(manifest).id).toBe('test');
  expect(()=>validateTerrainManifest({...manifest,tiles:[{...descriptor,file:'../secret'}]})).toThrow();
  expect(()=>validateTerrainManifest({...manifest,tiles:[{...descriptor,columns:99999}]})).toThrow();
  expect(()=>validateTerrainManifest({...manifest,tiles:[descriptor,descriptor]})).toThrow();
 });
 it('decodes independent DTM and surface planes and preserves missing samples',()=>{
  const tile=decodeTerrainTile(bytes([10,20,30,40,15,NaN,35,45]),descriptor);
  expect(sampleTerrain(tile,100,200)).toEqual({groundM:10,surfaceM:15});
  expect(sampleTerrain(tile,100.5,199.5)).toEqual({groundM:25,surfaceM:null});
  expect(sampleTerrain(tile,99.9,200)).toEqual({groundM:null,surfaceM:null});
  expect(()=>decodeTerrainTile(new Uint8Array(1),descriptor)).toThrow();
 });
 it('does not contaminate exact known samples with adjacent nodata',()=>{
  const tile=decodeTerrainTile(bytes([10,NaN,NaN,NaN,20,NaN,NaN,NaN]),descriptor);
  expect(sampleTerrain(tile,100,200)).toEqual({groundM:10,surfaceM:20});
 });
 it('selects nearby tiles within a hard count limit and uses coarser levels when needed',()=>{
  const tiles=Array.from({length:30},(_,i)=>({...descriptor,id:`l0-${i}-0`,file:`l0-${i}-0.bin.gz`,originEastingM:100+i*2}));
  tiles.push({...descriptor,id:'l1-0-0',file:'l1-0-0.bin.gz',level:1,spacingM:2});
  expect(selectTerrainTiles({...manifest,tiles},100,200,100,3).length).toBeLessThanOrEqual(3);
  expect(selectTerrainTiles(manifest,900,900,1,8)).toEqual([]);
 });
 it('projects WGS84 to UTM without making height conversions',()=>{
  const p=latLonToUtm(0,3,31); expect(p.eastingM).toBeCloseTo(500000,3);expect(p.northingM).toBeCloseTo(0,3);
  expect(()=>latLonToUtm(89,0,31)).toThrow();
 });
});
describe('fixed forward camera registration',()=>{
 it('projects body-forward to optical centre in a letterboxed viewport',()=>{
  expect(bodyPointToCamera([100,0,0],calibration)).toEqual([0,0,100]);
  expect(projectCameraPoint([0,0,100],calibration,{x:10,y:20,width:1000,height:1000})).toEqual({x:510,y:520,depthM:100});
  expect(projectCameraPoint([0,0,-1],calibration,{x:0,y:0,width:1280,height:720})).toBeNull();
 });
 it('composes a mirror and quarter turn once',()=>{
  const result=projectCameraPoint([10,0,100],{...calibration,mirrorX:true,rotation:90},{x:0,y:0,width:720,height:1280});
  expect(result?.x).toBeCloseTo(360);expect(result?.y).toBeCloseTo(580);
 });
 it('requires matching geometry, known datum and verified capture-time pose',()=>{
  expect(registrationValidity(calibration,context)).toEqual({ready:true,reason:'Ready'});
  for (const change of [{cameraId:'other'},{aircraftDatum:'EGM96' as const},{verticalTransformVerified:false},{poseBracketed:false},{frameCaptureMs:null},{timeErrorMs:30},{nowMs:2000}]) expect(registrationValidity(calibration,{...context,...change}).ready).toBe(false);
  expect(registrationValidity({...calibration,validated:false},context).ready).toBe(false);
  expect(registrationValidity({...calibration,fx:NaN},context).ready).toBe(false);
 });
 it('never colors unknown heights or a mismatched reference clear',()=>{
  const input={aircraftHeightM:400,surfaceHeightM:370,aircraftDatum:'NAVD88' as const,terrainDatum:'NAVD88' as const,transformVerified:true,telemetryFresh:true,coverageComplete:true,cautionClearanceM:60,warningClearanceM:30};
  expect(clearanceAdvisory(input).level).toBe('warning');
  expect(clearanceAdvisory({...input,aircraftHeightM:420}).level).toBe('caution');
  expect(clearanceAdvisory({...input,aircraftHeightM:500}).level).toBe('clear');
  expect(clearanceAdvisory({...input,aircraftDatum:'EGM96'}).level).toBe('unavailable');
  expect(clearanceAdvisory({...input,surfaceHeightM:null}).level).toBe('unavailable');
 });
});
it('rejects malformed runtime calibration flags, coefficients, arrays and context without throwing',()=>{
 const viewport={x:0,y:0,width:1280,height:720};
 expect(validateCameraCalibration(calibration)).toBe(true);
 for(const bad of [null,undefined,[],{},false,{...calibration,maxTimeErrorMs:'10'}])expect(validateCameraCalibration(bad)).toBe(false);
 for(const change of [{validated:'false'},{timingVerified:'false'},{mirrorX:'false'},{bodyToCamera:[]},{bodyToCamera:[...calibration.bodyToCamera,0]},{cameraOffsetBodyM:[]},{distortion:{}},{distortion:undefined},{distortion:{...calibration.distortion,k3:undefined}},{distortion:{...calibration.distortion,k1:'0'}}]){
  const bad={...calibration,...change} as unknown as CameraCalibration;
  expect(validateCameraCalibration(bad)).toBe(false);
  expect(()=>registrationValidity(bad,context)).not.toThrow();expect(registrationValidity(bad,context).ready).toBe(false);
  expect(()=>projectCameraPoint([10,0,100],bad,viewport)).not.toThrow();
 }
 for(const change of [{poseBracketed:'false'},{terrainCovered:'false'},{verticalTransformVerified:'false'},{aircraftDatum:'invented',terrainDatum:'invented'}])expect(registrationValidity(calibration,{...context,...change} as unknown as RegistrationContext).ready).toBe(false);
 expect(projectCameraPoint([10,0,100],{...calibration,mirrorX:'false'} as unknown as CameraCalibration,viewport)).toBeNull();
});
