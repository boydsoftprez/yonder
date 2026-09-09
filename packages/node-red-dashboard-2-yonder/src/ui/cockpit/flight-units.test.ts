// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {toDisplay,fromDisplay,flightValue,canonicalValue,units} from './flight-units.mjs';
it('converts exact physical quantities at the UI boundary',()=>{
 expect(toDisplay(30.48,'ft')).toBeCloseTo(100);
 expect(fromDisplay(300,'fpm')).toBeCloseTo(1.524);
 expect(toDisplay(44.704,'mph')).toBeCloseTo(100);
 expect(fromDisplay(60,'kt')).toBeCloseTo(30.8666666667);
});
it('round-trips canonical instrument references without changing their meaning',()=>{
 const u={speedUnit:'mph',altitudeUnit:'m',verticalSpeedUnit:'mps'};
 for(const [key,n] of [['airspeed',57],['altitude',450],['vsi',300],['heading',270]] as const)
  expect(canonicalValue(key,flightValue(key,n,u),u)).toBeCloseTo(n);
 expect(toDisplay(null,'ft')).toBe(null);expect(fromDisplay('','ft')).toBe(null);
 expect(units({speedUnit:'invalid'}).speedUnit).toBe('kt');
});
