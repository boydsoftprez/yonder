// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {editMission,exportWpl} from './mission-edit.mjs';
import {parseMission} from './mission-import.mjs';
import {controllerHomeRequest} from './mission-home.mjs';
import {planRoute,plannedAltitude} from './mission-profile.mjs';
import {missionWire} from './cockpit-state.mjs';
const home={lat:35,lon:-84,alt:300};
const item=(seq,command,lat,lon,params=[0,0,0,0])=>({seq,command,frame:3,params,lat,lon,alt:100,current:false,autocontinue:true});
const mission={name:'Test',home,items:[item(1,22,0,0),item(2,16,35.01,-84),item(3,177,0,0,[2,3,0,0])]};
it('updates planning home without mutating the source, waypoint values, sequences or jump targets',()=>{
 const next=editMission(mission,{kind:'set-home',home:{lat:35.001,lon:-84,alt:350}});
 expect(mission.home).toEqual(home);expect(next.items).toEqual(mission.items);
 expect(next.home).toEqual({lat:35.001,lon:-84,alt:350});
 expect(plannedAltitude(next.items[1],next.home).altitudeM).toBe(450);
 expect(parseMission(exportWpl(next),'plan.waypoints').home).toEqual(next.home);
});
it('resolves current-location takeoff from planning home and omits it when home is missing',()=>{
 expect(planRoute(mission).legs[0].lengthM).toBeLessThan(2000);
 expect(planRoute({...mission,home:null}).legs).toEqual([]);
});
it('rejects missing or ambiguous controller coordinates and captures reported home separately',()=>{
 for(const value of [{...home,lat:''},{...home,alt:true},{...home,lat:0,lon:0},{...home,lon:Infinity}])expect(()=>controllerHomeRequest(value,null)).toThrow();
 expect(controllerHomeRequest({...home,alt:350},home)).toEqual({kind:'set-home',home:{...home,alt:350},expectedHome:home});
});
it('uploads the controller home while retaining authored relative heights and local planning home',()=>{
 const next=editMission(mission,{kind:'set-home',home:{...home,alt:350}});
 const wire=missionWire(next,{identity:{autopilot:3},mission:{items:[],synchronization:'verified'},telemetry:{homePosition:home}});
 expect(wire[0]).toMatchObject({x:35,y:-84,z:300});expect(wire[1].z).toBe(100);expect(next.home.alt).toBe(350);
});
