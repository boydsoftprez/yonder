// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,it,expect,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import MissionHome from './MissionHome.vue';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture} from '../../../cockpit/fixture.mjs';
const hosts=[];afterEach(()=>{hosts.splice(0).forEach(w=>w.unmount());localStorage.clear()});
function host(){const report=fixture();report.capabilities.homeControl={available:true,confirmation:'readback'};const api={command:vi.fn(async()=>({accepted:true,operationId:'test-home'}))};const w=mount(YonderCockpit,{props:{id:'home-editor-test',report,api},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true}}});hosts.push(w);return {w,api}}
it('keeps unit changes lossless and treats copying controller home as a local save',async()=>{
 const original={lat:35,lon:-84,alt:91.439999};const w=mount(MissionHome,{props:{home:original,controllerHome:{...original,alt:100},canSet:true}});hosts.push(w);
 await w.get('[aria-label="Home elevation units"]').setValue('m');await w.get('[aria-label="Home elevation units"]').setValue('ft');
 await w.get('form').trigger('submit');expect(w.emitted('save')[0][0]).toEqual(original);expect(w.emitted('review')).toBeUndefined();
 await w.findAll('button').find(b=>b.text().startsWith('Use controller home'))!.trigger('click');expect(w.emitted('save')[1][0].alt).toBe(100);
});
it('preserves an unsaved elevation while choosing home on the map and supports Undo',async()=>{
 const {w,api}=host();await flushPromises();w.vm.openHome();await w.vm.$nextTick();
 await w.get('[aria-label="Home MSL elevation"]').setValue('1200');
 await w.findAll('button').find(b=>b.text()==='Choose home on map')!.trigger('click');
 expect(w.findComponent({name:'YonderCockpitMap'}).props('picking')).toBe(true);
 w.findComponent({name:'YonderCockpitMap'}).vm.$emit('location',{lat:35.123,lon:-84.456});await w.vm.$nextTick();
 expect(w.get('[aria-label="Home latitude"]').element.value).toBe('35.123');expect(w.get('[aria-label="Home MSL elevation"]').element.value).toBe('1200');
 const original=w.vm.shownMission.home;await w.get('[aria-label="Mission home"] form').trigger('submit');
 expect(w.vm.draft.home).toMatchObject({lat:35.123,lon:-84.456});expect(w.vm.draft.home.alt).toBeCloseTo(365.76);expect(api.command).not.toHaveBeenCalled();
 w.vm.undo();expect(w.vm.shownMission.home).toEqual(original);
});
it('reviews controller home separately, rejects changed context and returns to fields on cancel',async()=>{
 const {w,api}=host();await flushPromises();w.vm.openHome();await w.vm.$nextTick();
 await w.get('[aria-label="Home MSL elevation"]').setValue('1200');
 await w.findAll('button').find(b=>b.text().startsWith('Set controller home…'))!.trigger('click');
 expect(w.get('[aria-label="Review aircraft command"]').text()).toContain('In RTL or QRTL');expect(w.vm.draft).toBeNull();expect(api.command).not.toHaveBeenCalled();
 const report=w.props('report');await w.setProps({report:{...report,telemetry:{...report.telemetry,homePosition:{...report.telemetry.homePosition,alt:500}}}});
 expect(w.get('.cockpit-confirm').element.disabled).toBe(true);
 await w.get('[aria-label="Cancel command review"]').trigger('click');expect(w.get('[aria-label="Home MSL elevation"]').element.value).toBe('1200');
 await w.findAll('button').find(b=>b.text().startsWith('Set controller home…'))!.trigger('click');await w.get('.cockpit-confirm').trigger('click');
 expect(api.command).toHaveBeenCalledTimes(1);expect(api.command.mock.calls[0][0].action).toMatchObject({kind:'set-home',expectedHome:{alt:500}});expect(api.command.mock.calls[0][0].action.home.alt).toBeCloseTo(365.76);
 expect(w.vm.draft).toBeNull();
});
