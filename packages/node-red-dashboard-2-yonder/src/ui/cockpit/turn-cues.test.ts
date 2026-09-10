// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {turnCueState, turnArcPath} from './turn-cues.mjs';
import {agedTelemetry} from './cockpit-state.mjs';
const telemetry=(knots=100,degS=3)=>({ready:true,turnRate:{degS,ageMs:0,source:'ATTITUDE'},estimatedTrueAirspeed:{knots,velocityAgeMs:0,windAgeMs:0,source:'GLOBAL_POSITION_INT/WIND'}});
it('places six-second turn vector at half/standard rate with bounded overrange and correct sign',()=>{
  for(const rate of [-3,-1.5,0,1.5,3]) expect(turnCueState(telemetry(100,rate)).vectorDeg).toBe(rate*6);
  expect(turnCueState(telemetry(100,-6))).toMatchObject({vectorDeg:-24,overrange:true});
  expect(turnCueState(telemetry(100,4))).toMatchObject({vectorDeg:24,overrange:false});
  expect(turnArcPath(-18,114)).toContain('0 0 0 -');
  expect(turnArcPath(18,114)).toContain('0 0 1 ');
});
it('uses TAS for coordinated 3-degree/second bank, suppresses below 50 knots and refuses IAS fallback',()=>{
  expect(turnCueState(telemetry()).bankDeg).toBeCloseTo(15.36,2);
  expect(turnCueState(telemetry(50)).bankDeg).toBeGreaterThan(0);
  expect(turnCueState(telemetry(49.9)).bankDeg).toBeNull();
  expect(turnCueState({...telemetry(),estimatedTrueAirspeed:null,airspeedKt:100,groundspeedKt:100}).bankDeg).toBeNull();
  expect(turnCueState({...telemetry(),ready:false})).toMatchObject({bankDeg:null,vectorDeg:null});
});
it('expires the vector, velocity and wind independently including time spent in the browser',()=>{
  expect(turnCueState(agedTelemetry(telemetry(),-190))).toMatchObject({vectorDeg:18});
  expect(agedTelemetry({ready:true,slipSkid:{ageMs:0}},-190).slipSkid.ageMs).toBe(0);
  const t=telemetry();t.estimatedTrueAirspeed.windAgeMs=4900;
  expect(turnCueState(agedTelemetry(t,99)).bankDeg).not.toBeNull();
  expect(turnCueState(agedTelemetry(t,100))).toMatchObject({bankDeg:null,vectorDeg:18});
  expect(turnCueState(agedTelemetry(telemetry(),2000))).toMatchObject({bankDeg:null,vectorDeg:null});
  for(const ageMs of [-1,NaN,2000]) expect(turnCueState({...telemetry(),turnRate:{...telemetry().turnRate,ageMs}}).vectorDeg).toBeNull();
});
