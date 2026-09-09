// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {mount} from '@vue/test-utils';
import MissionTouch from './MissionTouch.vue';
it('offers mission read beside a blocked upload and retains the local draft',async()=>{
 const mission={name:'Local draft',items:[]};
 const w=mount(MissionTouch,{props:{mission,draft:true,sitl:{available:true,connected:true},uploadStatus:{ready:false,reason:'Read aircraft mission first'}}});
 const button=text=>w.findAll('button').find(b=>b.text().startsWith(text));
 expect(button('Upload draft').element.disabled).toBe(true);
 await button('Read aircraft mission').trigger('click');
 expect(w.emitted('read')).toHaveLength(1);expect(w.emitted('upload')).toBeUndefined();expect(w.emitted('use-live')).toBeUndefined();
 expect(w.props('mission')).toStrictEqual(mission);
 await w.setProps({uploadStatus:{ready:true,reason:''}});
 expect(button('Upload draft').element.disabled).toBe(false);
 w.unmount();
});
