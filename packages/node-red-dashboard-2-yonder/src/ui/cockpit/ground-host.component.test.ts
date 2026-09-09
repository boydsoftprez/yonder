// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {toRaw} from 'vue';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture} from '../../../cockpit/fixture.mjs';
const hosts=[];
afterEach(()=>{hosts.splice(0).forEach(w=>w.unmount());vi.useRealTimers()});
function host(initialDetails=true){
  const report=fixture();report.dataOptions={...report.dataOptions,sourceMode:'aircraft',terrain:true,imagery:true,traffic:true};
  if(!initialDetails)delete report.dataOptions;
  const api={command:vi.fn(),dataOptions:vi.fn(async()=>({ok:true}))};
  const provider={configure:vi.fn(),status:()=>({mode:'ground'}),refreshOffline:vi.fn(async()=>({})),pollTraffic:vi.fn(),trafficSnapshot:()=>({tracks:[]}),close:vi.fn()};
  const w=mount(YonderCockpit,{props:{id:'ground-host-test',report,api,dataProvider:provider,terrainComponent:null},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true}}});hosts.push(w);return {w,api,provider};
}
it('keeps a new browser on ground sources without rewriting aircraft configuration from a read',async()=>{
  const {w,api,provider}=host();await flushPromises();
  expect(w.vm.sourceMode).toBe('ground');expect(api.dataOptions).not.toHaveBeenCalled();expect(api.command).not.toHaveBeenCalled();
  expect(provider.configure).toHaveBeenLastCalledWith(expect.objectContaining({mode:'ground',terrain:true,imagery:true,traffic:true}));
  expect(toRaw(w.findComponent({name:'YonderCockpitMap'}).props('dataProvider'))).toBe(provider);
});
it('preserves operator choices made while initial aircraft details are loading',async()=>{
  const {w,api}=host(false);await flushPromises();
  w.vm.onlineMap=true;await w.vm.$nextTick();await new Promise(r=>setTimeout(r,10));
  expect(api.dataOptions).not.toHaveBeenCalled();
  await w.setProps({report:{...w.props('report'),dataOptions:{terrain:true,imagery:false,traffic:false,cameraId:'elp',aircraftDatum:'EGM96'}}});await flushPromises();await new Promise(r=>setTimeout(r,10));
  expect(w.vm.onlineMap).toBe(true);expect(w.vm.onlineTerrain).toBe(true);expect(w.vm.cameraId).toBe('elp');
  expect(api.dataOptions).toHaveBeenLastCalledWith(expect.objectContaining({imagery:true,terrain:true,cameraId:'elp',aircraftDatum:'EGM96'}));
});
it('applies a small traffic radius and an explicit aircraft source choice without sending flight commands',async()=>{
  const {w,api,provider}=host();await flushPromises();
  w.vm.trafficRange=5;w.vm.sourceMode='aircraft';await w.vm.$nextTick();await new Promise(r=>setTimeout(r,10));await flushPromises();
  expect(api.dataOptions).toHaveBeenLastCalledWith(expect.objectContaining({sourceMode:'aircraft',trafficRadiusNm:5}));
  expect(provider.configure).toHaveBeenLastCalledWith(expect.objectContaining({mode:'aircraft',trafficRadiusNm:5}));expect(api.command).not.toHaveBeenCalled();
  w.vm.sourceMode='offline';await w.vm.$nextTick();
  expect(provider.configure).toHaveBeenLastCalledWith(expect.objectContaining({mode:'offline'}));
});
it('explains map-only traffic and links directly to ground-data setup without a flight command',async()=>{
 const {w,api}=host();await flushPromises();
 await w.setProps({report:{...w.props('report'),traffic:{status:'live',altitudeModel:null,message:'ADSB.lol · 1 target observed within 10 NM',tracks:[{id:'abc123',altitudeMslM:null}]}}});
 w.vm.panel='traffic';await w.vm.$nextTick();
 expect(w.text()).toMatch(/1 target.*map only/i);
 const setup=w.findAll('button').find(b=>b.text()==='Traffic data setup');
 expect(setup).toBeDefined();await setup!.trigger('click');
 expect(w.find('input[aria-label="Ground relay origin"]').exists()).toBe(true);
 expect(api.command).not.toHaveBeenCalled();
});

it('pauses traffic on a bench controller without GPS and resumes at the acquired fix',async()=>{
 const provider={pollTraffic:vi.fn(async()=>{}),trafficSnapshot:vi.fn(()=>({tracks:[{id:'old'}]}))};
 const context={report:null,props:{},flight:{live:true},telemetry:{ready:true,fixType:0,satellites:0,latitude:0,longitude:0},onlineTraffic:true,sourceMode:'ground',groundData:provider};
 YonderCockpit.methods.refreshGroundTraffic.call(context);
 expect(provider.pollTraffic).not.toHaveBeenCalled();
 expect(context.trafficReport).toMatchObject({tracks:[],message:expect.stringMatching(/paused.*No GPS fix.*0 satellites/)});
 Object.assign(context.telemetry,{fixType:3,latitude:35,longitude:-84});
 YonderCockpit.methods.refreshGroundTraffic.call(context);
 expect(provider.pollTraffic).toHaveBeenCalledWith({lat:35,lon:-84});
 expect(provider.trafficSnapshot).toHaveBeenLastCalledWith({lat:35,lon:-84});
 context.telemetry.fixType=null;
 YonderCockpit.methods.refreshGroundTraffic.call(context);
 expect(provider.pollTraffic).toHaveBeenCalledTimes(1);
 expect(context.trafficReport.tracks).toEqual([]);
});

it('exposes a traffic-only relay without changing aircraft data settings or sending commands',async()=>{
 const {w,api,provider}=host();await flushPromises();w.vm.panel='display';await w.vm.$nextTick();
 await w.find('input[aria-label="ADS-B relay origin"]').setValue('http://127.0.0.1:4223');
 await w.findAll('button').find(b=>b.text()==='Apply ADS-B relay')!.trigger('click');
 expect(provider.configure).toHaveBeenLastCalledWith(expect.objectContaining({groundRelayUrl:'',trafficRelayUrl:'http://127.0.0.1:4223',mode:'ground'}));
 expect(api.dataOptions).not.toHaveBeenCalled();expect(api.command).not.toHaveBeenCalled();
 localStorage.removeItem('yonder-traffic-relay-v1');
});
