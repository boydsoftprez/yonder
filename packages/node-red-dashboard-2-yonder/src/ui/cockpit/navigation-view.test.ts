// SPDX-License-Identifier: GPL-3.0-or-later
import {describe, expect, it} from 'vitest';
import {cdiDeflection, navigationView} from './navigation-view.mjs';
import {flightView, guidanceView} from './cockpit-state.mjs';

const target = {lat:35.01, lon:-84, alt:120, frame:0, ageMs:0};
const actionTarget = {lat:target.lat, lon:target.lon, altitudeM:120, datum:'msl'};
function accepted(action, command, at=1000) {
  return {id:String(at), vehicleGeneration:'aircraft-a', action, createdAt:at-20, sentAt:at-10,
    updatedAt:at, state:'accepted', ack:{command, result:0, at}, effect:{state:'unavailable'}, steps:[]};
}
const direct = () => accepted({kind:'goto', target:actionTarget},192);
const heading = () => accepted({kind:'heading', headingDeg:90, reference:'true', turnAccelerationMps2:2},43002,2000);
function snapshot(operations=[direct()]) {
  return {at:4000, connected:true, identity:{autopilot:3, generation:'aircraft-a'}, operations,
    telemetry:{ready:true, mode:'GUIDED', customMode:15, latitude:35, longitude:-84, groundspeedKt:50,
      rollDeg:2, pitchDeg:3, headingDeg:87, fdReady:true, navRollDeg:4, navPitchDeg:5,
      positionTarget:{...target}, navController:{ageMs:0, autopilotId:3, mode:'GUIDED',
        positionTarget:{...target}, navBearingDeg:0, targetBearingDeg:0, crossTrackM:12}},
    mission:{synchronization:'verified',currentFresh:true, currentSeq:1, items:[{seq:1, command:16, frame:0, x:35.02, y:-84, z:120, params:[0,0,0,0]}]}};
}

describe('GUIDED lateral navigation ownership',()=>{
  it('hides stale geographic cues after a heading ACK while retaining measured flight-director demands',()=>{
    const before=snapshot(), after=snapshot([direct(),heading()]);
    expect(navigationView(before).valid).toBe(true);
    expect(navigationView(before).eteSeconds).toBeGreaterThan(0);
    const view=navigationView(after);
    expect(view).toMatchObject({valid:false,target:null});
    expect(view.reason).toMatch(/heading.*accepted.*unavailable/i);
    expect(view.reason).toMatch(/ownership.*not reported/i);
    for(const key of ['bearingDeg','distanceM','eteSeconds','pathBearingDeg']) expect(view[key]??null).toBeNull();
    expect(cdiDeflection(view,250)).toBeNull();
    expect(guidanceView(after).valid).toBe(false);
    expect(flightView(after)).toMatchObject({fdValid:true,navRoll:4,navPitch:5});
  });
  it('does not clear an accepted heading for speed, altitude, same-mode selection, or a rejected loiter',()=>{
    const replacements=[
      accepted({kind:'speed',airspeedMps:25,accelerationMps2:1},43000,3000),
      accepted({kind:'altitude',altitudeM:180,datum:'home',verticalRateMps:0},43001,3000),
      {...accepted({kind:'mode',customMode:15},176,3000),state:'observed',effect:{state:'observed'}},
      {...accepted({kind:'loiter',target:actionTarget,radiusM:200,direction:'cw'},192,3000),state:'rejected',ack:{command:192,result:2,at:3000}}
    ];
    for(const op of replacements) expect(navigationView(snapshot([direct(),heading(),op])).valid).toBe(false);
  });
  it.each(['goto','loiter'])('restores reported geographic navigation after accepted %s and matching current target telemetry',kind=>{
    const position=accepted({kind,target:{...actionTarget,lat:35.02},radiusM:200,direction:'cw'},192,3000);
    const state=snapshot([direct(),heading(),position]);
    expect(navigationView(state).valid).toBe(false); // The old waypoint is still streaming.
    state.telemetry.positionTarget.lat=35.02;
    state.telemetry.navController.positionTarget.lat=35.02;
    const view=navigationView(state);
    expect(view).toMatchObject({valid:true,radialValid:true,target:{lat:35.02}});
    expect(view.eteSeconds).toBeGreaterThan(0);
    expect(guidanceView(state).valid).toBe(true);
  });
  it('uses observed AUTO navigation even if a heading request remains in history',()=>{
    const mode={...accepted({kind:'mode',customMode:10},176,3000),state:'observed',effect:{state:'observed'}};
    const state=snapshot([direct(),heading(),mode]);
    expect(navigationView(state).valid).toBe(false); // Mode history alone does not change current GUIDED telemetry.
    Object.assign(state.telemetry,{mode:'AUTO',customMode:10});
    Object.assign(state.telemetry.navController,{mode:'AUTO',missionSeq:1});
    expect(navigationView(state)).toMatchObject({valid:true,targetName:'WP1',lateralValid:false});
  });
  it('marks absent ownership and stale operation details unavailable instead of guessing from a fresh waypoint',()=>{
    for(const state of [snapshot([]),snapshot([{...heading(),vehicleGeneration:'old-aircraft'}]),
      {...snapshot(),_detailsReady:false}]) {
      const view=navigationView(state);
      expect(view.valid).toBe(false);
      expect(view.reason).toMatch(/ownership|details/i);
      expect(guidanceView(state).valid).toBe(false);
    }
  });
  it('does not treat the prerequisite GUIDED mode ACK as a heading ACK',()=>{
    const pending={...heading(),state:'accepted',ack:{command:176,result:0,at:2000},effect:{state:'waiting'}};
    const view=navigationView(snapshot([direct(),pending]));
    expect(view.valid).toBe(false);
    expect(view.reason).toMatch(/pending|unconfirmed/i);
    expect(view.reason).not.toMatch(/heading request accepted/i);
  });
  it('accepts a matching unchanged center after reposition ACK even when display aging advances its sample age',()=>{
    const loiter=accepted({kind:'loiter',target:actionTarget,radiusM:200,direction:'cw'},192,3950);
    const state=snapshot([direct(),heading(),loiter]);
    // agedTelemetry adds browser elapsed time; snapshot.at remains the server's
    // sample time. Subtracting this age from snapshot.at invents a pre-ACK time.
    state.telemetry.positionTarget.ageMs=100;
    expect(navigationView(state).valid).toBe(true);
  });
});
