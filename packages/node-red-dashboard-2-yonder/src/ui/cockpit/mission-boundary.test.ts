// SPDX-License-Identifier: GPL-3.0-or-later
import {describe,it,expect} from 'vitest';
import {aircraftMission,missionWire,createCockpitApi} from './cockpit-state.mjs';
import {MISSION_COMMANDS,createMissionItem,validateMissionItem} from './mission-commands.mjs';
import {editMission,exportWpl} from './mission-edit.mjs';
import {parseMission} from './mission-import.mjs';
const home={seq:0,command:16,frame:0,params:[0,0,0,0],x:35,y:-84,z:280,current:true,autocontinue:true};
const item={seq:1,command:16,frame:3,params:[0,0,0,0],x:35.01,y:-84.02,z:100,current:false,autocontinue:true};
const snapshot={identity:{autopilot:3},telemetry:{},mission:{items:[home,item],revision:'a'}};
describe('production mission boundaries',()=>{
 it('excludes the aircraft home from authored items but preserves it on upload',()=>{const mission=aircraftMission(snapshot);expect(mission.items).toHaveLength(1);expect(mission.items[0]).toMatchObject({lat:35.01,lon:-84.02,alt:100});expect(missionWire(mission,snapshot)).toEqual([home,item])});
 it('does not erase sequence zero on an unknown autopilot',()=>{expect(aircraftMission({...snapshot,identity:{autopilot:99}}).items).toHaveLength(2)});
 it('preserves local edits and remaps mission jumps without changing the snapshot',()=>{const mission=aircraftMission(snapshot);mission.items.push({...mission.items[0],seq:2,command:177,frame:2,params:[1,2,0,0]});const changed=editMission(mission,{kind:'insert',afterSeq:null,item:createMissionItem(16,{lat:35,lon:-84,alt:80})});expect(changed.items.find(x=>x.command===177).params[0]).toBe(2);expect(snapshot.mission.items).toEqual([home,item])});
 it('retains all 55 parameterized command forms',()=>{expect(MISSION_COMMANDS).toHaveLength(55);for(const c of MISSION_COMMANDS){const value=createMissionItem(c.id,{lat:35,lon:-84,alt:100});expect(value.command).toBe(c.id);expect(Array.isArray(validateMissionItem(value).errors)).toBe(true)}});
 it('round trips mission coordinates and datums through WPL',()=>{const mission=aircraftMission(snapshot),text=exportWpl(mission),parsed=parseMission(text,'mission.waypoints');expect(parsed.items).toEqual(mission.items);expect(parsed.home).toEqual(mission.home)});
 it('bounds the upload including the full home record',()=>{const mission=aircraftMission(snapshot);mission.items=Array.from({length:2000},(_,i)=>({...mission.items[0],seq:i+1}));expect(()=>missionWire(mission,snapshot)).toThrow(/2000/)});
 it('uses the authenticated same-origin command boundary exactly once',async()=>{const calls=[];const api=createCockpitApi(async(url,options)=>{calls.push([url,options]);return{ok:true,json:async()=>({accepted:true,operationId:'op'})}});const request={id:'one',vehicleGeneration:'a',confirmed:true,action:{kind:'arm',armed:true}};await api.command(request);expect(calls).toHaveLength(1);expect(calls[0][0]).toBe('/cockpit/api/command');expect(calls[0][1].headers['x-yonder-cockpit']).toBe('1');expect(JSON.parse(calls[0][1].body)).toEqual(request)});
});
it('requires a received ArduPilot home before uploading a new local draft',()=>{const local={items:[{seq:1,command:16,frame:3,params:[0,0,0,0],lat:35,lon:-84,alt:80,current:false,autocontinue:true}]};expect(()=>missionWire(local,{identity:{autopilot:3},telemetry:{homePosition:{lat:35,lon:-84,alt:315}},mission:{items:[]}})).toThrow(/Read the aircraft mission first/)});
it('supports the first upload after a verified empty ArduPlane mission read',()=>{const local={items:[{seq:1,command:16,frame:3,params:[0,0,0,0],lat:35,lon:-84,alt:80,current:false,autocontinue:true}]};const wire=missionWire(local,{identity:{autopilot:3},telemetry:{homePosition:{lat:35,lon:-84,alt:315}},mission:{items:[],synchronization:'verified'}});expect(wire[0]).toMatchObject({seq:0,command:16,frame:0,x:35,y:-84,z:315});expect(wire[1].seq).toBe(1)});
