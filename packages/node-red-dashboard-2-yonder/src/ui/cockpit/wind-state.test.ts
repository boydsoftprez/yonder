// SPDX-License-Identifier: GPL-3.0-or-later
import {describe,it,expect} from 'vitest';
import {windState} from './wind-state.mjs';
const telemetry=(from=0,heading=0,speed=10)=>({ready:true,headingDeg:heading,wind:{directionFromDeg:from,speedKt:speed,ageMs:0,source:'WIND'},fields:{}});
describe('PFD wind relative to true heading',()=>{
 it.each([[0,10,0],[90,0,10],[180,-10,0],[270,0,-10]])('resolves wind from %d degrees without reversing the arrows',(from,head,cross)=>{
  const w=windState(telemetry(from));expect(w.available).toBe(true);expect(w.headwindKt).toBeCloseTo(head);expect(w.crosswindKt).toBeCloseTo(cross);
 });
 it('uses heading rather than ground track and wraps north',()=>{
  const w=windState({...telemetry(1,359),trackDeg:90});
  expect(w.headwindKt).toBeCloseTo(9.9939,3);expect(w.crosswindKt).toBeCloseTo(.348995,3);expect(w.relativeFromDeg).toBe(2);
  const turn=windState(telemetry(0,90));expect(turn.crosswindKt).toBeCloseTo(-10);
 });
 it('keeps a reported zero estimate distinct from missing data',()=>{
  expect(windState(telemetry(0,0,0))).toMatchObject({available:true,headwindKt:0,crosswindKt:0,speedKt:0});
  for(const t of [{...telemetry(),wind:null},{...telemetry(),ready:false},{...telemetry(),headingDeg:null},{...telemetry(),fields:{headingDeg:{valid:false}}},...[-1,5000,NaN].map(ageMs=>({...telemetry(),wind:{...telemetry().wind,ageMs}}))]) expect(windState(t).available).toBe(false);
 });
});
