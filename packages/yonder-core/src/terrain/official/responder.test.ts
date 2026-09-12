// SPDX-License-Identifier: GPL-3.0-or-later
import {describe, expect, it} from 'vitest';
import {common, minimal, standard, MavLinkProtocolV2, type MavLinkData} from 'node-mavlink';
import {decodeDatagram} from '../../mav/protocol.js';
import type {Clock} from '../../apply/types.js';
import type {VehicleSnapshot} from '../../mav/types.js';
import {TerrainResponder} from './responder.js';

class FakeClock implements Clock {
  time=1000; private next=0; private timers=new Map<number,{at:number; fn:()=>void}>();
  now=()=>this.time;
  setTimer=(ms:number,fn:()=>void)=>{const id=++this.next;this.timers.set(id,{at:this.time+ms,fn});return id;};
  clearTimer=(id:unknown)=>{this.timers.delete(id as number);};
  advance(ms:number){const end=this.time+ms;for(;;){const due=[...this.timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;this.time=due[1].at;this.timers.delete(due[0]);due[1].fn();}this.time=end;}
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const packet=(message:MavLinkData,system=1,component=1)=>new MavLinkProtocolV2(system,component).serialize(message,0);
const request=(mask=1n)=>packet(Object.assign(new common.TerrainRequest(),{lat:351000000,lon:-840000000,gridSpacing:30,mask}));
const vehicle={connected:true,identity:{system:1,component:1,generation:'one'},busy:false} as VehicleSnapshot;

function rig(options:{busy?:boolean; read?:()=>Promise<any>; enabled?:boolean}={}) {
  const clock=new FakeClock(), sent:ReturnType<typeof decodeDatagram>[]=[];
  vehicle.busy=options.busy??false; vehicle.identity={system:1,component:1,generation:'one'} as any;
  let reads=0, router='router-one';
  const responder=new TerrainResponder({vehicle:()=>vehicle,clock,routerGeneration:()=>router,serialBaud:()=>57600,
    policy:()=>({enabled:options.enabled??true,provider:'ardupilot-srtm1',quotaMiB:2048}),
    store:{readSubgrid:async()=>{reads++;return options.read?options.read():{available:true,heights:Array.from({length:16},(_,i)=>i-8),generations:['generation']};}},
    send:async bytes=>{sent.push(decodeDatagram(bytes));},
  });
  const feed=(message:MavLinkData,system=1,component=1)=>responder.receive(packet(message,system,component));
  const compatible=()=>{
    feed(Object.assign(new minimal.Heartbeat(),{autopilot:3,type:1}));
    feed(Object.assign(new standard.AutopilotVersion(),{capabilities:512n,flightSwVersion:0x040701ff}));
    for(const [paramId,paramValue] of [['TERRAIN_ENABLE',1],['TERRAIN_SPACING',30],['TERRAIN_OPTIONS',2]])feed(Object.assign(new common.ParamValue(),{paramId,paramValue}));
  };
  return {clock,sent,responder,feed,compatible,reads:()=>reads,setRouter:(value:string)=>{router=value;}};
}

describe('TerrainResponder',()=>{
  it('encodes only requested complete terrain data with the injected vehicle identity',async()=>{
    const r=rig();r.compatible();r.responder.receive(request());await flush();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0][0]).toMatchObject({system:254,component:192});
    expect(r.sent[0][0].data).toMatchObject({lat:351000000,lon:-840000000,gridSpacing:30,gridbit:0});
    expect((r.sent[0][0].data as common.TerrainData).data.slice(0,4)).toEqual([-8,-7,-6,-5]);
    expect(r.responder.snapshot()).toMatchObject({sent:1,missing:0,controller:{report:null}});
    r.responder.close();
  });

  it('deduplicates request bits and paces a second frame',async()=>{
    const r=rig();r.compatible();r.responder.receive(request(3n));r.responder.receive(request(3n));await flush();
    expect(r.reads()).toBe(1);expect(r.sent).toHaveLength(1);
    r.clock.advance(100);await flush();
    expect(r.reads()).toBe(2);expect(r.sent).toHaveLength(2);
    r.responder.close();
  });

  it('keeps terrain queued while a command transaction is busy and sends nothing while disabled',async()=>{
    const r=rig({busy:true});r.compatible();r.responder.receive(request());await flush();
    expect(r.sent).toHaveLength(0);expect(r.reads()).toBe(0);
    vehicle.busy=false;r.clock.advance(100);await flush();expect(r.sent).toHaveLength(1);r.responder.close();
    const disabled=rig({enabled:false});disabled.compatible();disabled.responder.receive(request());await flush();
    expect(disabled.sent).toHaveLength(0);disabled.responder.close();
  });

  it('suppresses service when a second fresh autopilot is observed',async()=>{
    const r=rig();r.compatible();r.feed(Object.assign(new minimal.Heartbeat(),{autopilot:3,type:1}),2,1);r.responder.receive(request());await flush();
    expect(r.sent).toHaveLength(0);expect(r.responder.snapshot().ambiguity).toBe(true);r.responder.close();
  });

  it('drops an inflight read after controller generation or router generation changes',async()=>{
    let resolve:(value:any)=>void=()=>{};
    const r=rig({read:()=>new Promise(done=>{resolve=done;})});r.compatible();r.responder.receive(request());await flush();
    vehicle.identity={...vehicle.identity!,generation:'two'};resolve({available:true,heights:Array(16).fill(1),generations:['generation']});await flush();
    expect(r.sent).toHaveLength(0);
    vehicle.identity={...vehicle.identity!,generation:'one'};r.compatible();r.responder.receive(request());await flush();r.setRouter('router-two');resolve({available:true,heights:Array(16).fill(1),generations:['generation']});await flush();
    expect(r.sent).toHaveLength(0);r.responder.close();
  });

  it('drops an inflight subgrid that expires before its read completes',async()=>{
    let resolve:(value:any)=>void=()=>{};
    const r=rig({read:()=>new Promise(done=>{resolve=done;})});r.compatible();r.responder.receive(request());await flush();
    r.clock.advance(5001);resolve({available:true,heights:Array(16).fill(1),generations:['generation']});await flush();
    expect(r.sent).toHaveLength(0);r.responder.close();
  });

  it('clears controller report on selected vehicle generation change',()=>{
    const r=rig();r.compatible();r.feed(Object.assign(new common.TerrainReport(),{lat:1,lon:2,spacing:30,pending:3,loaded:4}));
    expect(r.responder.snapshot().controller.report).toMatchObject({pending:3,loaded:4});
    vehicle.identity={...vehicle.identity!,generation:'two'};
    expect(r.responder.snapshot().controller.report).toBeNull();r.responder.close();
  });

  it('deduplicates a request while its matching subgrid read is in flight',async()=>{
    let resolve:(value:any)=>void=()=>{};
    const r=rig({read:()=>new Promise(done=>{resolve=done;})});r.compatible();r.responder.receive(request());await flush();r.responder.receive(request());await flush();
    expect(r.reads()).toBe(1);resolve({available:true,heights:Array(16).fill(1),generations:['generation']});await flush();
    r.clock.advance(100);await flush();expect(r.reads()).toBe(1);expect(r.sent).toHaveLength(1);r.responder.close();
  });

  it('fails closed for the fresh window after more than sixteen autopilots are observed',async()=>{
    const r=rig();r.compatible();for(let system=2;system<=17;system++)r.feed(Object.assign(new minimal.Heartbeat(),{autopilot:3,type:1}),system,1);
    r.responder.receive(request());await flush();
    expect(r.responder.snapshot()).toMatchObject({ambiguity:true,identityOverflow:true});expect(r.sent).toHaveLength(0);r.responder.close();
  });

  it('reports observed competing terrain data without claiming enforcement or direct-route visibility',()=>{
    const r=rig();r.responder.receive(packet(Object.assign(new common.TerrainData(),{lat:351000000,lon:-840000000,gridSpacing:30,gridbit:0,data:Array(16).fill(1)}),42,1));
    expect(r.responder.snapshot().providerOwnership).toMatchObject({policy:'operator-managed',exclusivityEnforced:false,directRouteVisibility:'unverified',competition:[{system:42,component:1,fresh:true}]});
    r.responder.close();
  });
});
