// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import L from 'leaflet';
import YonderCockpitMap from './YonderCockpitMap.vue';
const hosts=[];
afterEach(()=>{hosts.splice(0).forEach(w=>w.unmount());vi.unstubAllGlobals()});
it('shows imagery without inventing ownship at zero, then follows an acquired GPS fix',async()=>{
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 L.Browser.svg=true;
 const dataProvider={options:{mode:'ground'},status:()=>({attribution:'Test imagery'}),subscribe:()=>()=>{},tile:vi.fn(async()=>{throw new Error('Test tile unavailable')})};
 const t={ready:true,latitude:0,longitude:0,fixType:0,satellites:0,headingDeg:90};
 const w=mount(YonderCockpitMap,{props:{online:true,dataProvider,snapshot:{telemetry:t},now:Date.now()}});hosts.push(w);await flushPromises();
 expect(w.find('select[aria-label="Map layers"]').element.value).toBe('hybrid');
 expect(w.text()).toMatch(/No GPS fix.*0 satellites/);
 expect(w.find('button[aria-label="Fit traffic range"]').attributes('disabled')).toBeDefined();
 expect(w.find('.cockpit-aircraft').exists()).toBe(false);
 expect(w.vm.map.getZoom()).toBe(2);
 await w.setProps({snapshot:{telemetry:{...t,fixType:3,latitude:35,longitude:-84}}});
 expect(w.find('.cockpit-aircraft').exists()).toBe(true);
 expect(w.vm.map.getCenter().lat).toBeCloseTo(35);
 expect(w.vm.map.getCenter().lng).toBeCloseTo(-84);
 expect(w.vm.map.getZoom()).toBe(14);
 expect(w.find('button[aria-label="Fit traffic range"]').attributes('disabled')).toBeUndefined();
 await w.setProps({snapshot:{telemetry:{...t,fixType:null}}});
 expect(w.find('.cockpit-aircraft').exists()).toBe(false);
 expect(w.text()).toMatch(/waiting for fresh GPS fix/);
 expect(w.vm.map.getCenter().lat).toBeCloseTo(35);
});
