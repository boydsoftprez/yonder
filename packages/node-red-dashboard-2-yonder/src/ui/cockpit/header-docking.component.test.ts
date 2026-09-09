// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,it,expect,vi} from 'vitest';
import {mount,flushPromises,DOMWrapper} from '@vue/test-utils';
import YonderCockpit from '../YonderCockpit.vue';
import {fixture} from '../../../cockpit/fixture.mjs';
const mounted=[];const nodes=[];let restoreFullscreen=()=>{};
afterEach(()=>{mounted.splice(0).forEach(w=>w.unmount());nodes.splice(0).forEach(n=>n.remove());vi.restoreAllMocks();vi.unstubAllGlobals();restoreFullscreen();restoreFullscreen=()=>{};localStorage.clear()});
async function host(header=true){
 const shell=document.createElement('div');shell.innerHTML=header?'<header class="v-app-bar"><div class="v-toolbar__content"><div class="v-toolbar-title">Yonder Flight</div><div class="v-toolbar__append"><div id="app-bar-actions"></div></div></div></header>':'';document.body.append(shell);nodes.push(shell);
 const target=document.createElement('div');document.body.append(target);nodes.push(target);
 const api={command:vi.fn(async()=>({accepted:true,operationId:'test'}))};
 const provider={configure(){},status:()=>({}),refreshOffline:async()=>({}),close(){}};
 const w=mount(YonderCockpit,{attachTo:target,props:{id:'header-test',report:fixture(),api,dataProvider:provider,terrainComponent:null},global:{stubs:{YonderCockpitMap:true,YonderPicture:true,TerrainVision:true}}});mounted.push(w);await flushPromises();
 return {w,api,header:header?new DOMWrapper(shell.querySelector('#app-bar-actions')):null};
}
it('docks one set of controls into the documented header outlet and removes them on page exit',async()=>{
 const {w,api,header}=await host();
 expect(header.find('[aria-label="Direct-To"]').exists()).toBe(true);
 expect(w.find('.cockpit-chrome').exists()).toBe(false);
 expect(w.find('.cockpit-brand').exists()).toBe(false);
 const pfd=w.get('.pfd-instrument-canvas').element;
 await header.get('[aria-label="More flight controls"]').trigger('click');await flushPromises();
 const dialog=new DOMWrapper(document.body.querySelector('[aria-label="Flight controls"]'));
 await dialog.findAll('button').find(b=>b.text().startsWith('Heading'))!.trigger('click');await flushPromises();
 expect(document.body.querySelector('[aria-label="Requested true heading"]')).not.toBeNull();
 expect(w.get('.pfd-instrument-canvas').element===pfd).toBe(true);
 expect(api.command).not.toHaveBeenCalled();
 w.unmount();mounted.pop();
 expect(header.element.childElementCount).toBe(0);expect(document.querySelector('[data-cockpit-overlay]')).toBeNull();
});
it('keeps an open Home form and the same PFD while switching the fullscreen portal target',async()=>{
 const {w,header,api}=await host();let fullscreen=null;
 const old=Object.getOwnPropertyDescriptor(document,'fullscreenElement');Object.defineProperty(document,'fullscreenElement',{configurable:true,get:()=>fullscreen});restoreFullscreen=()=>{if(old)Object.defineProperty(document,'fullscreenElement',old);else delete document.fullscreenElement};
 const pfd=w.get('.pfd-instrument-canvas').element;
 w.vm.openHome();await flushPromises();
 const input=document.querySelector('[aria-label="Home latitude"]');const field=new DOMWrapper(input);
 await field.setValue('35.12345');input.focus();
 expect(w.element.contains(input)).toBe(false);
 fullscreen=w.element;document.dispatchEvent(new Event('fullscreenchange'));await flushPromises();
 expect(w.element.contains(input)).toBe(true);expect(input.value).toBe('35.12345');expect(header.find('.cockpit-chrome').exists()).toBe(false);
 expect(w.get('.pfd-instrument-canvas').element===pfd).toBe(true);
 fullscreen=null;document.dispatchEvent(new Event('fullscreenchange'));await flushPromises();
 expect(w.element.contains(input)).toBe(false);expect(header.find('.cockpit-chrome').exists()).toBe(true);expect(input.value).toBe('35.12345');expect(api.command).not.toHaveBeenCalled();
});
it('keeps the compact toolbar usable when no Dashboard header exists',async()=>{
 const {w}=await host(false);expect(w.get('.cockpit-chrome').exists()).toBe(true);
 expect(w.get('[aria-label="RTL"]').exists()).toBe(true);expect(w.vm.headerDocked).toBe(false);
});
it('uses app width for header docking even when a portrait tablet sidebar narrows the PFD',async()=>{
 vi.stubGlobal('innerWidth',768);const {w,header}=await host();await w.setData({viewportWidth:454});await flushPromises();
 expect(header.find('.cockpit-chrome').exists()).toBe(true);
 vi.stubGlobal('innerWidth',390);window.dispatchEvent(new Event('resize'));await flushPromises();
 expect(w.find('.cockpit-chrome').exists()).toBe(true);
});
it('opens the shared Display hub and places its overlay outside the cockpit stacking context',async()=>{
 const {w,header,api}=await host();await header.get('[aria-label="Display menu"]').trigger('click');await flushPromises();
 const dialog=document.querySelector('[aria-label="Display"]');expect(dialog).not.toBeNull();expect(w.element.contains(dialog)).toBe(false);
 await new DOMWrapper(dialog).get('[aria-label="Display setup"]').trigger('click');await flushPromises();
 expect(document.querySelector('[aria-label="Display arrangement"]')).not.toBeNull();expect(api.command).not.toHaveBeenCalled();
});
