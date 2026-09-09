// SPDX-License-Identifier: GPL-3.0-or-later
import type {HeightDatum} from './types.js';
export interface PathTerrainSample {groundM:number|null;surfaceM:number|null;datum:HeightDatum;covered?:boolean}
export interface TerrainPathInput {
 lat:number;lon:number;altitudeM:number;datum:HeightDatum;groundspeedMps:number;trackDeg:number;verticalSpeedMps:number;
 telemetryFresh:boolean;transformVerified:boolean;
 sample:(lat:number,lon:number)=>PathTerrainSample;
 lookaheadSeconds?:number;stepSeconds?:number;maxAlongTrackStepM?:number;corridorHalfWidthM?:number;lateralStepM?:number;maxSamples?:number;
 warningClearanceM?:number;cautionClearanceM?:number;
}
export interface TerrainPathPoint {lat:number;lon:number;seconds:number;altitudeM:number;groundClearanceM:number|null;surfaceClearanceM:number|null}
export interface TerrainPathForecast {
 level:'unavailable'|'clear'|'caution'|'warning';coverage:'complete'|'partial'|'unavailable';reason:string;
 earliestWarningSeconds:number|null;earliestCautionSeconds:number|null;minimumGroundClearanceM:number|null;minimumSurfaceClearanceM:number|null;
 closureMps:number|null;evaluatedUntilSeconds:number;lookaheadSeconds:number;samples:number;missingGroundSamples:number;missingSurfaceSamples:number;budgetLimited:boolean;
 alongTrackStepM:number;lateralStepM:number;points:TerrainPathPoint[];
}
const RAD=Math.PI/180,EARTH=6371008.8;
function destination(lat:number,lon:number,bearing:number,metres:number):{lat:number;lon:number}{
 const phi=lat*RAD,lambda=lon*RAD,b=bearing*RAD,d=metres/EARTH;
 const north=Math.asin(Math.sin(phi)*Math.cos(d)+Math.cos(phi)*Math.sin(d)*Math.cos(b));
 const east=lambda+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(phi),Math.cos(d)-Math.sin(phi)*Math.sin(north));
 return {lat:north/RAD,lon:((east/RAD+540)%360)-180};
}
const validHeight=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=-15000&&n<=100000;
const lower=(a:number|null,b:number|null)=>a===null?b:b===null?a:Math.min(a,b);
/**
 * R-FLT-08/09: sampled constant-motion advisory, never a command or autopilot path.
 * Coverage describes the requested sample positions, not continuous obstacle completeness.
 * A work limit truncates the checked horizon explicitly; it never silently coarsens samples.
 */
