// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {PosePresentation} from './presentation-pose.mjs';
const pose=(time:number)=>({lat:35,lon:-83,altitude:400,heading:time/100,pitch:0,roll:time/200});
it.each([125,250,500,1000])('interpolates throughout a %i ms telemetry interval, without predicting beyond received data',interval=>{
 const p=new PosePresentation(null);
 const values=[];let next=0;
 for(let t=0;t<=interval*12;t+=10){
  if(t>=next){p.push(pose(next),next,next);next+=interval;}
  const value=p.at(t);if(t>interval*8)values.push(value.heading);
  expect(value.heading).toBeLessThanOrEqual((next-interval)/100);
 }
 const moving=values.slice(1).filter((v,i)=>v>values[i]).length;
 expect(moving/(values.length-1)).toBeGreaterThan(.95);
});
it('does not insert clock-only Vue updates as new aircraft observations',()=>{
 const p=new PosePresentation(null);p.push(pose(0),0,'a');p.push(pose(250),250,'b');
 for(let t=300;t<500;t+=20)p.push(pose(250),t,'b');
 expect(p.samples).toHaveLength(2);expect(p.at(480).heading).toBeLessThan(2.5);
});
it('holds the last observed pose on packet loss, resets invalid data, and never rewinds when cadence changes',()=>{
 const p=new PosePresentation(null);let previous=-1;
 for(const t of [0,250,500,780,1040,1300,1800,2300]){
  p.push(pose(t),t,t);
  for(let offset=0;offset<200;offset+=10){const value=p.at(t+offset).heading;expect(value).toBeGreaterThanOrEqual(previous-1e-9);previous=value;}
 }
 expect(p.at(5000).heading).toBe(23);p.push(null,5010,'invalid');expect(p.at(5010)).toBeNull();
 p.push(pose(5100),5100,'reconnect');expect(p.at(5100).heading).toBe(51);
});
