// SPDX-License-Identifier: GPL-3.0-or-later
import {mount,flushPromises} from '@vue/test-utils';
import {it,expect,afterEach,vi} from 'vitest';
import Presets from './YonderAimPresets.vue';
const saved={slot:1,name:'Front',pan:-220,tilt:-100,mode:1,frame:'hg211-joints-v1',savedAt:1};
const make=(extra={})=>mount(Presets,{props:{presets:{revision:0,slots:[]},endpoint:'/video/cam3/presets',canMove:true,...extra}});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()});
it('offers exactly six slots, captures on the server, and keeps saved readback through an older report',async()=>{
 const fetcher=vi.fn(async()=>({ok:true,status:200,json:async()=>({presets:{revision:1,slots:[saved]}})}));vi.stubGlobal('fetch',fetcher);
 const w=make();expect(w.findAll('.y-presets__slot')).toHaveLength(6);await w.get('[aria-label="Save preset 1"]').trigger('click');
 await w.get('input').setValue('Front');await w.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({op:'save',slot:1,revision:0,name:'Front'});
 expect(w.get('[aria-label="Go to Front"]').exists()).toBe(true);await w.setProps({presets:{revision:0,slots:[]}});expect(w.text()).toContain('Front');
 await w.setProps({presets:{revision:2,slots:[{...saved,name:'New front'}]}});expect(w.text()).toContain('New front');w.unmount();
});
it('preserves typed names on failure and does not claim the slot was saved',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:409,json:async()=>({error:'Stop movement before saving a position'})})));
 const w=make();await w.get('[aria-label="Save preset 2"]').trigger('click');await w.get('input').setValue('Left');await w.get('form').trigger('submit');await flushPromises();
 expect(w.get('input').element.value).toBe('Left');expect(w.text()).toContain('Stop movement');expect(w.find('[aria-label="Go to Left"]').exists()).toBe(false);w.unmount();
});
it('recalls a revision-qualified slot, keeps Stop available, and gates movement when feedback is unavailable',async()=>{
 const w=make({presets:{revision:3,slots:[saved]}});await w.get('[aria-label="Go to Front"]').trigger('click');
 expect(w.emitted('recall')).toEqual([[{slot:1,revision:3}]]);await w.setProps({activeSlot:1,canMove:false});
 expect(w.get('[aria-label="Go to Front"]').attributes('disabled')).toBeDefined();
 await w.get('.y-presets__stop').trigger('click');expect(w.emitted('stop')).toHaveLength(1);w.unmount();
});
it('uses the editor opening revision to refuse an unnoticed concurrent overwrite',async()=>{
 const fetcher=vi.fn(async()=>({ok:false,status:409,json:async()=>({error:'Presets changed'})}));vi.stubGlobal('fetch',fetcher);
 const w=make({presets:{revision:1,slots:[saved]}});await w.get('[aria-label="Edit preset 1"]').trigger('click');
 await w.setProps({presets:{revision:2,slots:[{...saved,name:'Someone else'}]}});await w.get('input').setValue('Mine');await w.get('form').trigger('submit');await flushPromises();
 expect(JSON.parse(fetcher.mock.calls[0][1].body).revision).toBe(1);w.unmount();
});