export function evaluateTerrainPath(input:TerrainPathInput):TerrainPathForecast {
 const out:TerrainPathForecast={level:'unavailable',coverage:'unavailable',reason:'Invalid forecast input',earliestWarningSeconds:null,earliestCautionSeconds:null,minimumGroundClearanceM:null,minimumSurfaceClearanceM:null,closureMps:null,evaluatedUntilSeconds:0,lookaheadSeconds:0,samples:0,missingGroundSamples:0,missingSurfaceSamples:0,budgetLimited:false,alongTrackStepM:0,lateralStepM:0,points:[]};
 if(!input||typeof input!=='object'||Array.isArray(input))return out;
 const horizon=input.lookaheadSeconds??30,step=input.stepSeconds??1,along=input.maxAlongTrackStepM??10,width=input.corridorHalfWidthM??20,lateral=input.lateralStepM??10,budget=input.maxSamples??2048,warning=input.warningClearanceM??30,caution=input.cautionClearanceM??90;
 if(![input.lat,input.lon,input.altitudeM,input.groundspeedMps,input.trackDeg,input.verticalSpeedMps,horizon,step,along,width,lateral,budget,warning,caution].every(Number.isFinite)||Math.abs(input.lat)>85||Math.abs(input.lon)>180||!validHeight(input.altitudeM)||input.groundspeedMps<0||input.groundspeedMps>500||Math.abs(input.verticalSpeedMps)>300||horizon<1||horizon>120||step<.1||step>10||along<1||along>1000||width<0||width>500||lateral<1||lateral>100||!Number.isInteger(budget)||budget<1||budget>4096||warning<0||caution<warning||caution>10000||typeof input.sample!=='function')return out;
 out.lookaheadSeconds=horizon;
 if(input.telemetryFresh!==true){out.reason='Fresh measured motion required';return out;}
 if(input.transformVerified!==true||!['EGM96','NAVD88','WGS84_ELLIPSOID'].includes(input.datum)){out.reason='Verified common height reference required';return out;}
 const dt=input.groundspeedMps>0?Math.min(step,along/input.groundspeedMps):step;
 out.alongTrackStepM=input.groundspeedMps*dt;out.lateralStepM=width?Math.min(lateral,width):0;
 const offsets=[0];for(let i=1;i<=Math.ceil(width/lateral);i++){const offset=Math.min(width,i*lateral);offsets.push(-offset,offset);}
 const steps=Math.ceil(horizon/dt);let known=0,baseline:number|null=null,minimum:number|null=null,minimumAt=0;
 outer:for(let index=0;index<=steps;index++){
  const seconds=Math.min(horizon,index*dt),center=destination(input.lat,input.lon,input.trackDeg,input.groundspeedMps*seconds),height=input.altitudeM+input.verticalSpeedMps*seconds;
  let ground:number|null=null,surface:number|null=null,completeStep=true;
  for(const offset of offsets){
   if(out.samples>=budget){out.budgetLimited=true;completeStep=false;break;}
   const p=destination(center.lat,center.lon,input.trackDeg+(offset<0?-90:90),Math.abs(offset));
   let value:PathTerrainSample|null=null;try{value=input.sample(p.lat,p.lon);}catch{/* Absent/failed sampling remains explicit missing coverage. */}
   out.samples++;
   const compatible=value?.datum===input.datum;
   const g=value&&compatible&&validHeight(value.groundM)?height-value.groundM:null;
   const s=value&&compatible&&validHeight(value.surfaceM)?height-value.surfaceM:null;
   if(g===null)out.missingGroundSamples++;if(s===null)out.missingSurfaceSamples++;
   // An explicit incomplete footprint also prevents an all-clear, while known hazards survive.
   if(value?.covered===false){if(g!==null)out.missingGroundSamples++;if(s!==null)out.missingSurfaceSamples++;}
   if(g!==null||s!==null)known++;
   ground=lower(ground,g);surface=lower(surface,s);
  }
  if(ground!==null||surface!==null){
   const worst=lower(ground,surface)!;
   if(index===0)baseline=worst;
   if(minimum===null||worst<minimum){minimum=worst;minimumAt=seconds;}
   if(worst<=warning&&out.earliestWarningSeconds===null)out.earliestWarningSeconds=seconds;
   if(worst<=caution&&out.earliestCautionSeconds===null)out.earliestCautionSeconds=seconds;
  }
  out.minimumGroundClearanceM=lower(out.minimumGroundClearanceM,ground);out.minimumSurfaceClearanceM=lower(out.minimumSurfaceClearanceM,surface);
  out.points.push({...center,seconds,altitudeM:height,groundClearanceM:ground,surfaceClearanceM:surface});
  if(completeStep)out.evaluatedUntilSeconds=seconds;
  if(out.budgetLimited)break outer;
 }
 const partial=out.budgetLimited||out.missingGroundSamples>0||out.missingSurfaceSamples>0;
 out.coverage=known===0?'unavailable':partial?'partial':'complete';
 out.level=out.earliestWarningSeconds!==null?'warning':out.earliestCautionSeconds!==null?'caution':out.coverage==='complete'?'clear':'unavailable';
 out.closureMps=baseline!==null&&minimum!==null&&minimumAt>0?Math.max(0,(baseline-minimum)/minimumAt):null;
 out.reason='Sampled constant-motion forecast · '+(out.coverage==='complete'?'requested samples covered':out.coverage==='partial'?'partial terrain/surface coverage':'terrain/surface unavailable')+(out.budgetLimited?' · sample budget reached':'');
 return out;
}
