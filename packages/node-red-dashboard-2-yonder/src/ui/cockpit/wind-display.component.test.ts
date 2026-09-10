// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {mount} from '@vue/test-utils';
import WindDisplay from './PfdWindDisplay.vue';
import PfdControlPanel from './PfdControlPanel.vue';
import {validatePfdPreferences} from './pfd-controls.mjs';
const telemetry={ready:true,headingDeg:0,wind:{source:'WIND',directionFromDeg:45,speedKt:14.1421356,ageMs:0}};
it('renders blowing-toward component arrows, follows heading and removes stale arrows',async()=>{
 const w=mount(WindDisplay,{props:{telemetry}});
 expect(w.find('[data-direction="down"]').exists()).toBe(true);expect(w.find('[data-direction="left"]').exists()).toBe(true);
 expect(w.findAll('.wind-value').map(n=>n.text())).toEqual(['10','10']);
 await w.setProps({telemetry:{...telemetry,headingDeg:180}});
 expect(w.find('[data-direction="up"]').exists()).toBe(true);expect(w.find('[data-direction="right"]').exists()).toBe(true);
 await w.setProps({telemetry:{...telemetry,wind:{...telemetry.wind,ageMs:5000}}});
 expect(w.text()).toContain('NO WIND');expect(w.find('.wind-arrow').exists()).toBe(false);
 await w.get('button').trigger('click');expect(w.emitted('open')).toHaveLength(1);expect(w.emitted('request')).toBeUndefined();w.unmount();
});
it('renders vector and true FROM bearing choices without inventing direction for zero speed',async()=>{
 const w=mount(WindDisplay,{props:{telemetry,mode:'direction'}});
 expect(w.get('.wind-vector g').attributes('transform')).toContain('rotate(45)');expect(w.get('.wind-bearing').text()).toBe('045° T');
 await w.setProps({mode:'vector'});expect(w.find('.wind-bearing').exists()).toBe(false);
 await w.setProps({telemetry:{...telemetry,wind:{...telemetry.wind,speedKt:0}}});expect(w.find('.wind-arrow').exists()).toBe(false);expect(w.get('.wind-value').text()).toBe('0');w.unmount();
});
it('exposes all touch wind preferences and emits only a local display change',async()=>{
 const prefs=validatePfdPreferences();
 const w=mount(PfdControlPanel,{props:{kind:'wind',telemetry,options:prefs.display,flight:{live:true},guidance:{},references:prefs.references}});
 expect(w.get('[aria-label="Wind display mode"]').findAll('option').map(n=>n.attributes('value'))).toEqual(['components','vector','direction','off']);
 await w.get('select').setValue('off');expect(w.emitted('option')).toEqual([['windDisplay','off']]);expect(w.emitted('request')).toBeUndefined();
 expect(w.text()).toContain('not verified calm');w.unmount();
 for(const mode of ['components','vector','direction','off'])expect(validatePfdPreferences({display:{windDisplay:mode}}).display.windDisplay).toBe(mode);
 expect(validatePfdPreferences({display:{windDisplay:'bad'}}).display.windDisplay).toBe('components');
});
