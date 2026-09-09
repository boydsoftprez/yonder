// SPDX-License-Identifier: GPL-3.0-or-later
import {expect,it,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture,fixtureLeg} from '../../../cockpit/fixture.mjs';
import coveDemo from './data/cove-demo.json';
function host(){const report=fixture();report.capabilities.flightControl=['heading','altitude','speed','loiter'].map(kind=>({kind,available:true}));return mount(YonderCockpit,{props:{id:'flight-host-test',report,api:{command:vi.fn(async()=>({accepted:true,operationId:'one'}))}},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true}}})}
it('sequences the list, HSI and expanded CDI together without changing aircraft state',async()=>{
 const w=host();w.vm.layout='mission';await w.vm.$nextTick();
 expect(w.get('[aria-current="step"]').attributes('data-mission-seq')).toBe('2');
 expect(w.get('.cockpit-mission-summary').text()).toContain('NEXT IN PLAN WP03');
 const before=w.get('.pfd-course-pointer').attributes('transform');
 const next=fixtureLeg(w.props('report'),3,-25);
 await w.setProps({report:next});
 expect(w.get('[aria-current="step"]').attributes('data-mission-seq')).toBe('3');
 expect(w.get('.cockpit-mission-summary').text()).toContain('WP02 → WP03');
 expect(w.get('.cockpit-mission-summary').text()).toContain('NEXT IN PLAN WP04');
 expect(w.get('.pfd-course-pointer').attributes('transform')).not.toBe(before);
 expect(Number(w.get('.pfd-cdi-bar').attributes('x1'))).toBeGreaterThan(0);
 expect(w.get('.cdi-moving-bar').attributes('transform')).toBe('translate(108.6 0)');
 await w.get('[aria-label="Follow active mission leg"]').trigger('click');expect(w.vm.preferences.display.followMission).toBe(false);
 const stale={...next,mission:{...next.mission,currentFresh:false}};await w.setProps({report:stale});
 expect(w.find('[aria-current="step"]').exists()).toBe(false);expect(w.find('.pfd-cdi-bar').exists()).toBe(false);
 expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();localStorage.clear();
});
it('keeps fresh zero-age instruments visible between clock ticks and exposes local turn-cue settings',async()=>{
 const w=host();await w.setData({now:w.vm.receivedAt-190});
 expect(w.find('.skid-ball').exists()).toBe(true);expect(w.find('.turn-unavailable').exists()).toBe(false);
 expect(w.findAll('.pfd-standard-rate-bank path')).toHaveLength(2);expect(w.findAll('.turn-tick')).toHaveLength(4);
 await w.get('[aria-label="Slip and skid indicator settings"]').trigger('click');
 await w.get('[aria-label="Standard-rate bank pointers"]').setValue(false);
 await w.get('[aria-label="HSI turn-rate arc"]').setValue(false);
 expect(w.vm.preferences.display).toMatchObject({standardRatePointers:false,turnRate:false});
 expect(w.find('.pfd-standard-rate-bank').exists()).toBe(false);expect(w.find('.pfd-turn-rate').exists()).toBe(false);
 expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();localStorage.clear();
});
it('reviews a persistent heading request then sends exactly once on confirmation',async()=>{const w=host();await w.get('[aria-label="Heading"]').trigger('click');await w.get('[aria-label="Requested true heading"]').setValue('125');const api=w.props('api');expect(api.command).not.toHaveBeenCalled();await w.get('.flight-request-form').trigger('submit');expect(w.get('[aria-label="Review aircraft command"]').text()).toContain('125° true');expect(api.command).not.toHaveBeenCalled();await w.get('.cockpit-confirm').trigger('click');expect(api.command).toHaveBeenCalledTimes(1);expect(api.command.mock.calls[0][0].action).toMatchObject({kind:'heading',headingDeg:125,reference:'true'});w.unmount()});
it('picks a Direct-To map target without creating a local mission draft',async()=>{const w=host();await w.get('[aria-label="Direct-To"]').trigger('click');await w.get('.flight-control-dialog .mission-touch-wide').trigger('click');expect(w.attributes('data-layout')).toBe('map');expect(w.findComponent({name:'YonderCockpitMap'}).props('picking')).toBe(true);w.findComponent({name:'YonderCockpitMap'}).vm.$emit('location',{lat:35.123,lon:-84.456});await w.vm.$nextTick();expect(w.get('[aria-label="Target latitude"]').element.value).toBe('35.123');expect(w.get('[aria-label="Target longitude"]').element.value).toBe('-84.456');expect(w.vm.draft).toBeNull();expect(w.props('api').command).not.toHaveBeenCalled();w.unmount()});
it('does not send while flight details are recovering and offers camera fallback',async()=>{const w=host();await w.setProps({report:{...w.props('report'),_detailsReady:false}});expect(w.vm.canCommand).toBe(false);w.vm.background='camera';await w.vm.$nextTick();await w.get('[aria-label="Use synthetic terrain"]').trigger('click');expect(w.vm.background).toBe('terrain');expect(w.vm.onlineTerrain).toBe(true);expect(w.props('api').command).not.toHaveBeenCalled();w.unmount()});
it('replaces its queued notice when the matching aircraft result arrives',async()=>{const w=host();await w.vm.sendReadAction('mission-download');expect(w.vm.error).toContain('queued');await w.setProps({report:{...w.props('report'),operations:[{id:'one',action:{kind:'mission-download'},state:'observed',message:'Complete vehicle mission downloaded'}]}});expect(w.vm.error).toBe('observed · Complete vehicle mission downloaded');w.unmount()});
it('clears a recovered telemetry outage notice without erasing aircraft command errors',async()=>{
 const w=host(), state=vi.fn();w.vm.source={state};
 state.mockRejectedValueOnce(new Error('Flight service unavailable (HTTP 500)'));await w.vm.poll();clearTimeout(w.vm.pollTimer);
 expect(w.vm.error).toContain('HTTP 500');state.mockResolvedValue(w.props('report'));
 await w.vm.poll();clearTimeout(w.vm.pollTimer);expect(w.vm.error).toBe('');
 state.mockRejectedValueOnce(new Error('Telemetry unavailable'));await w.vm.poll();clearTimeout(w.vm.pollTimer);
 w.vm.error='Aircraft rejected command';await w.vm.poll();clearTimeout(w.vm.pollTimer);
 expect(w.vm.error).toBe('Aircraft rejected command');w.unmount();
});
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
it('explains the draft start restriction and retains Start while sending mode access to the shared controls for the aircraft mission',async()=>{
 const w=host();w.vm.loadDemo();w.vm.openMission(null);await w.vm.$nextTick();
 const start=()=>w.findAll('button').find(b=>b.text().startsWith('Start aircraft mission'))!;
 expect(start().attributes('disabled')).toBeDefined();
 expect(w.text()).toContain('To start the uploaded mission, choose Show aircraft mission');
 await w.findAll('button').find(b=>b.text().startsWith('Show aircraft mission'))!.trigger('click');
 w.vm.openMission(null);await w.vm.$nextTick();
 expect(start().attributes('disabled')).toBeUndefined();
 expect(w.find('[aria-label="Aircraft flight mode"]').exists()).toBe(false);await w.findAll('button').find(b=>b.text().startsWith('Flight controls…'))!.trigger('click');expect(w.find('.flight-control-dialog').exists()).toBe(true);
 expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
});
it('disables mission aircraft actions while command details refresh but retains local editing',async()=>{
 const w=host();await w.setProps({report:{...w.props('report'),_detailsReady:false}});
 await w.get('.cockpit-mission nav button').trigger('click');
 expect(w.findAll('.mission-touch .mission-execute').every(b=>b.attributes('disabled')!==undefined)).toBe(true);
 expect(w.get('.mission-touch').text()).toContain('Aircraft details are refreshing');
 expect(w.findAll('.mission-touch button').find(b=>b.text().startsWith('Add mission item'))?.attributes('disabled')).toBeUndefined();
 await w.setProps({report:{...w.props('report'),_detailsReady:true}});
 expect(w.findAll('.mission-touch .mission-mode-grid button').every(b=>b.attributes('disabled')===undefined)).toBe(true);
 expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
});
