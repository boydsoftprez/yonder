// SPDX-License-Identifier: GPL-3.0-or-later
import {expect,it} from 'vitest';
import {common,minimal,MavLinkProtocolV2,type MavLinkData} from 'node-mavlink';
import {VehicleService} from './vehicle.js';
import {OwnTrail} from './own-trail.js';

function rig(){
  let now=100000,sequence=0;const sent:Uint8Array[]=[];
  const service=new VehicleService({clock:{now:()=>now,setTimer:()=>0,clearTimer:()=>{}},send:async b=>{sent.push(b)}});
  const feed=(m:MavLinkData,system=1)=>service.receive(new MavLinkProtocolV2(system,1).serialize(m,sequence++%256));
  const heartbeat=(system=1)=>feed(Object.assign(new minimal.Heartbeat(),{autopilot:3,type:1}),system);
  const point=(boot:number,lat=35,lon=-83,fix=3)=>{heartbeat();feed(Object.assign(new common.GpsRawInt(),{fixType:fix}));feed(Object.assign(new common.GlobalPositionInt(),{timeBootMs:boot,lat:Math.round(lat*1e7),lon:Math.round(lon*1e7)}));};
  return {service,sent,feed,heartbeat,point,advance:(ms:number)=>{now+=ms}};
}
it('retains observed ownship history without a browser or outbound aircraft commands',()=>{
  const r=rig();r.point(1000);r.advance(1000);r.point(2000,35.0001);
  expect(r.service.snapshot().trail).toMatchObject({latest:2,startBootMs:1000});
  const page=r.service.trailPage();expect(page.points).toHaveLength(2);
  expect(page.points[1].slice(2,4)).toEqual([35.0001,-83]);
  expect(page.points[1][4]).toBeGreaterThan(10);expect(r.sent).toEqual([]);r.service.close();
});
it('keeps same-aircraft history through a reconnect and starts a separate line segment',()=>{
  const r=rig();r.point(10000);const epoch=r.service.snapshot().trail!.epoch;
  r.advance(6000);r.point(16000,35.001);
  const page=r.service.trailPage();expect(page.epoch).toBe(epoch);expect(page.gaps).toBe(1);
  expect(page.points[1][5]).not.toBe(page.points[0][5]);expect(page.points[1][4]).toBe(0);r.service.close();
});
it('ignores one delayed position and starts new history after a confirmed reboot',()=>{
  const trail=new OwnTrail();trail.observe(100000,35,-83,true,1000);
  const old=trail.summary().epoch;
  trail.observe(99000,35,-83,true,1100);trail.observe(101000,35.0001,-83,true,2000);
  expect(trail.summary().epoch).toBe(old);
  trail.observe(1000,35,-83,true,3000);trail.observe(1500,35,-83,true,3500);
  expect(trail.summary().epoch).toBe(old);
  trail.observe(2000,35,-83,true,4000);
  expect(trail.summary().epoch).not.toBe(old);expect(trail.page().points).toHaveLength(1);
  expect(trail.summary().startBootMs).toBe(2000);
});
it('unwraps the millisecond clock instead of confusing rollover with reboot',()=>{
  const t=new OwnTrail();t.observe(2**32-1000,35,-83,true,1000);const epoch=t.summary().epoch;
  t.observe(0,35.0001,-83,true,2000);t.observe(1000,35.0002,-83,true,3000);
  expect(t.summary().epoch).toBe(epoch);expect(t.summary().bootMs).toBe(2**32+1000);expect(t.page().points).toHaveLength(3);
  t.observe(2**32-500,36,-83,true,3500);t.observe(2000,35.0003,-83,true,4000);
  expect(t.summary().bootMs).toBe(2**32+2000);expect(t.summary().epoch).toBe(epoch);
});
it('rejects missing fixes, invalid positions, duplicates and impossible jumps without bridging them',()=>{
  const t=new OwnTrail();t.observe(1000,35,-83,false,1000);t.observe(2000,NaN,-83,true,2000);
  expect(t.page().points).toEqual([]);
  t.observe(3000,35,-83,true,3000);t.observe(3000,35.1,-83,true,3500);t.observe(4000,40,-83,true,4000);
  expect(t.page().points).toHaveLength(1);
  t.observe(5000,35.0001,-83,true,5000);expect(t.page().points[1][5]).toBe(2);expect(t.page().points[1][4]).toBe(0);
});
it('preserves the first and latest observed path while bounding long recordings',()=>{
  const t=new OwnTrail(8);for(let i=1;i<=40;i++)t.observe(i*1000,35+i*.0001,-83,true,i*1000);
  const page=t.page();expect(page.points.length).toBeLessThanOrEqual(8);
  expect(page.points[0][0]).toBe(1);expect(page.points.at(-1)![0]).toBe(40);
  expect(page.simplified).toBe(true);expect(page.truncated).toBe(false);
  expect(page.points.at(-1)![4]).toBeGreaterThan(430);
});
it('pages history in bounded reads and returns only new points after the cursor',()=>{
  const t=new OwnTrail();for(let i=1;i<=1100;i++)t.observe(i*1000,35+i*.0001,-83,true,i*1000);
  const all=t.page();expect(all.points.length).toBe(1024);expect(all.more).toBe(true);
  const last=t.page(all.epoch,all.next);expect(last.points.every(p=>p[0]>all.next)).toBe(true);
  expect(last.points).toHaveLength(76);expect(last.more).toBe(false);
  expect(t.page('previous-boot',999).reset).toBe(true);
});
it('starts a new recording when the selected aircraft changes',()=>{
  const r=rig();r.point(1000);const epoch=r.service.snapshot().trail!.epoch;
  r.advance(4000);r.heartbeat(2);expect(r.service.snapshot().trail!.epoch).not.toBe(epoch);
  expect(r.service.trailPage().points).toEqual([]);r.service.close();
});
it('limits recovery to the chosen time or distance window at the aircraft',()=>{
  const t=new OwnTrail();for(let i=1;i<=1200;i++)t.observe(i*1000,35+i*.0001,-83,true,i*1000);
  const time=t.page(t.summary().epoch,0,1190000,0);expect(time.points).toHaveLength(11);
  const distance=t.page(t.summary().epoch,0,0,t.summary().tail![4]-100);expect(distance.points.length).toBeLessThan(12);
  const absent=t.page(t.summary().epoch,0,9999999,0);expect(absent).toMatchObject({points:[],next:1200,more:false});
});
