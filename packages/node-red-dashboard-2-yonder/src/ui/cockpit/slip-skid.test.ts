// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {slipSkidState} from './slip-skid.mjs';
const t=(lateralG=0,normalG=1)=>({ready:true,rollDeg:30,pitchDeg:0,slipSkid:{lateralG,normalG,source:'RAW_IMU',ageMs:0}});
it('centers during coordinated bank and deflects toward apparent gravity',()=>{
 expect(slipSkidState(t()).position).toBe(0);
 expect(slipSkidState({...t(),rollDeg:-45,yawRateDegS:6}).position).toBe(0);
 expect(slipSkidState(t(.1)).position).toBeLessThan(0);
 expect(slipSkidState(t(-.1)).position).toBeGreaterThan(0);
 expect(slipSkidState(t(.2,2)).position).toBeCloseTo(slipSkidState(t(.1,1)).position);
});
it('limits travel and blanks stale, failed, zero-G or negative-G data',()=>{
 expect(slipSkidState(t(-1)).position).toBe(1);expect(slipSkidState(t(1)).position).toBe(-1);
 for(const input of [{...t(),ready:false},{...t(),slipSkid:null},t(0,0),t(0,-1),t(NaN),{...t(),slipSkid:{...t().slipSkid,ageMs:2000}}])expect(slipSkidState(input).available).toBe(false);
});
