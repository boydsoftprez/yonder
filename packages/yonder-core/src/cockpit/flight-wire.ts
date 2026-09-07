// SPDX-License-Identifier: GPL-3.0-or-later
import type { FlightTelemetry, VehicleSnapshot } from '../mav/types.js';

/** Versioned column order shared by the aircraft encoder and browser decoder. */
export const FLIGHT_COLUMNS = ['rollDeg','pitchDeg','yawRateDegS','airspeedKt','groundspeedKt','headingDeg','trackDeg','altitudeFt','verticalSpeedFpm','latitude','longitude','globalAltitudeM','gpsAltitudeM','relativeAltitudeM','fixType','satellites','batteryV','currentA','batteryPercent','throttlePercent','mode','customMode','armed','navRollDeg','navPitchDeg'] as const;
export interface FlightWire {
  v: 1; at: number; s: number; g: string|null; c: boolean; b: boolean; d: string;
  source: string; ready: boolean; fd: boolean; age: number|null; datum: string;
  t: (number|string|boolean|null)[];
  /** Sample age, source dictionary index, valid. Never inferred from HTTP receipt. */
  a: [number|null,number,boolean][]; src: string[];
  n: FlightTelemetry['navController']; p: FlightTelemetry['positionTarget']; h: FlightTelemetry['homePosition'];
  m: Omit<VehicleSnapshot['mission'],'items'>;
  r?: VehicleSnapshot['trail'];
}
export function packFlight(snapshot:VehicleSnapshot,detailKey:string):FlightWire {
  const t=snapshot.telemetry, src:string[]=[];
  const a=FLIGHT_COLUMNS.map(key=>{
    const field=t.fields[key], source=field?.source ?? t.source;
    let index=src.indexOf(source);if(index<0){index=src.length;src.push(source);}
    return [field?.ageMs??null,index,field?.valid??t[key]!==null] as [number|null,number,boolean];
  });
  const {items:_,...mission}=snapshot.mission;
  return {v:1,at:snapshot.at,s:snapshot.sequence,g:snapshot.identity?.generation??null,c:snapshot.connected,b:snapshot.busy,d:detailKey,
    source:t.source,ready:t.ready,fd:t.fdReady,age:t.ageMs,datum:t.altitudeDatum??'UNKNOWN',
    t:FLIGHT_COLUMNS.map(key=>t[key]??null),a,src,n:t.navController,p:t.positionTarget,h:t.homePosition,m:mission,...(snapshot.trail?{r:snapshot.trail}:{})};
}
/** Reconstruct the existing PFD view while refusing another generation's details. */
export function unpackFlight(wire:FlightWire,details:Partial<VehicleSnapshot>={}):VehicleSnapshot {
  if(wire?.v!==1)throw new Error('Unsupported flight telemetry version');
  if(!Array.isArray(wire.t)||wire.t.length!==FLIGHT_COLUMNS.length||!Array.isArray(wire.a)||wire.a.length!==FLIGHT_COLUMNS.length||!Array.isArray(wire.src)||!wire.m)throw new Error('Incomplete flight telemetry frame');
  const sameVehicle=(details.identity?.generation??null)===wire.g;
  const sameMission=sameVehicle&&details.mission?.revision===wire.m.revision;
  const fields:FlightTelemetry['fields']={};
  const values:Record<string,unknown>={};
  FLIGHT_COLUMNS.forEach((key,index)=>{
    const [age,sourceIndex,valid]=wire.a[index]!;
    const value=wire.t[index]??null;
    if(age!==null&&(!Number.isFinite(age)||age<0))throw new Error('Invalid flight sample age');
    values[key]=valid?value:null;
    fields[key]={source:wire.src[sourceIndex]??'Aircraft telemetry',ageMs:age,receivedAt:age===null?null:wire.at-age,valid:valid&&value!==null};
  });
  return {at:wire.at,sequence:wire.s,detailKey:wire.d,trail:wire.r,identity:sameVehicle?details.identity??null:null,connected:wire.c,ready:wire.c,busy:wire.b,
    telemetry:{...values,source:wire.source,ready:wire.ready,fdReady:wire.fd,ageMs:wire.age,altitudeDatum:wire.datum,
      fields,navController:wire.n,positionTarget:wire.p,homePosition:wire.h} as FlightTelemetry,
    mission:{...wire.m,currentFresh:wire.m.currentFresh&&sameMission,items:sameMission?details.mission!.items:[]},
    operations:sameVehicle?details.operations??[]:[],statustext:sameVehicle?details.statustext??[]:[],
    capabilities:sameVehicle&&details.capabilities?details.capabilities:{modes:[],commands:[],flightControl:[],terrainTargets:false,signing:'unsigned-only'}};
}
