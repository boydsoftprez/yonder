// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {packFlight} from 'yonder-core/cockpit-wire';
import {fixture} from '../../../cockpit/fixture.mjs';
import {createCockpitApi} from './cockpit-state.mjs';
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
it('reports a stopped flight service instead of exposing an empty JSON parse error',async()=>{
 const api=createCockpitApi(async()=>new Response('',{status:502}));
 await expect(api.state()).rejects.toThrow(/flight service.*unavailable.*502/i);api.close();
});
it('keeps a non-JSON admission refusal distinct from an unavailable service',async()=>{
 const api=createCockpitApi(async()=>new Response('Forbidden',{status:403}));
 await expect(api.command({})).rejects.toMatchObject({admissionRejected:true,message:expect.stringContaining('403')});api.close();
});
it('keeps flight updates independent of slow mission transfer and caches unchanged details',async()=>{
 const state=fixture(), calls:string[]=[];
 let finishMission:(value:unknown)=>void;
 const mission=new Promise(resolve=>{finishMission=resolve});
 const api=createCockpitApi(async(path:string)=>{
   calls.push(path);
   if(path.endsWith('/flight'))return {ok:true,json:async()=>packFlight(state,'a')};
   if(path.endsWith('/details'))return {ok:true,json:async()=>({detailKey:'a',identity:state.identity,capabilities:state.capabilities,operations:[]})};
   if(path.endsWith('/mission'))return {ok:true,json:async()=>mission};
   throw new Error('Unexpected route '+path);
 });
 const first=await api.state();expect(first.telemetry.rollDeg).toBe(8);
 await settle();
 const second=await api.state();expect(second.telemetry.rollDeg).toBe(8);expect(second.mission.items).toEqual([]);
 finishMission!({generation:state.identity.generation,mission:state.mission});await settle();
 const third=await api.state();expect(third.mission.items).toHaveLength(state.mission.items.length);
 expect(calls.filter(p=>p.endsWith('/details'))).toHaveLength(1);
 expect(calls.filter(p=>p.endsWith('/mission'))).toHaveLength(1);
 expect(calls).not.toContain('/cockpit/api/state');api.close();
});
it('displays the actual server refusal rather than a generic HTTP status',async()=>{
 const api=createCockpitApi(async()=>({ok:false,status:409,json:async()=>({error:'The aircraft mission changed; read it again'})}));
 await expect(api.command({})).rejects.toThrow('The aircraft mission changed; read it again');api.close();
});
it('invalidates cached mission and controls immediately on vehicle generation change',async()=>{
 let state=fixture();
 const api=createCockpitApi(async(path:string)=>({ok:true,json:async()=>path.endsWith('/flight')?packFlight(state,state.identity.generation):path.endsWith('/details')?{detailKey:state.identity.generation,identity:state.identity,capabilities:state.capabilities,operations:[]}:{generation:state.identity.generation,mission:state.mission}}));
 await api.state();await settle();expect((await api.state()).identity?.generation).toBe('fixture-only');
 state={...state,identity:{...state.identity,generation:'new-aircraft'}};
 const changed=await api.state();expect(changed.identity).toBeNull();expect(changed.mission.items).toEqual([]);expect(changed._detailsReady).toBe(false);api.close();
});
