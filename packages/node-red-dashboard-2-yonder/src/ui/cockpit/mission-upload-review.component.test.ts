// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,it,expect,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture} from '../../../cockpit/fixture.mjs';
const hosts=[];
afterEach(()=>{hosts.splice(0).forEach(w=>w.unmount());localStorage.clear()});
async function review(){
 const report=fixture();report.telemetry.armed=false;report.telemetry.mode='MANUAL';
 const api={command:vi.fn(async()=>({accepted:true,operationId:'upload-test'}))};
 const w=mount(YonderCockpit,{props:{id:'upload-review-test',report,api},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true}}});
 hosts.push(w);await flushPromises();
 w.vm.draft=JSON.parse(JSON.stringify(w.vm.actualMission));w.vm.captureDraftContext();w.vm.reviewUpload();await w.vm.$nextTick();
 return {w,api,report};
}
it('keeps upload review usable across controller-home updates and shows the live reference',async()=>{
 const {w,api,report}=await review();
 const authored=JSON.parse(JSON.stringify(w.vm.draft.items));
 const home={lat:35.0001234,lon:-83.0001234,alt:333.17};
 await w.setProps({report:{...report,telemetry:{...report.telemetry,homePosition:home}}});
 expect(w.get('.cockpit-confirm').element.disabled).toBe(false);
 expect(w.vm.draftContextChanged).toBe(false);
 expect(w.get('[aria-label="Review aircraft command"]').text()).toContain('333.17 m MSL');
 expect(w.get('[aria-label="Review aircraft command"]').text()).toContain('can update while disarmed');
 expect(w.vm.draft.items).toEqual(authored);expect(api.command).not.toHaveBeenCalled();
 await w.get('.cockpit-confirm').trigger('click');
 expect(api.command).toHaveBeenCalledTimes(1);
 expect(api.command.mock.calls[0][0]).toMatchObject({vehicleGeneration:report.identity.generation,expectedMissionRevision:report.mission.revision,confirmed:true,action:{kind:'mission-upload'}});
 expect(api.command.mock.calls[0][0].action.items[0]).toEqual({...report.mission.items[0],x:home.lat,y:home.lon,z:home.alt});
 expect(api.command.mock.calls[0][0].action.items.slice(1)).toEqual(report.mission.items.slice(1));
});
it.each(['mission','vehicle'])('still blocks an upload review after a real %s change',async kind=>{
 const {w,api,report}=await review();
 const next=kind==='mission'?{...report,mission:{...report.mission,revision:'edited-mission'}}:{...report,identity:{...report.identity,generation:'another-vehicle'}};
 await w.setProps({report:next});
 expect(w.get('.cockpit-confirm').element.disabled).toBe(true);
 await w.vm.confirmCommand();expect(api.command).not.toHaveBeenCalled();
});
