// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect,vi,afterEach} from 'vitest';
import {mount,flushPromises} from '@vue/test-utils';
const mocks=vi.hoisted(()=>({load:vi.fn()}));
vi.mock('./mission-terrain.mjs',()=>({loadMissionTerrain:mocks.load}));
import MissionHome from './MissionHome.vue';
const hosts=[];afterEach(()=>{hosts.splice(0).forEach(w=>w.unmount());vi.clearAllMocks()});
function host(){const w=mount(MissionHome,{props:{home:{lat:35,lon:-84,alt:300},terrainEnabled:true,officialClient:{samples:vi.fn()}}});hosts.push(w);return w}
it('samples only on request, identifies its prepared source, and saves the estimate only on Save',async()=>{
 mocks.load.mockResolvedValue({waypoints:[{groundM:315.25}],source:{provider:'ardupilot-srtm1',datum:'MSL',datumEvidence:'Official sample evidence.'}});
 const w=host();await flushPromises();expect(mocks.load).not.toHaveBeenCalled();
 await w.findAll('button').find(b=>b.text().startsWith('Use official terrain elevation'))!.trigger('click');await flushPromises();
 expect(mocks.load).toHaveBeenCalledWith(expect.objectContaining({client:expect.any(Object),route:expect.objectContaining({points:[expect.objectContaining({lat:35,lon:-84})]})}));
 expect(w.text()).toContain('ardupilot-srtm1 · MSL');expect(w.emitted('save')).toBeUndefined();expect(w.emitted('review')).toBeUndefined();
 await w.get('form').trigger('submit');expect(w.emitted('save')[0][0].alt).toBe(315.25);
});
it('retains the entered elevation when the terrain source has no compatible sample',async()=>{
 mocks.load.mockResolvedValue({waypoints:[{groundM:null}],reason:'No matching terrain coverage'});
 const w=host();await w.findAll('button').find(b=>b.text().startsWith('Use official terrain elevation'))!.trigger('click');await flushPromises();
 expect(w.get('[role="alert"]').text()).toContain('No matching terrain coverage');
 await w.get('form').trigger('submit');expect(w.emitted('save')[0][0].alt).toBe(300);
});
