// SPDX-License-Identifier: GPL-3.0-or-later
import {describe,it,expect} from 'vitest';
import {createMissionItem} from './mission-commands.mjs';
import {editMission} from './mission-edit.mjs';
const workflowPath='./flight-workflow.mjs';
const workflow = await import(/* @vite-ignore */ workflowPath).catch(()=>null);
const editingPath='./mission-action-edit.mjs';
const editing = await import(/* @vite-ignore */ editingPath).catch(()=>null);
const snapshot={connected:true,identity:{generation:'a'},telemetry:{mode:'AUTO',armed:true,fields:{mode:{valid:true}}},mission:{currentSeq:2,currentFresh:true,items:[{seq:2}]},capabilities:{modes:[{name:'AUTO',customMode:10},{name:'RTL',customMode:11},{name:'GUIDED',customMode:15}],flightControl:['heading','altitude','speed','loiter'].map(kind=>({kind,available:true,entersGuided:true}))},operations:[]};
describe('flight workflow boundaries',()=>{
 it('shows actual AUTO while GUIDED has only been requested and acknowledged',()=>{expect(workflow).not.toBeNull();const state=workflow!.flightAnnunciation({...snapshot,operations:[{action:{kind:'mode',customMode:15},state:'accepted',ack:{result:0},effect:{state:'waiting'}}]});expect(state.mode).toBe('AUTO');expect(state.request).toContain('GUIDED');expect(state.outcome).toContain('ACK');expect(state.outcome).not.toContain('captured')});
 it('uses new telemetry for actual mode and suppresses stale reported mode',()=>{expect(workflow).not.toBeNull();expect(workflow!.flightAnnunciation({...snapshot,telemetry:{...snapshot.telemetry,mode:'GUIDED'}}).mode).toBe('GUIDED');expect(workflow!.flightAnnunciation({...snapshot,telemetry:{...snapshot.telemetry,fields:{mode:{valid:false}}}}).mode).toBe('MODE UNAVAILABLE')});
 it('builds one explicit heading request without changing reported state',()=>{expect(workflow).not.toBeNull();expect(workflow!.flightRequest('heading',{headingDeg:123,turnAccelerationMps2:2},snapshot).action).toEqual({kind:'heading',headingDeg:123,reference:'true',turnAccelerationMps2:2});expect(snapshot.telemetry.mode).toBe('AUTO')});
 it('rejects unsupported firmware, missing numbers and stale resume context',()=>{expect(workflow).not.toBeNull();expect(()=>workflow!.flightRequest('heading',{headingDeg:'',turnAccelerationMps2:2},snapshot)).toThrow(/heading/i);expect(()=>workflow!.flightRequest('heading',{headingDeg:90,turnAccelerationMps2:2},{...snapshot,capabilities:{...snapshot.capabilities,flightControl:[]}})).toThrow(/unavailable/i);expect(()=>workflow!.flightRequest('resume',{}, {...snapshot,mission:{...snapshot.mission,currentFresh:false}})).toThrow(/current mission/i)});
 it('keeps home altitude and signed loiter direction explicit in review',()=>{expect(workflow).not.toBeNull();expect(workflow!.flightRequest('loiter',{lat:35,lon:-84,altitudeM:120,datum:'home',radiusM:200,direction:'ccw'},snapshot).action).toEqual({kind:'loiter',target:{lat:35,lon:-84,altitudeM:120,datum:'home'},radiusM:200,direction:'ccw'})});
 it('does not show a previous aircraft request as current',()=>{expect(workflow!.flightAnnunciation({...snapshot,operations:[{vehicleGeneration:'old-aircraft',action:{kind:'mode',customMode:15},state:'accepted'}]}).request).toBe('')});
 it('maps an expanded scene and touch regions without stretching instrument geometry',()=>{expect(workflow).not.toBeNull();const viewport=workflow!.pfdViewport(1200,650);expect(viewport.width).toBe(1200);expect(viewport.height).toBe(650);expect(viewport.x).toBe(-280);expect(viewport.edgeShift).toBe(280);expect(viewport.centerY).toBeCloseTo(225/650);const hit=workflow!.pfdHitRegion(viewport,[24-viewport.edgeShift,63,88,296]);expect(hit.left).toBe('2%');expect(parseFloat(hit.width)).toBeCloseTo(88/12)});
});
describe('mission action conversion',()=>{
 it('changes waypoint to loiter with defaults while preserving identity and geographic datum',()=>{expect(editing).not.toBeNull();const waypoint={...createMissionItem(16,{lat:35,lon:-84,alt:100,frame:6}),seq:2,params:[77,40,50,99]};const item=editing!.changeMissionAction(waypoint,17);expect(item).toMatchObject({seq:2,command:17,lat:35,lon:-84,alt:100,frame:6,params:[0,0,0,0]});expect(waypoint.command).toBe(16)});
 it('does not interpret a non-geographic command frame as a waypoint datum',()=>{const command={...createMissionItem(183),seq:4};const converted=editing!.changeMissionAction(command,16);expect(converted.frame).toBe(3);expect(converted.params).toEqual([0,0,0,0])});
 it('keeps a jump to a converted item valid',()=>{expect(editing).not.toBeNull();const waypoint={...createMissionItem(16,{lat:35,lon:-84,alt:100}),seq:1};const jump={...createMissionItem(177),seq:2,params:[1,2,0,0]};const changed=editMission({items:[waypoint,jump]}, {kind:'replace',seq:1,item:editing!.changeMissionAction(waypoint,17)});expect(changed.items[1].params[0]).toBe(1)});
 it('maps radius to correct command parameter and does not invent timed-loiter radius',()=>{expect(editing).not.toBeNull();expect(editing!.loiterPresentation({...createMissionItem(17),params:[0,0,-250,0]})).toMatchObject({radiusM:250,direction:'ccw',duration:'Unlimited',radiusIndex:3});expect(editing!.loiterPresentation({...createMissionItem(31),params:[0,300,0,0]})).toMatchObject({radiusM:300,direction:'cw',radiusIndex:2});expect(editing!.loiterPresentation(createMissionItem(19))).toMatchObject({radiusM:null,radiusIndex:null,direction:'cw',duration:'30 s',radiusSource:'WP_LOITER_RAD'})});
});
it('matches the backend airspeed minimum',()=>{
 expect(()=>workflow!.flightRequest('speed',{airspeedMps:.009,accelerationMps2:1},snapshot)).toThrow(/airspeed/i);
 expect(workflow!.flightRequest('speed',{airspeedMps:.01,accelerationMps2:1},snapshot).action.airspeedMps).toBe(.01);
});
it('retains terminal outcomes after an accepted ACK',()=>{
 for(const state of ['unknown','failed','rejected'])expect(workflow!.flightAnnunciation({...snapshot,operations:[{action:{kind:'heading',headingDeg:90},state,ack:{result:0},effect:{state:'unavailable'}}]}).outcome).toContain(state);
});
it('requires a new absolute altitude when converting a relative waypoint to Set Home',()=>{
 const item=createMissionItem(16,{lat:35,lon:-84,alt:100,frame:6});
 expect(editing!.changeMissionAction(item,179)).toMatchObject({lat:35,lon:-84,frame:0,alt:null});
 expect(item.alt).toBe(100);expect(item.frame).toBe(6);
});
describe('mission start and resume boundaries',()=>{
 it.each([-1,0,2000])('refuses sequence %s as a continue-AUTO item',seq=>{
  const state={...snapshot,mission:{synchronization:'verified',currentFresh:true,currentSeq:seq,items:[{seq},{seq:1}]}};
  expect(()=>workflow!.flightRequest('resume',{},state)).toThrow(/mission|home|sequence/i);
 });
 it('keeps valid resume at the backend sequence bounds',()=>{
  for(const seq of [1,1999]){
   const state={...snapshot,mission:{synchronization:'verified',currentFresh:true,currentSeq:seq,items:[{seq}]}};
   expect(workflow!.flightRequest('resume',{},state).action).toEqual({kind:'continue-auto',seq,autoMode:10});
  }
 });
 it('refuses resume outside a verified aircraft mission or with the wrong AUTO mapping',()=>{
  const mission={synchronization:'verified',currentFresh:true,currentSeq:1,items:[{seq:1}]};
  for(const change of [{synchronization:'receiving'},{currentSeq:1.5},{items:[{seq:2}]}])expect(()=>workflow!.flightRequest('resume',{}, {...snapshot,mission:{...mission,...change}})).toThrow(/mission/i);
  expect(()=>workflow!.flightRequest('resume',{}, {...snapshot,mission,capabilities:{...snapshot.capabilities,modes:[{name:'AUTO',customMode:4}]}})).toThrow(/AUTO/i);
 });
 it('builds a separate mission-start request at home without arming',()=>{
  const state={...snapshot,telemetry:{...snapshot.telemetry,armed:false},mission:{synchronization:'verified',currentFresh:true,currentSeq:0,items:[{seq:0},{seq:1}]}};
  expect(workflow!.flightRequest('mission-start',{},state).action).toEqual({kind:'mission-start'});
  expect(state.telemetry.armed).toBe(false);
 });
 it('refuses start without a verified, fresh mission containing authored items',()=>{
  const mission={synchronization:'verified',currentFresh:true,currentSeq:0,items:[{seq:0},{seq:1}]};
  for(const change of [{synchronization:'receiving'},{currentFresh:false},{items:[{seq:0}]},{currentSeq:1}])expect(()=>workflow!.flightRequest('mission-start',{}, {...snapshot,mission:{...mission,...change}})).toThrow(/mission|current/i);
 });
});
