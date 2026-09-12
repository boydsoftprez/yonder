// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach,expect,it,vi} from 'vitest';
import {flushPromises,mount} from '@vue/test-utils';
import MissionPlanning from './MissionPlanning.vue';
const mission={home:{lat:35,lon:-84,alt:100},items:[{seq:1,lat:35,lon:-84,alt:100,frame:3,command:16},{seq:2,lat:35.01,lon:-84,alt:100,frame:3,command:16}]};
const evidence={available:true,provider:'ardupilot-srtm1',generation:'official-1',spacingM:30,datum:'MSL',datumEvidence:'Official source; no additional datum correction applied',heightM:100};
const client=()=>({samples:vi.fn(async points=>({samples:points.map(()=>evidence)}))});
afterEach(()=>vi.useRealTimers());
it('does not sample while official terrain is disabled and samples only through the official client when enabled',async()=>{
 vi.useFakeTimers();const officialClient=client(),w=mount(MissionPlanning,{props:{mission,officialClient,enabled:false,visible:true}});
 await vi.advanceTimersByTimeAsync(200);expect(officialClient.samples).not.toHaveBeenCalled();await w.setProps({enabled:true});await vi.advanceTimersByTimeAsync(200);await flushPromises();expect(officialClient.samples).toHaveBeenCalled();expect(w.text()).toContain('Official MSL terrain');w.unmount();
});
it('refreshes explicitly without retransferring on unrelated rerenders',async()=>{
 vi.useFakeTimers();const officialClient=client(),w=mount(MissionPlanning,{props:{mission,officialClient,enabled:true,visible:false}});await vi.advanceTimersByTimeAsync(200);await flushPromises();const calls=officialClient.samples.mock.calls.length;
 await w.setProps({mission:structuredClone(mission),options:{speedUnit:'mph'}});await vi.advanceTimersByTimeAsync(200);expect(officialClient.samples).toHaveBeenCalledTimes(calls);
 await w.findAll('button').find(b=>b.text()==='Refresh official terrain')!.trigger('click');await vi.advanceTimersByTimeAsync(1);await flushPromises();expect(officialClient.samples.mock.calls.length).toBeGreaterThan(calls);w.unmount();
});
it('keeps the profile scrubber mounted while home altitude updates',async()=>{
 vi.useFakeTimers();const officialClient=client(),w=mount(MissionPlanning,{props:{mission,officialClient,enabled:true,visible:true}});await vi.advanceTimersByTimeAsync(200);await flushPromises();const slider=w.get('[aria-label="Inspect distance along route"]').element;
 await w.setProps({mission:{...mission,home:{...mission.home,alt:101}}});expect(w.get('[aria-label="Inspect distance along route"]').element).toBe(slider);await vi.advanceTimersByTimeAsync(1);await flushPromises();expect(w.get('[aria-label="Inspect distance along route"]').element).toBe(slider);w.unmount();
});
it('loads an enabled ground display overlay independently of official sampling',async()=>{
 vi.useFakeTimers();const officialClient=client(),displayProvider={revision:1,options:{mode:'ground'},terrainManifest:vi.fn(async()=>null)};
 const w=mount(MissionPlanning,{props:{mission,officialClient,enabled:false,visible:true,displayProvider,displayDatum:'EGM96',displayEnabled:true}});
 await vi.advanceTimersByTimeAsync(200);await flushPromises();expect(officialClient.samples).not.toHaveBeenCalled();expect(displayProvider.terrainManifest).toHaveBeenCalledTimes(1);w.unmount();
});
it('requires explicit consent for an aircraft-backed display overlay and resets it on source change',async()=>{
 vi.useFakeTimers();let notify=()=>{};const officialClient=client(),displayProvider={revision:1,options:{mode:'aircraft'},terrainManifest:vi.fn(async()=>null),subscribe:fn=>{notify=fn;return ()=>{}}};
 const w=mount(MissionPlanning,{props:{mission,officialClient,enabled:true,visible:true,displayProvider,displayDatum:'EGM96',displayEnabled:true}});
 await vi.advanceTimersByTimeAsync(200);await flushPromises();expect(displayProvider.terrainManifest).not.toHaveBeenCalled();
 await w.get('.profile-aircraft-load').trigger('click');await vi.advanceTimersByTimeAsync(200);await flushPromises();expect(displayProvider.terrainManifest).toHaveBeenCalledTimes(1);
 displayProvider.revision++;notify();await vi.advanceTimersByTimeAsync(200);expect(w.find('.profile-aircraft-load').exists()).toBe(true);expect(displayProvider.terrainManifest).toHaveBeenCalledTimes(1);w.unmount();
});
