// SPDX-License-Identifier: GPL-3.0-or-later
import {expect,it,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture} from '../../../cockpit/fixture.mjs';
import coveDemo from './data/cove-demo.json';
function host(){const report=fixture();report.capabilities.flightControl=['heading','altitude','speed','loiter'].map(kind=>({kind,available:true}));return mount(YonderCockpit,{props:{id:'flight-host-test',report,api:{command:vi.fn(async()=>({accepted:true,operationId:'one'}))}},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true}}})}
it('reviews a persistent heading request then sends exactly once on confirmation',async()=>{const w=host();await w.get('[aria-label="Heading"]').trigger('click');await w.get('[aria-label="Requested true heading"]').setValue('125');const api=w.props('api');expect(api.command).not.toHaveBeenCalled();await w.get('.flight-request-form').trigger('submit');expect(w.get('[aria-label="Review aircraft command"]').text()).toContain('125° true');expect(api.command).not.toHaveBeenCalled();await w.get('.cockpit-confirm').trigger('click');expect(api.command).toHaveBeenCalledTimes(1);expect(api.command.mock.calls[0][0].action).toMatchObject({kind:'heading',headingDeg:125,reference:'true'});w.unmount()});
it('picks a Direct-To map target without creating a local mission draft',async()=>{const w=host();await w.get('[aria-label="Direct-To"]').trigger('click');await w.get('.flight-control-dialog .mission-touch-wide').trigger('click');expect(w.attributes('data-layout')).toBe('map');expect(w.findComponent({name:'YonderCockpitMap'}).props('picking')).toBe(true);w.findComponent({name:'YonderCockpitMap'}).vm.$emit('location',{lat:35.123,lon:-84.456});await w.vm.$nextTick();expect(w.get('[aria-label="Target latitude"]').element.value).toBe('35.123');expect(w.get('[aria-label="Target longitude"]').element.value).toBe('-84.456');expect(w.vm.draft).toBeNull();expect(w.props('api').command).not.toHaveBeenCalled();w.unmount()});
it('does not send while flight details are recovering and offers camera fallback',async()=>{const w=host();await w.setProps({report:{...w.props('report'),_detailsReady:false}});expect(w.vm.canCommand).toBe(false);w.vm.background='camera';await w.vm.$nextTick();await w.get('[aria-label="Use synthetic terrain"]').trigger('click');expect(w.vm.background).toBe('terrain');expect(w.vm.onlineTerrain).toBe(true);expect(w.props('api').command).not.toHaveBeenCalled();w.unmount()});
it('replaces its queued notice when the matching aircraft result arrives',async()=>{const w=host();await w.vm.sendReadAction('mission-download');expect(w.vm.error).toContain('queued');await w.setProps({report:{...w.props('report'),operations:[{id:'one',action:{kind:'mission-download'},state:'observed',message:'Complete vehicle mission downloaded'}]}});expect(w.vm.error).toBe('observed · Complete vehicle mission downloaded');w.unmount()});
it('loads a VTOL draft with a 180 ft takeoff and preserves the original cove route without sending commands',async()=>{
 const w=host();w.vm.panel='display';await w.vm.$nextTick();
 const button=w.findAll('button').find(b=>b.text()==='Load VTOL cove example as local draft');
 expect(button,'VTOL demo is available in Display & data').toBeDefined();await button!.trigger('click');
 expect(w.vm.draft.items[0]).toMatchObject({seq:1,command:84,frame:3,alt:54.864});
 expect(w.vm.draft.items.slice(1)).toEqual(coveDemo.items.slice(1));
 expect(w.vm.draft.home).toEqual(coveDemo.home);
 expect(coveDemo.items[0]).toMatchObject({command:22,alt:91.439999});
 expect(w.vm.draft.name).toContain('180 ft');expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
});
it('explains the draft start restriction and places Start before the mode list for the aircraft mission',async()=>{
 const w=host();w.vm.loadDemo();w.vm.openMission(null);await w.vm.$nextTick();
 const start=()=>w.findAll('button').find(b=>b.text().startsWith('Start aircraft mission'))!;
 expect(start().attributes('disabled')).toBeDefined();
 expect(w.text()).toContain('To start the uploaded mission, choose Show aircraft mission');
 await w.findAll('button').find(b=>b.text().startsWith('Show aircraft mission'))!.trigger('click');
 w.vm.openMission(null);await w.vm.$nextTick();
 expect(start().attributes('disabled')).toBeUndefined();
 expect(start().element.compareDocumentPosition(w.get('[aria-label="Aircraft flight mode"]').element)&4).toBe(4);
 expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
});
