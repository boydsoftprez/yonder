// SPDX-License-Identifier: GPL-3.0-or-later
import {it, expect} from 'vitest';
import {ardupilotmega, common, minimal, MavLinkProtocolV2, type MavLinkData} from 'node-mavlink';
import {VehicleService} from './vehicle.js';

function rig() {
  let now=100, seq=0;
  const service=new VehicleService({clock:{now:()=>now,setTimer:()=>0,clearTimer:()=>{}},send:async()=>{throw new Error('Display must remain passive');}});
  const feed=(m:MavLinkData,system=1)=>service.receive(new MavLinkProtocolV2(system,1).serialize(m,seq++));
  const heartbeat=(autopilot=3)=>feed(Object.assign(new minimal.Heartbeat(),{type:1,autopilot}));
  heartbeat();
  return {service,feed,heartbeat,advance:(ms:number)=>{now+=ms;},t:()=>service.snapshot().telemetry};
}
it('converts banked body rates to heading rate, with the correct left/right sign',()=>{
  const r=rig(), rad=Math.PI/180, roll=30*rad, pitch=10*rad;
  for(const rate of [-3,0,3]) {
    r.feed(Object.assign(new common.Attitude(),{roll,pitch,pitchspeed:rate*rad*Math.sin(roll)*Math.cos(pitch),yawspeed:rate*rad*Math.cos(roll)*Math.cos(pitch)}));
    expect(r.t().turnRate?.degS).toBeCloseTo(rate,5);
  }
  r.advance(2000);r.heartbeat();expect(r.t().turnRate).toBeNull();
  r.feed(Object.assign(new common.Attitude(),{roll:0,pitch:Math.PI/2,pitchspeed:0,yawspeed:.1}));expect(r.t().turnRate).toBeNull();
  r.feed(Object.assign(new common.Attitude(),{roll:0,pitch:0,pitchspeed:NaN,yawspeed:.1}));expect(r.t().turnRate).toBeNull();
  r.service.close();
});
it('estimates 3D true airspeed from ground velocity minus FROM wind, not indicated airspeed',()=>{
  const r=rig();
  const velocity=()=>r.feed(Object.assign(new common.GlobalPositionInt(),{lat:350000000,lon:-830000000,vx:2000,vy:1000,vz:-500}));
  r.feed(Object.assign(new common.VfrHud(),{airspeed:10}));velocity();expect(r.t().estimatedTrueAirspeed).toBeNull();
  const wind=()=>r.feed(Object.assign(new ardupilotmega.Wind(),{direction:0,speed:10,speedZ:2}));wind();
  expect(r.t().estimatedTrueAirspeed?.knots).toBeCloseTo(Math.hypot(30,10,-7)*1.9438444924406);
  r.advance(2000);r.heartbeat();expect(r.t().estimatedTrueAirspeed).toBeNull();
  velocity();expect(r.t().estimatedTrueAirspeed).toMatchObject({velocityAgeMs:0,windAgeMs:2000});
  r.advance(3000);r.heartbeat();velocity();expect(r.t().estimatedTrueAirspeed).toBeNull();
  wind();r.feed(Object.assign(new ardupilotmega.Wind(),{direction:0,speed:10,speedZ:NaN}));expect(r.t().estimatedTrueAirspeed).toBeNull();expect(r.t().wind).not.toBeNull();
  wind();r.advance(3100);expect(r.t().estimatedTrueAirspeed).toBeNull();r.service.close();
});
it('does not borrow turn/airspeed from another vehicle or retain them after replacement',()=>{
  const r=rig();
  const attitude=()=>Object.assign(new common.Attitude(),{roll:0,pitch:0,pitchspeed:0,yawspeed:.1});
  r.feed(attitude(),2);expect(r.t().turnRate).toBeNull();r.feed(attitude());expect(r.t().turnRate).not.toBeNull();
  r.heartbeat(12);expect(r.t().turnRate).toBeNull();expect(r.t().estimatedTrueAirspeed).toBeNull();r.service.close();
});
