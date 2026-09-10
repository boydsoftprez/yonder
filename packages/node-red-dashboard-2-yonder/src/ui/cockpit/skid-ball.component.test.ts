// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {mount} from '@vue/test-utils';
import PfdSkidBall from './PfdSkidBall.vue';
import PfdControlPanel from './PfdControlPanel.vue';
import {validatePfdPreferences} from './pfd-controls.mjs';
const telemetry={ready:true,rollDeg:35,slipSkid:{lateralG:0,normalG:1.2,ageMs:0,source:'RAW_IMU'}};
it('shows a centered coordinated ball, moves left/right and removes it when unavailable',async()=>{
 const w=mount(PfdSkidBall,{props:{telemetry}});
 expect(w.get('.skid-ball-motion').attributes('style')).toContain('translateX(0px)');
 await w.setProps({telemetry:{...telemetry,slipSkid:{...telemetry.slipSkid,lateralG:.1}}});expect(w.get('.skid-ball-motion').attributes('style')).toContain('translateX(-');
 await w.setProps({telemetry:{...telemetry,slipSkid:{...telemetry.slipSkid,lateralG:-.1}}});expect(w.get('.skid-ball-motion').attributes('style')).not.toContain('translateX(-');
 await w.setProps({telemetry:{...telemetry,slipSkid:null}});expect(w.find('circle').exists()).toBe(false);expect(w.text()).toContain('SLIP / SKID —');
 await w.get('button').trigger('click');expect(w.emitted('open')).toHaveLength(1);expect(w.emitted('request')).toBeUndefined();w.unmount();
});
it('provides local visibility and keeps older preferences visible by default',async()=>{
 const prefs=validatePfdPreferences();expect(prefs.display.skidBall).toBe(true);
 expect(validatePfdPreferences({display:{skidBall:false}}).display.skidBall).toBe(false);
 const w=mount(PfdControlPanel,{props:{kind:'slip',telemetry,options:prefs.display,flight:{live:true},guidance:{},references:prefs.references}});
 await w.get('[aria-label="Show skid ball"]').setValue(false);expect(w.emitted('option')).toEqual([['skidBall',false]]);expect(w.emitted('request')).toBeUndefined();w.unmount();
});
