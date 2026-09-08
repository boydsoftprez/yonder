import {beforeEach,expect,it,vi} from 'vitest';
import {mount} from '@vue/test-utils';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture} from '../../../cockpit/fixture.mjs';
beforeEach(()=>localStorage.clear());
function host(){return mount(YonderCockpit,{props:{id:'layout-test',report:fixture(),api:{command:vi.fn()}},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true},provide:{$socket:{emit:vi.fn()},$dataTracker:{}}}})}
it('places autopilot controls before user fields in reading and keyboard order',()=>{
 const w=host(),controls=w.get('.flight-control-host').element,fields=w.get('.flight-data-bar').element;
 expect(controls.compareDocumentPosition(fields)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
});
it('keeps the same PFD and map when the operator enables a stacked MFD',async()=>{
 const w=host(),pfd=w.get('.pfd-svg').element,map=w.findComponent({name:'YonderCockpitMap'}).element;
 await w.get('[aria-label="Display setup"]').trigger('click');await w.get('[aria-label="Display arrangement"]').setValue('stacked');
 expect(w.attributes('data-arrangement')).toBe('stacked');expect(w.get('.pfd-svg').element).toBe(pfd);expect(w.findComponent({name:'YonderCockpitMap'}).element).toBe(map);
 expect(w.find('[aria-label="Multifunction display pages"]').exists()).toBe(true);expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
});
it('saves local layout choices and can hide instruments without hiding navigation fields',async()=>{
 const w=host();await w.get('[aria-label="Display setup"]').trigger('click');await w.get('[aria-label="Instrument placement"]').setValue('hidden');await w.get('[aria-label="Display arrangement"]').setValue('split');expect(w.attributes('data-arrangement')).toBe('split');expect(JSON.parse(localStorage.getItem('yonder-instrument-layout-v1')||'null')?.display.arrangement).toBe('split');w.unmount();
 const restored=host();await restored.vm.$nextTick();expect(restored.attributes('data-arrangement')).toBe('split');expect(restored.find('[aria-label="Aircraft instrument bank"]').exists()).toBe(false);expect(restored.find('[aria-label="Navigation data fields"]').exists()).toBe(true);expect(restored.props('api').command).not.toHaveBeenCalled();restored.unmount();
});
it('places the existing bank on the left of the MFD and restores it without replacing the PFD or map',async()=>{
 const w=host(),pfd=w.get('.pfd-svg').element,map=w.findComponent({name:'YonderCockpitMap'}).element,bank=w.vm.bankInstrumentConfig;
 await w.get('[aria-label="Display setup"]').trigger('click');await w.get('[aria-label="Display arrangement"]').setValue('stacked');await w.get('[aria-label="Instrument placement"]').setValue('mfd-left');
 expect(w.attributes('data-bank-placement')).toBe('mfd-left');expect(w.get('.cockpit-mfd-bank').attributes('data-placement')).toBe('side');expect(w.find('.cockpit-navigation-data').exists()).toBe(false);
 expect(w.vm.bankInstrumentConfig).toEqual(bank);expect(w.get('.pfd-svg').element).toBe(pfd);expect(w.findComponent({name:'YonderCockpitMap'}).element).toBe(map);expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
 const restored=host();await restored.vm.$nextTick();expect(restored.attributes('data-bank-placement')).toBe('mfd-left');expect(restored.get('.cockpit-mfd-bank').attributes('data-placement')).toBe('side');expect(restored.vm.bankInstrumentConfig).toEqual(bank);restored.unmount();
});
it('reveals the lower MFD when a reading opens its inspector without commanding the aircraft',async()=>{
 const w=host();await w.get('[aria-label="Display setup"]').trigger('click');await w.get('[aria-label="Display arrangement"]').setValue('stacked');
 const body=w.get('.cockpit-body').element,pages=w.get('.cockpit-mfd-pages').element;Object.defineProperty(pages,'offsetTop',{value:640});
 w.vm.openInstrument('host.cpuPercent');await w.vm.$nextTick();
 expect(body.scrollTop).toBe(640);expect(w.vm.selectedInstrument).toBe('host.cpuPercent');expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
});
it('accounts for time spent receiving an instrumentation response before calling its readings fresh',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);const w=host();let finish;w.vm.source={instruments:()=>new Promise(resolve=>{finish=resolve})};
 const pending=w.vm.pollInstruments();vi.setSystemTime(6000);finish({generation:'fixture-only',connected:true,fields:{'fc.loadPercent':{value:20,unit:'%',source:'SYS_STATUS',ageMs:0,ttlMs:3000,quality:'reported'}}});await pending;w.vm.now=6000;
 expect(w.vm.instrumentItems.find(i=>i.id==='fc.loadPercent').available).toBe(false);w.unmount();vi.useRealTimers();
});
it('opens the actual aircraft message when a status notice is selected',async()=>{
 const w=host();const report=w.props('report');await w.setProps({report:{...report,statustext:[{at:report.at,severity:3,text:'Battery test warning'}]}});
 await w.get('.cockpit-alert-summary').trigger('click');expect(w.get('[aria-label="Aircraft notices"]').text()).toContain('Battery test warning');expect(w.props('api').command).not.toHaveBeenCalled();w.unmount();
});
