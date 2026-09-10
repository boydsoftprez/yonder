// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture} from '../../../cockpit/fixture.mjs';
const hosts=[];
afterEach(()=>{hosts.splice(0).forEach(w=>w.unmount());localStorage.clear()});
function host(){
  const report=fixture(),points=[[1,0,35,-83,0,1],[2,1000,35.001,-83,100,1]];
  report.ownTrail={epoch:'test',revision:0,latest:2,bootMs:1000,clockAt:report.at,startBootMs:0,tail:points[1],points};
  const api={command:vi.fn(),dataOptions:vi.fn()};
  const provider={configure:vi.fn(),status:()=>({}),refreshOffline:async()=>({}),pollTraffic:vi.fn(),trafficSnapshot:()=>({tracks:[]}),close:vi.fn()};
  const w=mount(YonderCockpit,{props:{id:'trail-test',report,api,dataProvider:provider,terrainComponent:null},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true}}});hosts.push(w);return {w,api,report};
}
it('opens map trail controls, saves distance/time/power options and clears/restores only local depiction',async()=>{
  const {w,api}=host();await flushPromises();
  await w.get('[aria-label="Aircraft breadcrumb settings"]').trigger('click');
  await w.get('select[aria-label="Aircraft trail window"]').setValue('distance');
  await w.get('input[aria-label="Aircraft trail distance"]').setValue('2');
  await w.get('select[aria-label="Aircraft trail distance units"]').setValue('mi');
  expect(w.vm.ownTrailOptions).toMatchObject({mode:'distance',distance:2,unit:'mi'});
  await w.get('select[aria-label="Aircraft trail window"]').setValue('time');
  await w.get('input[aria-label="Aircraft trail minutes"]').setValue('30');
  await w.get('select[aria-label="Aircraft trail window"]').setValue('power');
  expect(w.vm.ownTrailDisplay.segments.flat()).toHaveLength(2);
  await w.findAll('button').find(b=>b.text()==='Clear displayed trail').trigger('click');
  expect(w.vm.ownTrailDisplay.segments).toEqual([]);
  await w.findAll('button').find(b=>b.text()==='Restore recorded trail').trigger('click');
  expect(w.vm.ownTrailDisplay.segments.flat()).toHaveLength(2);
  expect(api.command).not.toHaveBeenCalled();expect(api.dataOptions).not.toHaveBeenCalled();
  w.unmount();hosts.splice(hosts.indexOf(w),1);
  const next=host();await flushPromises();expect(next.w.vm.ownTrailOptions).toMatchObject({mode:'power',distance:2,unit:'mi',minutes:30});
});
it('reports unavailable recording instead of relabeling browser uptime as aircraft power-on',async()=>{
  const {w,report}=host();await w.setProps({report:{...report,ownTrail:null}});
  await w.get('[aria-label="Aircraft breadcrumb settings"]').trigger('click');
  expect(w.text()).toContain('Trail recording requires the updated flight service.');
});
