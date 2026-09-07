// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VehicleService } from '../mav/vehicle.js';
import { packFlight, unpackFlight } from './flight-wire.js';

const clock={now:()=>1788790000000,setTimer:()=>0,clearTimer:()=>{}};
const snapshot=()=>new VehicleService({clock,send:async()=>{}}).snapshot();
describe('compact aircraft flight wire',()=>{
  it('round-trips source freshness without mission items or historical operations',()=>{
    const full=snapshot();
    full.identity={system:1,component:1,autopilot:3,vehicleType:1,generation:'vehicle-a'};
    full.connected=true;full.ready=true;
    Object.assign(full.telemetry,{ready:true,rollDeg:14,navRollDeg:19,navPitchDeg:4,fdReady:true,mode:'GUIDED',customMode:15,armed:true,homePosition:{lat:35,lon:-83,alt:300}});
    full.telemetry.fields.rollDeg={source:'ATTITUDE',valid:true,receivedAt:full.at-120,ageMs:120};
    full.mission.items=Array.from({length:2000},(_,seq)=>({seq,command:16,frame:3,params:[0,0,0,0],x:35,y:-83,z:90,current:false,autocontinue:true}));
    full.mission.revision='mission-a';
    const wire=packFlight(full,'details-a');
    const serialized=JSON.stringify(wire);
    expect(serialized.length).toBeLessThan(2500);
    expect(serialized).not.toContain('items');
    expect(serialized).not.toContain('operations');
    const restored=unpackFlight(wire,full);
    expect(restored.telemetry.rollDeg).toBe(14);
    expect(restored.telemetry.fields.rollDeg.ageMs).toBe(120);
    expect(restored.telemetry.fdReady).toBe(true);
    expect(restored.mission.items).toHaveLength(2000);
    expect(restored.identity?.generation).toBe('vehicle-a');
  });
  it('never lends an old vehicle or mission content to a new live frame',()=>{
    const previous=snapshot();previous.identity={system:1,component:1,autopilot:3,vehicleType:1,generation:'old'};
    previous.mission.items=[{seq:1,command:16,frame:3,params:[0,0,0,0],x:35,y:-83,z:90,current:false,autocontinue:true}];previous.mission.revision='old-revision';
    const next=snapshot();next.identity={...previous.identity,generation:'new'};next.mission.revision='new-revision';
    const restored=unpackFlight(packFlight(next,'new-details'),previous);
    expect(restored.identity).toBeNull();
    expect(restored.mission.items).toEqual([]);
    expect(restored.operations).toEqual([]);
    expect(restored.capabilities.modes).toEqual([]);
  });
  it('retains each navigation target and freshness context',()=>{
    const full=snapshot();
    full.telemetry.navController={crossTrackM:41,navBearingDeg:76,targetBearingDeg:73,waypointDistanceM:700,missionSeq:2,mode:'AUTO',autopilotId:3,vehicleType:1,position:{latitude:35,longitude:-83},positionTarget:{lat:35.1,lon:-83.1,alt:400,frame:0},ageMs:430};
    full.telemetry.positionTarget={lat:35.2,lon:-83.2,alt:500,frame:0,ageMs:90};
    const restored=unpackFlight(packFlight(full,'a'),full);
    expect(restored.telemetry.navController).toEqual(full.telemetry.navController);
    expect(restored.telemetry.positionTarget).toEqual(full.telemetry.positionTarget);
  });
  it('rejects a mismatched protocol version instead of drawing misindexed values',()=>{
    const wire=packFlight(snapshot(),'a');
    expect(()=>unpackFlight({...wire,v:99} as never,{})).toThrow(/version/i);
  });
});
