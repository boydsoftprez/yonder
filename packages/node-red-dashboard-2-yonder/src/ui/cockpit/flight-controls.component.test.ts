// SPDX-License-Identifier: GPL-3.0-or-later
import {describe,it,expect} from 'vitest';
import {mount} from '@vue/test-utils';
import MissionTouch from './MissionTouch.vue';
import {createMissionItem} from './mission-commands.mjs';
const panelPath='./FlightControlPanel.vue';
const panel=await import(/* @vite-ignore */ panelPath).catch(()=>null);
const snapshot={connected:true,identity:{generation:'a'},telemetry:{mode:'AUTO',armed:true,headingDeg:90,latitude:35,longitude:-84,relativeAltitudeM:100,airspeedKt:40},mission:{currentSeq:1,currentFresh:true,items:[{seq:1}]},capabilities:{modes:[{name:'AUTO',customMode:10},{name:'RTL',customMode:11},{name:'GUIDED',customMode:15},{name:'QRTL',customMode:21}],flightControl:['heading','altitude','speed','loiter'].map(kind=>({kind,available:true}))},operations:[]};
function controls(){expect(panel).not.toBeNull();return mount(panel!.default,{props:{snapshot,available:true}})}
describe('persistent flight controls',()=>{
 it('exposes all shortcuts and separates full mode picker from arm access',async()=>{const w=controls();for(const name of ['Direct-To','Heading','Altitude / Speed','Loiter','Resume Mission','RTL','Modes','Arm / Disarm'])expect(w.get(`[aria-label="${name}"]`).exists()).toBe(true);await w.get('[aria-label="Modes"]').trigger('click');expect(w.text()).toContain('QRTL');expect(w.find('[aria-label="Review arm aircraft"]').exists()).toBe(false);expect(w.emitted('request')).toBeUndefined();w.unmount()});
 it('only emits a heading request after explicit review and keeps AUTO actual',async()=>{const w=controls();await w.get('[aria-label="Heading"]').trigger('click');await w.get('[aria-label="Requested true heading"]').setValue('123');expect(w.emitted('request')).toBeUndefined();await w.get('form').trigger('submit');expect(w.emitted('request')?.[0]?.[0]).toMatchObject({action:{kind:'heading',headingDeg:123,reference:'true'}});expect(snapshot.telemetry.mode).toBe('AUTO');w.unmount()});
 it('shows firmware reason for unavailable guided commands',async()=>{const w=controls();await w.setProps({snapshot:{...snapshot,capabilities:{...snapshot.capabilities,flightControl:[{kind:'heading',available:false,reason:'Firmware version unsupported'}]}}});await w.get('[aria-label="Heading"]').trigger('click');expect(w.text()).toContain('Firmware version unsupported');expect(w.get('[type="submit"]').attributes('disabled')).toBeDefined();w.unmount()});
});
it('changes mission action in the local draft and exposes signed loiter controls',async()=>{const item={...createMissionItem(16,{lat:35,lon:-84,alt:120,frame:6}),seq:1,params:[12,30,40,50]};const w=mount(MissionTouch,{props:{mission:{items:[item]},selection:{seq:1},sitl:{}}});await w.get('[aria-label="Change mission action"]').trigger('click');await w.get('[aria-label="Change to Loiter Unlim"]').trigger('click');expect(w.get('[aria-label="Loiter radius metres"]').exists()).toBe(true);expect(w.text()).not.toContain('Dir 1=CW');await w.get('[aria-label="Loiter radius metres"]').setValue('250');await w.get('[aria-label="Loiter direction"]').setValue('ccw');expect(w.emitted('command')).toBeUndefined();await w.get('form').trigger('submit');expect(w.emitted('edit')?.[0]?.[0]).toMatchObject({kind:'replace',seq:1,item:{seq:1,command:17,frame:6,lat:35,lon:-84,alt:120,params:[0,0,-250,0]}});w.unmount()});
it('requires reopening an editor after the aircraft changes',async()=>{const w=controls();await w.get('[aria-label="Heading"]').trigger('click');await w.setProps({snapshot:{...snapshot,identity:{generation:'another-aircraft'}}});expect(w.text()).toContain('aircraft changed');await w.get('form').trigger('submit');expect(w.emitted('request')).toBeUndefined();w.unmount()});
it('defaults altitude to the tested maximum-rate request',async()=>{const w=controls();await w.get('[aria-label="Altitude / Speed"]').trigger('click');expect(w.get('[aria-label="Requested vertical rate"]').element.value).toBe('0');w.unmount()});
it('requires an explicit MSL altitude for a changed Set Home action',async()=>{
 const item={...createMissionItem(16,{lat:35,lon:-84,alt:120,frame:6}),seq:1};
 const w=mount(MissionTouch,{props:{mission:{items:[item]},selection:{seq:1},sitl:{},options:{altitudeUnit:'m'}}});
 await w.get('[aria-label="Change mission action"]').trigger('click');await w.get('[aria-label="Change to Do Set Home"]').trigger('click');
 expect(w.text()).toContain('Enter a new MSL altitude');expect(w.get('[aria-label="Alt parameter 7"]').element.value).toBe('');
 await w.get('form').trigger('submit');expect(w.emitted('edit')).toBeUndefined();
 await w.get('[aria-label="Alt parameter 7"]').setValue('450');await w.get('form').trigger('submit');
 expect(w.emitted('edit')?.[0]?.[0]).toMatchObject({item:{command:179,frame:0,alt:450,lat:35,lon:-84}});w.unmount();
});
it('offers a distinct reviewed mission start when fresh current item is home',async()=>{
 const w=controls();
 await w.setProps({snapshot:{...snapshot,telemetry:{...snapshot.telemetry,armed:false},mission:{synchronization:'verified',currentFresh:true,currentSeq:0,items:[{seq:0},{seq:1}]}}});
 await w.get('[aria-label="Resume Mission"]').trigger('click');
 expect(w.text()).toContain('Home (0)');expect(w.emitted('request')).toBeUndefined();
 expect(w.find('[aria-label="Review Resume Mission"]').exists()).toBe(false);
 await w.get('[aria-label="Review start mission"]').trigger('click');
 expect(w.emitted('request')?.[0]?.[0]).toMatchObject({action:{kind:'mission-start'}});
 expect(w.emitted('request')).toHaveLength(1);w.unmount();
});
it('keeps normal resume and blocks stale or empty home missions before review',async()=>{
 const w=controls();
 await w.setProps({snapshot:{...snapshot,mission:{synchronization:'verified',currentFresh:true,currentSeq:1,items:[{seq:0},{seq:1}]}}});
 await w.get('[aria-label="Resume Mission"]').trigger('click');
 await w.get('[aria-label="Review Resume Mission"]').trigger('click');
 expect(w.emitted('request')?.[0]?.[0]).toMatchObject({action:{kind:'continue-auto',seq:1,autoMode:10}});
 for(const mission of [{synchronization:'verified',currentFresh:true,currentSeq:0,items:[{seq:0}]},{synchronization:'verified',currentFresh:false,currentSeq:0,items:[{seq:0},{seq:1}]}]){
  await w.setProps({snapshot:{...snapshot,mission}});await w.get('[aria-label="Resume Mission"]').trigger('click');
  expect(w.find('[aria-label="Review start mission"]').exists()).toBe(false);
  expect(w.get('[aria-label="Review Resume Mission"]').attributes('disabled')).toBeDefined();
 }
 expect(w.emitted('request')).toHaveLength(1);w.unmount();
});
