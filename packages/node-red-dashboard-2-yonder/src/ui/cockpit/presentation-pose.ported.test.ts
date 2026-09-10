// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'vitest';
import assert from 'node:assert/strict';
import {PosePresentation} from './presentation-pose.mjs';
const pose={lat:35,lon:-83,altitude:400,heading:359,pitch:0,roll:0};
test('presentation interpolates between received poses at a fixed delay without extrapolating',()=>{
 const p=new PosePresentation();p.push(pose,0);p.push({...pose,altitude:410,pitch:10,roll:20,heading:1},100);
 assert.deepEqual(p.at(150),{...pose,altitude:405,pitch:5,roll:10,heading:0});
 assert.equal(p.at(300).altitude,410);assert.equal(p.at(50).altitude,400);
 assert.equal(pose.altitude,400,'Received telemetry is never mutated');
});
test('presentation crosses north, roll wrap and the date line using the short path',()=>{
 const p=new PosePresentation();p.push({...pose,lon:179.999,roll:179},0);p.push({...pose,lon:-179.999,roll:-179,heading:1},100);
 const middle=p.at(150);assert.equal(Math.abs(middle.roll),180);assert.ok(Math.abs(Math.abs(middle.lon)-180)<1e-8);assert.equal(middle.heading,0);
});
test('invalid data, gaps, time reversal and a relocated aircraft reset presentation immediately',()=>{
 const p=new PosePresentation();p.push(pose,0);p.push(null,100);assert.equal(p.at(150),null);
 p.push({...pose,altitude:500},200);assert.equal(p.at(200).altitude,500);
 p.push({...pose,altitude:600},1000);assert.equal(p.at(1000).altitude,600);
 p.push({...pose,altitude:700},900);assert.equal(p.at(900).altitude,700);
 p.push({...pose,lat:40},1000);assert.equal(p.at(1000).lat,40);
 p.push({...pose,pitch:NaN},1100);assert.equal(p.at(1100),null);
});
