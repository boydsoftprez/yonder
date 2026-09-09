// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'vitest';
import assert from 'node:assert/strict';
import {parseReference,referenceStep,validatePfdPreferences,missionAltitudeFt,flightDirectorCue} from './pfd-controls.mjs';
import {pfdState} from './pfd-state.mjs';
test('reference entry rejects missing, malformed and out-of-range input',()=>{
  for(const value of ['',null,undefined,false,'1e3','1,200','NaN',Infinity,'60001'])assert.throws(()=>parseReference('altitude',value));
  assert.equal(parseReference('altitude','-100'),-100);assert.equal(parseReference('heading','359'),359);assert.throws(()=>parseReference('heading',360));
});
test('reference steps wrap heading and clamp numeric ranges',()=>{
  assert.equal(referenceStep('heading',359,1),0);assert.equal(referenceStep('heading',0,-10),350);
  assert.equal(referenceStep('airspeed',3,-10),0);assert.equal(referenceStep('vsi',5950,100),6000);
});
test('saved preferences sanitize values without treating null as a zero reference',()=>{
  const p=validatePfdPreferences({references:{airspeed:null,heading:99,altitude:Infinity},display:{tapeOpacity:0,hsiOpacity:5,fdStyle:'bogus',fdVisible:false,pitchLadder:'false'}});
  assert.deepEqual(p.references,{airspeed:null,heading:99,altitude:null,vsi:null});assert.equal(p.display.tapeOpacity,.1);assert.equal(p.display.hsiOpacity,1);assert.equal(p.display.fdStyle,'vbar');assert.equal(p.display.fdVisible,false);assert.equal(p.display.pitchLadder,true);
});
test('mission altitude presets respect MSL, home-relative and unavailable terrain datum',()=>{
  const home={alt:315};assert.ok(Math.abs(missionAltitudeFt({frame:3,alt:91.44},home)-1333.4645669238)<.001);
  assert.ok(Math.abs(missionAltitudeFt({frame:5,alt:100},home)-328.0839895)<1e-8);assert.equal(missionAltitudeFt({frame:10,alt:100},home),null);assert.equal(missionAltitudeFt({frame:6,alt:100},null),null);
});
test('flight director requires fresh explicit desired attitude and live instruments',()=>{
  const telemetry={ready:true,rollDeg:5,pitchDeg:3,navRollDeg:10,navPitchDeg:7,fdReady:true};
  const f=pfdState(telemetry);assert.equal(f.fdValid,true);assert.deepEqual(flightDirectorCue(f),{rollError:5,pitchError:4,x:11,y:-20,rotation:5});
  assert.equal(flightDirectorCue(pfdState({...telemetry,fdReady:false})),null);assert.equal(flightDirectorCue(pfdState({...telemetry,ready:false})),null);
  assert.equal(flightDirectorCue(pfdState({...telemetry,navPitchDeg:null})),null);
});
test('flight director wraps bank error and bounds rendered cue travel',()=>{
  assert.equal(flightDirectorCue({attitudeValid:true,fdValid:true,roll:179,pitch:-50,navRoll:-179,navPitch:50}).rollError,2);
  const cue=flightDirectorCue({attitudeValid:true,fdValid:true,roll:0,pitch:0,navRoll:-100,navPitch:-50});assert.equal(cue.x,-55);assert.equal(cue.y,60);assert.equal(cue.rotation,-30);
});
