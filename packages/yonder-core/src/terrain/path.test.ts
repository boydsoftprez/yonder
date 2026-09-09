// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {evaluateTerrainPath,type TerrainPathInput} from './path.js';
const input:TerrainPathInput={lat:35.9607874,lon:-83.3668696,altitudeM:400,datum:'EGM96',groundspeedMps:20,trackDeg:0,verticalSpeedMps:-5,telemetryFresh:true,transformVerified:true,lookaheadSeconds:20,stepSeconds:1,maxAlongTrackStepM:100,corridorHalfWidthM:0,sample:()=>({groundM:200,surfaceM:300,datum:'EGM96'})};
it('joins predicted aircraft height to ground and surface, including earliest hazard time and closure',()=>{
 const result=evaluateTerrainPath(input);
 expect(result.level).toBe('warning');expect(result.coverage).toBe('complete');expect(result.earliestCautionSeconds).toBe(2);expect(result.earliestWarningSeconds).toBe(14);
 expect(result.minimumGroundClearanceM).toBe(100);expect(result.minimumSurfaceClearanceM).toBe(0);expect(result.closureMps).toBeCloseTo(5);
 expect(result.points.at(-1)?.altitudeM).toBe(300);expect(result.points.at(-1)!.lat).toBeGreaterThan(input.lat);
});
it('checks the lateral corridor and keeps a known warning when other sampled coverage is missing',()=>{
 const result=evaluateTerrainPath({...input,verticalSpeedMps:0,corridorHalfWidthM:20,lateralStepM:10,sample:(_lat,lon)=>lon<input.lon-0.00001?{groundM:390,surfaceM:395,datum:'EGM96'}:{groundM:200,surfaceM:null,datum:'EGM96'}});
 expect(result.level).toBe('warning');expect(result.earliestWarningSeconds).toBe(0);expect(result.coverage).toBe('partial');expect(result.missingSurfaceSamples).toBeGreaterThan(0);
});
it('never reports clear over missing data or different datums',()=>{
 expect(evaluateTerrainPath({...input,verticalSpeedMps:0,sample:()=>({groundM:200,surfaceM:null,datum:'EGM96'})})).toMatchObject({level:'unavailable',coverage:'partial'});
 expect(evaluateTerrainPath({...input,sample:()=>({groundM:200,surfaceM:200,datum:'NAVD88'})})).toMatchObject({level:'unavailable',coverage:'unavailable'});
 expect(evaluateTerrainPath({...input,telemetryFresh:false,sample:()=>{throw new Error('must not sample');}})).toMatchObject({level:'unavailable',samples:0});
});
it('bounds work without silently coarsening samples or claiming the full lookahead was checked',()=>{
 let calls=0;
 const result=evaluateTerrainPath({...input,verticalSpeedMps:0,lookaheadSeconds:120,stepSeconds:.1,corridorHalfWidthM:100,lateralStepM:1,maxSamples:200,sample:()=>{calls++;return {groundM:200,surfaceM:200,datum:'EGM96'};}});
 expect(calls).toBeLessThanOrEqual(200);expect(result).toMatchObject({level:'unavailable',coverage:'partial',budgetLimited:true});expect(result.evaluatedUntilSeconds).toBeLessThan(120);
});
it('rejects bad runtime flags and impossible limits before calling the sampler',()=>{
 for(const change of [{telemetryFresh:'false'},{transformVerified:'true'},{groundspeedMps:-1},{lookaheadSeconds:9999},{lateralStepM:0},{datum:'unknown'},{maxSamples:1e9}]){
  const result=evaluateTerrainPath({...input,...change,sample:()=>{throw new Error('must not sample');}} as TerrainPathInput);
  expect(result).toMatchObject({level:'unavailable',samples:0});
 }
});
