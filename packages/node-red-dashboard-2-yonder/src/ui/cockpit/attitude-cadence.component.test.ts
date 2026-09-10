// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect,vi,afterEach} from 'vitest';
import {mount} from '@vue/test-utils';
import PrimaryFlightDisplay from './PrimaryFlightDisplay.vue';
import {flightView} from './cockpit-state.mjs';
import {validatePfdPreferences} from './pfd-controls.mjs';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()});
it('animates attitude between samples without GPS while withholding geographic overlay poses',async()=>{
 let time=0,frame;vi.spyOn(performance,'now').mockImplementation(()=>time);
 vi.stubGlobal('requestAnimationFrame',callback=>{frame=callback;return 1});vi.stubGlobal('cancelAnimationFrame',()=>{});
 const t={ready:true,fixType:0,latitude:0,longitude:0,headingDeg:90,pitchDeg:0,rollDeg:0,fields:{rollDeg:{valid:true,receivedAt:0}}};
 const preferences=validatePfdPreferences({});
 const w=mount(PrimaryFlightDisplay,{props:{flight:flightView({telemetry:t}),telemetry:t,snapshot:{at:0},options:preferences.display,references:preferences.references,guidance:{}}});
 time=100;const next={...t,rollDeg:20,fields:{rollDeg:{valid:true,receivedAt:100}}};
 await w.setProps({flight:flightView({telemetry:next}),telemetry:next,snapshot:{at:100}});
 time=180;frame(180);await w.vm.$nextTick();
 expect(w.vm.displayFlight.roll).toBeCloseTo(10);
 expect(w.vm.displayPose).toBeNull();
 const transform=w.find('.pfd-horizon').attributes('transform');expect(transform).toContain('-10');
 time=400;frame(400);await w.vm.$nextTick();expect(w.vm.displayFlight.roll).toBe(20);
 await w.setProps({flight:{...w.props('flight'),live:false,attitudeValid:false}});
 expect(w.vm.displayPose).toBeNull();w.unmount();
});
