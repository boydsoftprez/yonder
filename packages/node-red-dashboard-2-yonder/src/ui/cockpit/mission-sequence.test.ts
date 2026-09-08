// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {missionSequence} from './mission-sequence.mjs';
import {navigationView,cdiDeflection} from './navigation-view.mjs';
import {bearing,distance} from './cockpit-state.mjs';
const item=(seq,x,y,command=16)=>({seq,command,frame:3,x,y,z:90,params:[0,0,0,0]});
const snapshot=()=>({connected:true,identity:{autopilot:3},mission:{synchronization:'verified',currentFresh:true,currentSeq:2,items:[item(0,35,-84),item(1,35,-84),item(2,35.01,-84),item(3,35.01,-83.99),item(4,35.02,-83.99)]},telemetry:{ready:true,mode:'AUTO',groundspeedKt:50,latitude:35.005,longitude:-84,navController:{autopilotId:3,mode:'AUTO',missionSeq:2,ageMs:0,navBearingDeg:25,targetBearingDeg:0,waypointDistanceM:556,crossTrackM:0,position:{latitude:35.005,longitude:-84},positionTarget:{lat:35.01,lon:-84}}}});
it('describes the active leg and planned next waypoint, advancing both on the reported sequence',()=>{
 const s=snapshot();expect(missionSequence(s)).toMatchObject({activeSeq:2,fromSeq:1,nextSeq:3});
 s.mission.currentSeq=3;expect(missionSequence(s)).toMatchObject({activeSeq:3,fromSeq:2,nextSeq:4});
 s.mission.currentFresh=false;expect(missionSequence(s)).toMatchObject({activeSeq:null,nextSeq:null});
});
it('skips action items in a planned next waypoint, but does not pretend to resolve a mission jump',()=>{
 const s=snapshot();s.mission.items.splice(3,0,item(8,0,0,178));expect(missionSequence(s).nextSeq).toBe(3);
 s.mission.items[3].command=177;expect(missionSequence(s)).toMatchObject({nextSeq:null,nextReason:'Mission jump determines the next waypoint'});
});
it('uses the uploaded leg course, never the steering bearing, and keeps the measured CDI sign',()=>{
 const s=snapshot();s.telemetry.longitude=-83.9999;s.telemetry.navController.position.longitude=-83.9999;
 s.telemetry.navController.crossTrackM=-9.1;
 const g=navigationView(s);expect(g.lateralValid).toBe(true);expect(g.desiredTrackDeg).toBeCloseTo(0);
 expect(cdiDeflection(g,250)).toBeCloseTo(-9.1/250);
 s.telemetry.navController.navBearingDeg=-30;expect(navigationView(s).desiredTrackDeg).toBeCloseTo(0);
});
it('does not attach an old target or cross-track sample to the newly announced waypoint',()=>{
 const s=snapshot();s.mission.currentSeq=3;
 expect(navigationView(s)).toMatchObject({seq:3,lateralValid:false});
 s.telemetry.navController.missionSeq=3;expect(navigationView(s).lateralValid).toBe(false); // old target with a new seq tag
 const p={lat:35.01,lon:-83.995};Object.assign(s.telemetry,{latitude:p.lat,longitude:p.lon});
 Object.assign(s.telemetry.navController,{position:{latitude:p.lat,longitude:p.lon},positionTarget:{lat:35.01,lon:-83.99},waypointDistanceM:distance(p,{lat:35.01,lon:-83.99}),targetBearingDeg:bearing(p,{lat:35.01,lon:-83.99})});
 expect(navigationView(s)).toMatchObject({seq:3,lateralValid:true});expect(navigationView(s).desiredTrackDeg).toBeCloseTo(90,1);
});
it('declines a CDI when the autopilot is flying a different line or the mission is unverified',()=>{
 const s=snapshot();s.telemetry.navController.crossTrackM=200;expect(navigationView(s).lateralValid).toBe(false);
 s.mission.synchronization='changed';expect(navigationView(s).valid).toBe(false);
});
it('resolves the first route leg after an at-home VTOL takeoff without treating 0,0 as a waypoint',()=>{
 const s=snapshot();s.mission.items[1]=item(1,0,0,84);
 expect(missionSequence(s)).toMatchObject({fromSeq:1,fromName:'TAKEOFF',from:{lat:35,lon:-84}});
 expect(navigationView(s).lateralValid).toBe(true);
});
