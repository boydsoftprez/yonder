// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
const modulePath = './cockpit-state.mjs';
const state = await import(/* @vite-ignore */ modulePath).catch(() => null);

describe('production cockpit state boundary', () => {
  it('keeps absent and stale readings unavailable instead of drawing zeroes', () => {
    expect(state).not.toBeNull();
    expect(state!.flightView({ telemetry: { ready: false, airspeedKt: 42, rollDeg: 7 } }).airspeed).toBeNull();
    expect(state!.flightView({ telemetry: { ready: true, airspeedKt: 0, pitchDeg: 0, rollDeg: 0, headingDeg: 360 } })).toMatchObject({ airspeed: 0, heading: 0, attitudeValid: true });
  });
  it('ages each measurement at the browser when its snapshot stops arriving', () => {
    expect(state).not.toBeNull();
    expect(state!.flightView({ telemetry: { ready: true, airspeedKt: 40, pitchDeg: 0, rollDeg: 0 } }, 2500).airspeed).toBeNull();
  });
  it('predicts measured travel without presenting ETE as a turn countdown', () => {
    expect(state).not.toBeNull();
    const path = state!.prediction({ latitude: 35, longitude: -84, groundspeedKt: 60, headingDeg: 90, ready: true, fixType:3 }, { seconds: 30 });
    expect(path.label).toBe('30 s measured-motion estimate');
    expect(path.distanceM).toBeCloseTo(926, 0);
    expect(path.points.at(-1).lon).toBeGreaterThan(-84);
    expect(state!.prediction({ ready: false }, { seconds: 30 }).points).toEqual([]);
  });
  it('does not substitute an unknown altitude datum', () => {
    expect(state).not.toBeNull();
    expect(() => state!.targetAction({ lat: 35, lon: -84, altitude: 100, datum: 'unknown' })).toThrow(/datum/);
  });
  it('requires real frame registration before camera scene overlays', () => {
    expect(state).not.toBeNull();
    expect(state!.cameraOverlayGate({ calibration: { valid: true }, framePose: null }).ready).toBe(false);
  });
});

it('requires a fresh GPS fix for ownship, traffic centering and the motion vector',()=>{
 const t={ready:true,latitude:0,longitude:0,fixType:0,satellites:0,groundspeedKt:20,headingDeg:90};
 expect(state!.aircraftMapPosition(t)).toBeNull();
 expect(state!.aircraftPositionMessage(t)).toMatch(/No GPS fix.*0 satellites/);
 expect(state!.prediction(t).points).toEqual([]);
 // Zero coordinates can also be a real location; the fix, not a zero check,
 // distinguishes that location from the uninitialised bench controller.
 expect(state!.aircraftMapPosition({...t,fixType:2})).toEqual({lat:0,lon:0});
 const expired=state!.agedTelemetry({...t,fixType:3,fields:{fixType:{valid:true,ageMs:4900}}},200);
 expect(state!.aircraftMapPosition(expired)).toBeNull();
 expect(state!.aircraftMapPosition({...t,fixType:3,latitude:null})).toBeNull();
 expect(state!.aircraftMapPosition({...t,fixType:3,ready:false})).toBeNull();
});

it('keeps instrument projection aligned when the viewport widens', async()=>{
 const name='./terrain-viewport.mjs';const module=await import(/* @vite-ignore */ name).catch(()=>null);expect(module).not.toBeNull();
 const native=module!.viewportProjection(640,650),wide=module!.viewportProjection(1280,650);
 expect(wide.matrix[0]).toBeCloseTo(native.matrix[0]/2,6);expect(wide.matrix[5]).toBeCloseTo(native.matrix[5],6);expect(wide.matrix[9]).toBeCloseTo(native.matrix[9],6);
});
it('expires position and height for every display consumer, preserving GPS-specific TTL',()=>{expect(state!.agedTelemetry).toBeTypeOf('function');const t=state!.agedTelemetry({ready:true,latitude:35,globalAltitudeM:400,gpsAltitudeM:410,fields:{latitude:{ageMs:1900,valid:true},globalAltitudeM:{ageMs:1900,valid:true},gpsAltitudeM:{ageMs:1900,valid:true}}},200);expect(t.latitude).toBeNull();expect(t.globalAltitudeM).toBeNull();expect(t.gpsAltitudeM).toBe(410);});
it('requires matching EGM96 ownship height before perspective internet traffic',async()=>{const {trafficOwnship}=await import('./traffic-state.mjs');const f={live:true,attitudeValid:true,altitude:1300,heading:0,pitch:0,roll:0},t={ready:true,fixType:3,latitude:35,longitude:-84,globalAltitudeM:400,gpsAltitudeM:410};expect(trafficOwnship(f,t)).toBeNull();expect(trafficOwnship(f,{...t,altitudeDatum:'EGM96'}).altitudeMslM).toBe(400)});
it('does not retain flight-director readiness after heartbeat mode expiry',()=>{const t={ready:true,mode:'AUTO',customMode:10,fdReady:true,rollDeg:1,pitchDeg:1,navRollDeg:2,navPitchDeg:2,fields:{mode:{valid:true,ageMs:2900},customMode:{valid:true,ageMs:2900}}};expect(state!.flightView({telemetry:t},200).fdValid).toBe(false)});
it('does not draw a geographic AUTO target for action items or current-location takeoff',async()=>{const {navigationView}=await import('./navigation-view.mjs');for(const command of [178,22]){const snapshot={identity:{autopilot:3},telemetry:{ready:true,mode:'AUTO',latitude:35.96,longitude:-83.36,groundspeedKt:50},mission:{currentSeq:1,currentFresh:true,items:[{seq:1,command,frame:command===178?2:3,x:0,y:0,z:90,params:[0,0,0,0]}]}};expect(navigationView(snapshot).valid).toBe(false)}});
