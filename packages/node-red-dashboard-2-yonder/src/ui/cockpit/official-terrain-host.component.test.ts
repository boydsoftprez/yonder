// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import {toRaw} from 'vue';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture} from '../../../cockpit/fixture.mjs';

const hosts:any[]=[];afterEach(()=>hosts.splice(0).forEach(w=>w.unmount()));
it('starts slow terrain status ownership with the cockpit, copies the real map viewport, and stops on teardown',async()=>{
  let notify:any;
  const status={policy:{enabled:false},coverage:{areas:[],job:null},service:{controller:{report:null}},source:{dataset:'Official ArduPilot ALOS-derived SRTM1'}};
  const terrainClient:any={start:vi.fn(callback=>{notify=callback;callback({status,error:null});return terrainClient}),stop:vi.fn(),status:vi.fn(async()=>status),policy:vi.fn(async()=>({policy:{enabled:false,provider:'ardupilot-srtm1',quotaMiB:2048},revision:'a'.repeat(64),apply:{state:'idle'},pendingId:null})),preview:vi.fn(),prepare:vi.fn(),cancel:vi.fn(),pin:vi.fn(),remove:vi.fn(),refreshController:vi.fn()};
  const dataProvider={configure:vi.fn(),status:()=>({}),refreshOffline:async()=>({}),pollTraffic:vi.fn(),trafficSnapshot:()=>({tracks:[]}),close:vi.fn()};
  const MapStub={name:'YonderCockpitMap',data:()=>({map:{getBounds:()=>({getSouth:()=>34.9,getNorth:()=>35.2,getWest:()=>-84.3,getEast:()=>-83.7})}}),template:'<div />'};
  const w=mount(YonderCockpit,{props:{id:'official-terrain-host',report:fixture(),api:{command:vi.fn(),dataOptions:vi.fn()},dataProvider,terrainComponent:null,terrainServiceClient:terrainClient},global:{stubs:{YonderCockpitMap:MapStub,YonderPicture:true,TerrainVision:true}}});hosts.push(w);await flushPromises();
  expect(terrainClient.start).toHaveBeenCalledTimes(1);expect(terrainClient.refreshController).not.toHaveBeenCalled();
  const entry=w.get('button[aria-label="Official terrain service"]');expect(entry.text()).toContain('Disabled');await entry.trigger('click');await flushPromises();
  expect(w.vm.officialTerrainMapBounds).toEqual({south:34.9,north:35.2,west:-84.3,east:-83.7});expect(w.text()).toContain('Service disabled');
  notify({status:null,error:new Error('daemon disconnected')});await w.vm.$nextTick();expect(w.vm.officialTerrainStatus).toBeNull();expect(entry.text()).toContain('Unavailable');expect(w.text()).toContain('daemon disconnected');
  w.unmount();hosts.splice(hosts.indexOf(w),1);expect(terrainClient.stop).toHaveBeenCalledTimes(1);
});

it('rejects a degenerate hidden map viewport and preserves usable manual bounds',async()=>{
  const status={policy:{enabled:false},coverage:{areas:[],job:null},service:{controller:{report:null}},source:{dataset:'Official ArduPilot ALOS-derived SRTM1'}};
  const terrainClient:any={start:vi.fn(callback=>{callback({status,error:null});return terrainClient}),stop:vi.fn(),status:vi.fn(async()=>status),policy:vi.fn(async()=>({policy:{enabled:false,provider:'ardupilot-srtm1',quotaMiB:2048},revision:'a'.repeat(64),apply:{state:'idle'},pendingId:null}))};
  const dataProvider={configure:vi.fn(),status:()=>({}),refreshOffline:async()=>({}),pollTraffic:vi.fn(),trafficSnapshot:()=>({tracks:[]}),close:vi.fn()};
  const MapStub={name:'YonderCockpitMap',data:()=>({map:{getBounds:()=>({getSouth:()=>0,getNorth:()=>0,getWest:()=>0,getEast:()=>0})}}),template:'<div />'};
  const w=mount(YonderCockpit,{props:{id:'official-hidden-map',report:fixture(),api:{command:vi.fn(),dataOptions:vi.fn()},dataProvider,terrainComponent:null,terrainServiceClient:terrainClient},global:{stubs:{YonderCockpitMap:MapStub,YonderPicture:true,TerrainVision:true,MissionPlanning:true}}});hosts.push(w);await flushPromises();
  w.vm.captureOfficialTerrainBounds();const point=fixture().telemetry;
  expect(w.vm.officialTerrainMapBounds).toEqual({south:point.latitude-.025,north:point.latitude+.025,west:point.longitude-.025,east:point.longitude+.025});
  const edited={south:34.8,north:35.2,west:-84.4,east:-83.8};w.vm.officialTerrainMapBounds=edited;w.vm.captureOfficialTerrainBounds();
  expect(w.vm.officialTerrainMapBounds).toEqual(edited);
});

