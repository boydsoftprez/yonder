// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {mount} from '@vue/test-utils';
import NavigationDeviation from './NavigationDeviation.vue';
import {cdiDeflection} from './navigation-view.mjs';
it('uses the same signed deflection as the HSI and a fixed center triangle',async()=>{
 const guidance={valid:true,lateralValid:true,crossTrackM:125};
 const wrapper=mount(NavigationDeviation,{props:{guidance,scale:250}});
 const center=wrapper.get('.cdi-center-reference').attributes('d');
 for(const error of [-125,125]){
  await wrapper.setProps({guidance:{...guidance,crossTrackM:error}});
  expect(wrapper.get('.cdi-moving-bar').attributes('transform')).toBe(`translate(${100+cdiDeflection({...guidance,crossTrackM:error},250)*86} 0)`);
  expect(wrapper.get('.cdi-center-reference').attributes('d')).toBe(center);
 }
 await wrapper.setProps({guidance:{valid:false,reason:'Guidance unavailable'}});
 expect(wrapper.find('.cdi-moving-bar').exists()).toBe(false);expect(wrapper.text()).toContain('Guidance unavailable');
 await wrapper.setProps({guidance:{valid:true,radialValid:true,deviationKind:'radial',radialErrorM:125}});
 expect(wrapper.text()).toContain('LOITER RADIAL');expect(wrapper.text()).toContain('OUT');
 wrapper.unmount();
});
