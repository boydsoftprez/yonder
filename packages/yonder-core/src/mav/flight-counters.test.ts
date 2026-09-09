// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { FlightCounters } from './flight-counters.js';
function rebooted() {
  const counters=new FlightCounters();
  counters.observeBoot(100000,'GLOBAL_POSITION_INT',100);
  counters.observeBoot(100000,'SYSTEM_TIME',100);
  counters.heartbeat(true,100);counters.heartbeat(true,1100);
  for(const [ms,at] of [[100,1200],[400,1500],[700,1800]])counters.observeBoot(ms,'GLOBAL_POSITION_INT',at);
  counters.heartbeat(true,1800);counters.landed(2,1800);
  counters.heartbeat(true,2800);counters.landed(2,2800);
  return counters;
}
describe('boot clock epoch reconciliation',()=>{
  it('keeps both delayed and current secondary clocks from resetting primary-clock flight history',()=>{
    const c=rebooted();
    expect(c.readings(2800,true,'selected')['flight.armedSeconds'].value).toBe(1);
    expect(c.observeBoot(100100,'SYSTEM_TIME',2900)).toBe(false);
    expect(c.readings(2900,true,'selected')['flight.bootSeconds'].value).toBe(.7);
    for(const [ms,at] of [[1800,3000],[2100,3300],[2400,3600]])expect(c.observeBoot(ms,'SYSTEM_TIME',at)).toBe(false);
    c.heartbeat(true,3600);c.landed(2,3600);
    const fields=c.readings(3600,true,'selected');
    expect(fields['flight.bootSeconds'].value).toBe(.7);
    expect(fields['flight.armedSeconds']).toMatchObject({value:1.8,quality:'partial'});
    expect(fields['flight.airborneSeconds']).toMatchObject({value:1.8,quality:'partial'});
  });
  it('rejects old secondary clocks even after current secondary packets arrive',()=>{
    const c=rebooted();c.observeBoot(1800,'SYSTEM_TIME',3000);
    expect(c.observeBoot(100100,'SYSTEM_TIME',3100)).toBe(false);
    expect(c.readings(3100,true,'selected')['flight.bootSeconds'].value).toBe(.7);
    for(const [ms,at] of [[2000,3200],[2300,3500],[2600,3800]])expect(c.observeBoot(ms,'SYSTEM_TIME',at)).toBe(false);
    c.heartbeat(true,3800);expect(c.readings(3800,true,'selected')['flight.armedSeconds'].value).toBe(2);
  });
  it('still confirms a later real reboot on the authoritative stream',()=>{
    const c=rebooted();c.observeBoot(1800,'SYSTEM_TIME',3000);c.observeBoot(10800,'GLOBAL_POSITION_INT',12000);
    for(const [ms,at] of [[100,13000],[400,13300]])expect(c.observeBoot(ms,'GLOBAL_POSITION_INT',at)).toBe(false);
    expect(c.observeBoot(700,'GLOBAL_POSITION_INT',13600)).toBe(true);
    c.heartbeat(true,13600);expect(c.readings(13600,true,'selected')['flight.armedSeconds'].value).toBe(0);
    expect(c.readings(13600,true,'selected')['flight.bootSeconds'].value).toBe(.7);
  });
});

describe('boot clock recovery after link buffering',()=>{
  it('reconciles coherent live timestamps after the reboot confirmation itself was buffered',()=>{
    const c=new FlightCounters();c.observeBoot(100000,'GLOBAL_POSITION_INT',100);
    for(const [ms,at] of [[100,4200],[400,4500],[700,4800]])c.observeBoot(ms,'GLOBAL_POSITION_INT',at);
    c.heartbeat(true,4800);c.landed(2,4800);
    expect(c.observeBoot(3900,'GLOBAL_POSITION_INT',5000)).toBe(false);
    c.heartbeat(true,5800);c.landed(2,5800);
    for(const [ms,at] of [[5900,7000],[8900,10000]])expect(c.observeBoot(ms,'GLOBAL_POSITION_INT',at)).toBe(false);
    expect(c.readings(10000,true,'selected')['flight.bootSeconds']).toMatchObject({value:8.9,ageMs:0,quality:'reported'});
    c.heartbeat(true,10000);c.landed(2,10000);
    expect(c.readings(10000,true,'selected')['flight.armedSeconds']).toMatchObject({value:1,quality:'partial'});
    expect(c.readings(10000,true,'selected')['flight.airborneSeconds']).toMatchObject({value:1,quality:'partial'});
    c.observeBoot(10900,'GLOBAL_POSITION_INT',12000);
    expect(c.readings(12000,true,'selected')['flight.bootSeconds']).toMatchObject({value:10.9,ageMs:0});
    for(const [ms,at] of [[100,13000],[400,13300]])expect(c.observeBoot(ms,'GLOBAL_POSITION_INT',at)).toBe(false);
    expect(c.observeBoot(700,'GLOBAL_POSITION_INT',13600)).toBe(true);
    c.heartbeat(true,13600);expect(c.readings(13600,true,'selected')['flight.armedSeconds'].value).toBe(0);
  });
  it('does not recover toward one delayed old packet or repeated non-advancing old timestamps',()=>{
    const c=rebooted();c.observeBoot(1800,'SYSTEM_TIME',3000);
    for(const at of [3100,3500,4000])expect(c.observeBoot(100100,'SYSTEM_TIME',at)).toBe(false);
    expect(c.readings(4000,true,'selected')['flight.bootSeconds'].value).toBe(.7);
    c.observeBoot(2900,'SYSTEM_TIME',4100);
    expect(c.readings(4100,true,'selected')['flight.bootSeconds'].value).toBe(.7);
    c.heartbeat(true,4100);expect(c.readings(4100,true,'selected')['flight.armedSeconds'].value).toBe(2.3);
  });
});

