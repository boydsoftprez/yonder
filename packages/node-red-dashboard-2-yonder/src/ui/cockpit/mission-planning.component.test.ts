// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect,vi} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
import MissionPlanning from './MissionPlanning.vue';
import {latLonToUtm} from 'yonder-core/terrain';
const mission={home:{lat:35,lon:-84,alt:100},items:[{seq:1,lat:35,lon:-84,alt:100,frame:3,command:16},{seq:2,lat:35.01,lon:-84,alt:100,frame:3,command:16}]};
it('requires explicit aircraft route loading and expires consent when the source changes',async()=>{
 vi.useFakeTimers();let notify=()=>{};
 const provider={revision:1,options:{mode:'aircraft'},terrainManifest:vi.fn(async()=>null),subscribe:fn=>{notify=fn;return ()=>{}}};
 const w=mount(MissionPlanning,{props:{mission,provider,enabled:true,visible:true,aircraftDatum:'EGM96'}});
 await vi.advanceTimersByTimeAsync(200);expect(provider.terrainManifest).not.toHaveBeenCalled();
 await w.get('.profile-aircraft-load').trigger('click');await vi.advanceTimersByTimeAsync(200);await flushPromises();expect(provider.terrainManifest).toHaveBeenCalledTimes(1);
 provider.revision++;notify();await vi.advanceTimersByTimeAsync(200);expect(w.find('.profile-aircraft-load').exists()).toBe(true);expect(provider.terrainManifest).toHaveBeenCalledTimes(1);w.unmount();vi.useRealTimers();
});
it('refreshes ground results on source change without retransferring on unrelated rerenders',async()=>{
 vi.useFakeTimers();let notify=()=>{};
 const provider={revision:1,options:{mode:'ground'},terrainManifest:vi.fn(async()=>null),subscribe:fn=>{notify=fn;return ()=>{}}};
 const w=mount(MissionPlanning,{props:{mission,provider,enabled:true,visible:false,aircraftDatum:'EGM96'}});
 await vi.advanceTimersByTimeAsync(200);await flushPromises();expect(provider.terrainManifest).toHaveBeenCalledTimes(1);
 await w.setProps({mission:structuredClone(mission),options:{speedUnit:'mph'}});await vi.advanceTimersByTimeAsync(200);expect(provider.terrainManifest).toHaveBeenCalledTimes(1);
 provider.revision++;notify();await vi.advanceTimersByTimeAsync(200);expect(provider.terrainManifest).toHaveBeenCalledTimes(2);w.unmount();vi.useRealTimers();
});
it('keeps the profile scrubber mounted while home altitude updates',async()=>{
 vi.useFakeTimers();const p=latLonToUtm(35,-84,17);
 const descriptor={id:'native',file:'native.bin',sha256:'0'.repeat(64),bytes:72,decodedBytes:72,level:0,columns:3,rows:3,spacingM:1000,originEastingM:p.eastingM-1000,originNorthingM:p.northingM+1500,groundCoverage:1,surfaceCoverage:1,minGroundM:100,maxSurfaceM:125};
 const manifest={schemaVersion:1,id:'test',title:'Test',createdAt:'2026-09-07T00:00:00Z',horizontalCrs:{kind:'UTM',datum:'WGS84',zone:17,hemisphere:'north'},verticalDatum:'EGM96',verticalTransform:{verified:true,description:'Test',grids:[]},surfaceDescription:'Mapped heights',sourceResolutionM:1,sources:[],tiles:[descriptor],limitations:[]};
 const provider={revision:1,options:{mode:'ground'},terrainManifest:async()=>manifest,terrainTile:async()=>new Uint8Array(new Float32Array([...Array(9).fill(100),...Array(9).fill(125)]).buffer)};
 const w=mount(MissionPlanning,{props:{mission,provider,enabled:true,visible:true,aircraftDatum:'EGM96'}});
 await vi.advanceTimersByTimeAsync(200);await flushPromises();const slider=w.get('[aria-label="Inspect distance along route"]').element;
 await w.setProps({mission:{...mission,home:{...mission.home,alt:101}}});expect(w.get('[aria-label="Inspect distance along route"]').element).toBe(slider);
 await vi.advanceTimersByTimeAsync(200);await flushPromises();expect(w.get('[aria-label="Inspect distance along route"]').element).toBe(slider);w.unmount();vi.useRealTimers();
});
