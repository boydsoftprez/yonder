// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'vitest';
import assert from 'node:assert/strict';
import {pfdState,tapeTicks,attitudeTransform,verticalSpeedOffset} from './pfd-state.mjs';
const sample={ready:true,rollDeg:20,pitchDeg:10,airspeedKt:81.6,altitudeFt:1393.4,verticalSpeedFpm:500,headingDeg:359,groundspeedKt:79};
test('PFD uses independent MAVLink flight fields in explicit aviation units',()=>{
  const p=pfdState(sample);assert.equal(p.live,true);assert.equal(p.airspeed,81.6);assert.equal(p.altitude,1393.4);assert.equal(p.vsi,500);assert.equal(p.heading,359);
});
test('pitch up moves the horizon down and right bank rolls it left',()=>{
  assert.equal(attitudeTransform(pfdState(sample)),'rotate(-20 320 225) translate(0 50)');
});
test('speed/altitude ticks place larger readings above the pointer and handle negative altitude',()=>{
  const speed=tapeTicks(85,10,3);assert.equal(speed.find(x=>x.value===90).offset,-15);
  const alt=tapeTicks(-50,100,.35);assert.equal(alt.find(x=>x.value===0).offset,-17.5);assert.equal(alt.find(x=>x.value===-100).offset,17.5);
});
test('stale telemetry blanks all readings instead of presenting frozen values',()=>{
  const p=pfdState({...sample,ready:false});assert.equal(p.live,false);
  for(const key of ['roll','pitch','airspeed','altitude','vsi','heading','groundspeed'])assert.equal(p[key],null);
  assert.deepEqual(tapeTicks(null,10,3),[]);
});
test('missing fields remain unavailable, invalid attitude and negative airspeed are rejected',()=>{
  const p=pfdState({...sample,rollDeg:NaN,pitchDeg:100,airspeedKt:-2,altitudeFt:null});
  assert.equal(p.attitudeValid,false);assert.equal(p.airspeed,null);assert.equal(p.altitude,null);assert.equal(p.vsi,500);
});
test('heading wraps through north and flight readings do not require GPS',()=>{
  assert.equal(pfdState({...sample,headingDeg:361,fixType:1}).heading,1);
  assert.equal(pfdState({...sample,headingDeg:-1}).heading,359);
});
test('G3X VSI aligns climb and descent with the original 500, 1000 and 2000 fpm marks',()=>{
  for(const [fpm,offset] of [[0,0],[100,9],[500,45],[1000,90],[1500,105],[2000,120]]){
    assert.equal(verticalSpeedOffset(fpm),offset);
    if(fpm)assert.equal(verticalSpeedOffset(-fpm),-offset);
  }
});
test('VSI never draws beyond its scale or converts missing data to level flight',()=>{
  assert.equal(verticalSpeedOffset(6000),120);assert.equal(verticalSpeedOffset(-6000),-120);
  for(const value of [null,undefined,NaN,Infinity,-Infinity,'500'])assert.equal(verticalSpeedOffset(value),null);
});