it('uses official samples for current AGL without replacing the detailed display provider',async()=>{
  const status={policy:{enabled:true},coverage:{areas:[],job:null},service:{enabled:true,compatible:true,sent:0,missing:0,controller:{report:null}},source:{dataset:'Official ArduPilot ALOS-derived SRTM1'}};
  const sample={available:true,heightM:300,provider:'ardupilot-srtm1',generation:'official-1',spacingM:30,datum:'MSL',datumEvidence:'Official source evidence'};
  const terrainClient:any={start:vi.fn(callback=>{callback({status,error:null});return terrainClient}),stop:vi.fn(),samples:vi.fn(async()=>({samples:[sample]})),status:vi.fn(async()=>status),policy:vi.fn(async()=>({policy:{enabled:true,provider:'ardupilot-srtm1',quotaMiB:2048},revision:'a'.repeat(64),apply:{state:'idle'},pendingId:null}))};
  const dataProvider={configure:vi.fn(),status:()=>({}),refreshOffline:async()=>({}),pollTraffic:vi.fn(),trafficSnapshot:()=>({tracks:[]}),close:vi.fn()};
  const w=mount(YonderCockpit,{props:{id:'official-agl-host',report:fixture(),api:{command:vi.fn(),dataOptions:vi.fn()},dataProvider,terrainComponent:null,terrainServiceClient:terrainClient},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true}}});hosts.push(w);await flushPromises();
  expect(terrainClient.samples).toHaveBeenCalledWith([{lat:fixture().telemetry.latitude,lon:fixture().telemetry.longitude}]);expect(w.vm.terrainReport.groundElevationM).toBe(300);expect(w.vm.terrainReport.estimatedAglM).toBeCloseTo(107.2);expect(w.vm.terrainReport.officialTerrain).toMatchObject({available:true,provider:'ardupilot-srtm1',datum:'MSL'});expect(toRaw(w.vm.groundData)).toBe(dataProvider);
});

it.each(['poll failure','service disabled'])('does not restore a stale AGL when a pending sample resolves after %s',async event=>{
  let notify:any,resolveFirst:any;
  const enabled={policy:{enabled:true},coverage:{areas:[],job:null},service:{enabled:true,compatible:true,sent:0,missing:0,controller:{report:null}},source:{dataset:'Official ArduPilot ALOS-derived SRTM1'}};
  const disabled={...enabled,policy:{enabled:false},service:{...enabled.service,enabled:false}};
  const sample={available:true,heightM:300,provider:'ardupilot-srtm1',generation:'official-1',spacingM:30,datum:'MSL',datumEvidence:'Official source evidence'};
  const first=new Promise(resolve=>{resolveFirst=resolve});
  const terrainClient:any={start:vi.fn(callback=>{notify=callback;callback({status:enabled,error:null});return terrainClient}),stop:vi.fn(),samples:vi.fn().mockImplementationOnce(()=>first).mockResolvedValue({samples:[sample]})};
  const dataProvider={configure:vi.fn(),status:()=>({}),refreshOffline:async()=>({}),pollTraffic:vi.fn(),trafficSnapshot:()=>({tracks:[]}),close:vi.fn()};
  const w=mount(YonderCockpit,{props:{id:'official-agl-race',report:fixture(),api:{command:vi.fn(),dataOptions:vi.fn()},dataProvider,terrainComponent:null,terrainServiceClient:terrainClient},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true,MissionPlanning:true}}});hosts.push(w);await flushPromises();
  expect(terrainClient.samples).toHaveBeenCalledTimes(1);
  event==='poll failure'?notify({status:null,error:new Error('daemon disconnected')}):notify({status:disabled,error:null});
  resolveFirst({samples:[sample]});await flushPromises();
  expect(w.vm.terrainReport.officialTerrain.available).toBe(false);expect(w.vm.officialTerrainSample).toBeNull();expect(w.vm.officialTerrainSampleBusy).toBe(false);
  notify({status:enabled,error:null});await flushPromises();
  expect(terrainClient.samples).toHaveBeenCalledTimes(2);expect(w.vm.terrainReport.officialTerrain.available).toBe(true);
});
