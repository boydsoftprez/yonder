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
