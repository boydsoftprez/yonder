// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-22: planned straight-leg geometry, never an autopilot trajectory prediction.
import {bearing,distance,destination,validPosition} from './cockpit-state.mjs';
const emptyTerrain={groundM:null,surfaceM:null};
export function plannedAltitude(item,home,terrain=emptyTerrain,compatible=false){
 let altitudeM=null;
 if(Number.isFinite(item.alt)){
  if([0,5].includes(item.frame))altitudeM=item.alt;
  if([3,6].includes(item.frame)&&Number.isFinite(home?.alt))altitudeM=home.alt+item.alt;
  if([10,11].includes(item.frame)&&compatible&&Number.isFinite(terrain.groundM))altitudeM=terrain.groundM+item.alt;
 }
 const groundM=compatible&&Number.isFinite(terrain.groundM)?terrain.groundM:null;
 const surfaceM=compatible&&Number.isFinite(terrain.surfaceM)?terrain.surfaceM:null;
 return {altitudeM,groundM,surfaceM,aglM:altitudeM!==null&&groundM!==null?altitudeM-groundM:null,
  clearanceM:altitudeM!==null&&surfaceM!==null?altitudeM-surfaceM:null};
}
export function planRoute(mission={}){
 const points=[],legs=[],limitations=new Set();let previous=null,totalM=0;
 for(const item of (mission.items||[]).slice(0,2000)){
  if([177,601].includes(item.command)){previous=null;limitations.add('Mission jump: sequence-dependent segments omitted');continue;}
  if([17,18,19,20,21,31,85].includes(item.command)){previous=null;limitations.add('Loiter, return and landing geometry omitted');continue;}
  if(![16,22,84].includes(item.command))continue;
  let p=item;
  if([22,84].includes(item.command)&&item.lat===0&&item.lon===0&&validPosition(mission.home))p={...item,lat:mission.home.lat,lon:mission.home.lon};
  if(!validPosition(p)){previous=null;limitations.add('Unresolved waypoint position');continue;}
  const length=previous?distance(previous,p):0;
  if(previous&&length>=1){legs.push({from:previous,to:p,startM:totalM,lengthM:length,courseDeg:bearing(previous,p)});totalM+=length;}
  points.push({...p,distanceM:totalM});previous=p;
 }
 return {points,legs,totalM,limitations:[...limitations]};
}
export function routeSamples(route,maxSamples=2048){
 const samples=[],step=Math.max(2,route.totalM/Math.max(1,maxSamples-route.legs.length*2));
 for(const [legIndex,leg] of route.legs.entries()){
  const count=Math.max(1,Math.ceil(leg.lengthM/step));
  if(samples.length+count+1>maxSamples)break;
  for(let i=0;i<=count;i++)samples.push({...destination(leg.from,leg.courseDeg,leg.lengthM*i/count),distanceM:leg.startM+leg.lengthM*i/count,fraction:i/count,legIndex});
 }
 return samples;
}
export function buildMissionProfile(route,home,sample=()=>emptyTerrain,compatible=false,maxSamples=2048){
 const waypointValues=new Map(route.points.map(p=>[p.seq,plannedAltitude(p,home,sample(p),compatible)]));
 const samples=routeSamples(route,maxSamples).map(p=>{
  const leg=route.legs[p.legIndex],a=waypointValues.get(leg.from.seq),b=waypointValues.get(leg.to.seq),terrain=sample(p);
  let altitudeM=a?.altitudeM!==null&&b?.altitudeM!==null?a.altitudeM+(b.altitudeM-a.altitudeM)*p.fraction:null;
  // A terrain-relative pair denotes a planned ground offset, not an MSL chord.
  if([10,11].includes(leg.from.frame)&&[10,11].includes(leg.to.frame))altitudeM=compatible&&Number.isFinite(terrain.groundM)?terrain.groundM+leg.from.alt+(leg.to.alt-leg.from.alt)*p.fraction:null;
  const v=plannedAltitude({alt:altitudeM,frame:0},home,terrain,compatible);
  return {...p,...v,altitudeM:compatible?v.altitudeM:null};
 });
 return {route,samples,waypoints:route.points.map(p=>({...p,...waypointValues.get(p.seq)})),compatible,
  sampledDistanceM:samples.at(-1)?.distanceM??0,groundCount:samples.filter(p=>p.groundM!==null).length,surfaceCount:samples.filter(p=>p.surfaceM!==null).length};
}
