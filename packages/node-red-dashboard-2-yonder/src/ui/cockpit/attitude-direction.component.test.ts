// SPDX-License-Identifier: GPL-3.0-or-later
import {afterEach, expect, it, vi} from 'vitest';
import {mount} from '@vue/test-utils';
import PrimaryFlightDisplay from './PrimaryFlightDisplay.vue';
import {pfdState} from './pfd-state.mjs';
import {validatePfdPreferences} from './pfd-controls.mjs';

afterEach(() => vi.unstubAllGlobals());

// R-FLT-01: the bank pointer indicates aircraft bank on the fixed scale;
// the world behind the fixed aircraft reference rotates the other way.
it.each([-30, 0, 30])('indicates %s degrees of reported bank in the aircraft direction', async rollDeg => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const telemetry = {ready: true, rollDeg, pitchDeg: 10, headingDeg: 90, fixType: 0};
  const preferences = validatePfdPreferences({});
  const wrapper = mount(PrimaryFlightDisplay, {props: {
    flight: pfdState(telemetry), telemetry,
    options: preferences.display, references: preferences.references, guidance: {}
  }});
  try {
    const rotation = selector => Number(wrapper.get(selector).attributes('transform').match(/rotate\(([-\d.]+)/)[1]);
    // An upward pointer rotated clockwise moves right of the fixed zero mark.
    const pointerSide = () => Math.sign(Math.sin(rotation('.pfd-bank-scale > path[transform]') * Math.PI / 180));
    expect(pointerSide()).toBe(Math.sign(rollDeg));
    expect(Math.abs(rotation('.pfd-bank-scale > path[transform]'))).toBe(Math.abs(rollDeg));
    expect(rotation('.pfd-horizon') + rollDeg).toBe(0);
    expect(wrapper.get('.pfd-horizon').attributes('transform')).toContain('translate(0 50)');
    // Enabling the terrain background must not change the bank indication.
    await wrapper.setProps({backgroundReady: true});
    expect(pointerSide()).toBe(Math.sign(rollDeg));
    await wrapper.setProps({flight: pfdState({...telemetry, ready: false})});
    expect(wrapper.find('.pfd-bank-scale > path[transform]').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});