describe('boot clock source authority',()=>{
  it('does not let three delayed secondary clocks override interleaved fresh primary clocks or reset history',()=>{
    const c=rebooted();
    for(const [liveMs,liveAt,oldMs,oldAt] of [[1900,3000,100100,3100],[2200,3300,100400,3400],[2500,3600,100700,3700]]){
      c.observeBoot(liveMs,'GLOBAL_POSITION_INT',liveAt);c.observeBoot(oldMs,'SYSTEM_TIME',oldAt);
      expect(c.readings(oldAt,true,'selected')['flight.bootSeconds'].value).toBe(liveMs/1000);
    }
    for(const [ms,at] of [[3000,4100],[3300,4400],[3600,4700]])expect(c.observeBoot(ms,'SYSTEM_TIME',at)).toBe(false);
    c.heartbeat(true,4700);c.landed(2,4700);
    expect(c.readings(4700,true,'selected')['flight.bootSeconds'].value).toBe(2.5);
    expect(c.readings(4700,true,'selected')['flight.armedSeconds']).toMatchObject({value:2.9,quality:'partial'});
    expect(c.readings(4700,true,'selected')['flight.airborneSeconds']).toMatchObject({value:2.9,quality:'partial'});
  });
  it('uses SYSTEM_TIME only before GLOBAL_POSITION_INT establishes authority, and expires instead of switching back',()=>{
    const c=new FlightCounters();c.observeBoot(100000,'SYSTEM_TIME',100);c.heartbeat(true,100);c.heartbeat(true,1100);
    expect(c.readings(1100,true,'selected')['flight.bootSeconds'].value).toBe(100);
    c.observeBoot(1000,'GLOBAL_POSITION_INT',1200);c.heartbeat(true,1200);
    expect(c.readings(1200,true,'selected')['flight.bootSeconds']).toMatchObject({value:1,source:'GLOBAL_POSITION_INT · selected'});
    expect(c.readings(1200,true,'selected')['flight.armedSeconds']).toMatchObject({value:1,quality:'partial'});
    expect(c.readings(1200,true,'selected')['flight.armedSeconds'].reason).toMatch(/clock source|continuity/i);
    for(const [ms,at] of [[101000,2000],[102000,3000],[103000,4000],[105000,6200]])c.observeBoot(ms,'SYSTEM_TIME',at);
    expect(c.readings(6200,true,'selected')['flight.bootSeconds']).toMatchObject({value:null,quality:'unavailable'});
  });
});

describe('observed AUTO execution total',()=>{
  it('counts only bracketing armed AUTO observations and accumulates across pause, resume and disarm cycles',()=>{
    const c=new FlightCounters();c.heartbeat(false,100,false);
    c.heartbeat(true,1100,true);c.heartbeat(true,2100,true);
    c.heartbeat(true,3100,false);c.heartbeat(true,4100,false);
    c.heartbeat(true,5100,true);c.heartbeat(true,6100,true);
    c.heartbeat(false,7100,true);c.heartbeat(false,8100,true);
    expect(c.readings(8100,true,'selected')['flight.autoSeconds']).toMatchObject({value:2,unit:'s',quality:'partial',ttlMs:3000});
    expect(c.readings(8100,true,'selected')['flight.armedSeconds'].value).toBe(5);
    c.heartbeat(true,9100,true);c.heartbeat(true,10100,true);
    expect(c.readings(10100,true,'selected')['flight.autoSeconds'].value).toBe(3);
  });
  it('excludes gaps, retains totals through reconnect, and resets on the authoritative confirmed reboot',()=>{
    const c=new FlightCounters();c.observeBoot(100000,'GLOBAL_POSITION_INT',100);
    c.heartbeat(true,100,true);c.heartbeat(true,1100,true);c.heartbeat(true,6100,true);
    expect(c.readings(6100,true,'selected')['flight.autoSeconds'].value).toBe(1);
    c.gap();c.heartbeat(true,7100,true);c.heartbeat(true,8100,true);
    expect(c.readings(8100,true,'selected')['flight.autoSeconds'].value).toBe(2);
    for(const [ms,at] of [[100,8200],[400,8500],[700,8800]])c.observeBoot(ms,'GLOBAL_POSITION_INT',at);
    c.heartbeat(true,8800,true);expect(c.readings(8800,true,'selected')['flight.autoSeconds'].value).toBe(0);
    expect(c.readings(11800,true,'selected')['flight.autoSeconds']).toMatchObject({value:null,quality:'unavailable'});
  });
  it('explains each total independently and never presents unavailable AUTO support as a zero',()=>{
    const c=new FlightCounters();c.heartbeat(true,100);c.landed(2,100);
    expect(c.readings(100,true,'selected')['flight.autoSeconds'].value).toBeNull();
    c.heartbeat(true,1100,true);c.landed(2,1100);
    const fields=c.readings(1100,true,'selected');
    expect(fields['flight.autoSeconds'].reason).toMatch(/AUTO.*collector.*gap/i);
    expect(fields['flight.armedSeconds'].reason).toMatch(/armed.*collector.*gap/i);
    expect(fields['flight.airborneSeconds'].reason).toMatch(/IN_AIR.*TAKEOFF.*LANDING.*transition.*collector.*gap/i);
  });
});
