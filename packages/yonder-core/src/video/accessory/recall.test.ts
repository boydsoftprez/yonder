// SPDX-License-Identifier: GPL-3.0-or-later
import { describe,it,expect } from 'vitest';
import { GimbalController } from './gimbal.js';
import type { GuardContext } from './guard.js';
import type { IntentClock, IntentGrant } from './intent.js';
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve()};
function rig(pan=0,tilt=0){
  let now=1000,serial=0,lastWrite=-Infinity,wire={pan:0,tilt:0};
  const timers=new Map<number,{at:number;fn:()=>void}>(),writes:{at:number;pan:number;tilt:number;deadline:number}[]=[];
  const clock:IntentClock={now:()=>now,setTimer:(ms,fn)=>{timers.set(++serial,{at:now+ms,fn});return serial},clearTimer:id=>{timers.delete(id as number)}};
  const c:GuardContext={now,attitudeMaxAgeMs:500,attitude:{yaw:0,pitch:0,roll:0,mode:1,at:now,pitchLimit:false,yawLimit:false,fault:false,joints:{pan,tilt,roll:0},quaternion:[1,0,0,0]},mount:null,envelopes:[],actions:[],signs:{pan:null,tilt:null},limitDirections:{},intentAllowanceMs:500,deviceStopAllowanceMs:800};
  const controller=new GimbalController({clock,context:()=>c,write:async(command,options)=>{
    if(!options.admission!())throw new Error('Late dispatch');const p=Buffer.from(command.payload!);wire={pan:p.readInt16LE(0)/10,tilt:p.readInt16LE(4)/10};lastWrite=now;writes.push({at:now,...wire,deadline:options.deadline!});
  }});
  async function step(ms=100,move=true,fresh=true){
    for(let elapsed=0;elapsed<ms;elapsed+=50){
      now+=50;
      if(move && now-lastWrite<=500){c.attitude!.joints!.pan=Math.max(-230,Math.min(70,c.attitude!.joints!.pan-wire.pan*.05));c.attitude!.joints!.tilt=Math.max(-100,Math.min(50,c.attitude!.joints!.tilt-wire.tilt*.05));}
      if(fresh){c.attitude!.at=now;}
      if(fresh && c.attitude!.joints){const p=c.attitude!.joints!.pan*Math.PI/360,t=c.attitude!.joints!.tilt*Math.PI/360;c.attitude!.quaternion=[Math.cos(p)*Math.cos(t),-Math.sin(p)*Math.sin(t),Math.cos(p)*Math.sin(t),Math.sin(p)*Math.cos(t)];}
      controller.refresh();for(const[id,t]of [...timers])if(t.at<=now){timers.delete(id);t.fn()}await settle();
    }
  }
  let grant:IntentGrant,seq=0;
  function start(target={pan:10,tilt:0},maxRate=60){const r=controller.startRecall('operator','press',target,'View',maxRate);if(r.accepted)grant=r.grant;return r}
  function renew(){const r=controller.renewRecall('operator',{...grant,seq:++seq});if(r.accepted&&r.next)grant=r.next;return r}
  return {controller,c,writes,step,start,renew,grant:()=>grant};
}
describe('native joint preset recall',()=>{
  it('takes the long in-range path rather than wrapping through a physical stop',async()=>{
    const h=rig(70,0);expect(h.start({pan:-220,tilt:25}).accepted).toBe(true);let arrived=false;
    for(let n=0;n<250;n++){const r=h.renew();if(!r.accepted)throw new Error(r.reason);if(r.arrived){arrived=true;break}await h.step()}
    expect(arrived).toBe(true);await h.step(800);
    expect(Math.abs(h.c.attitude!.joints!.pan+220)).toBeLessThan(1);expect(Math.abs(h.c.attitude!.joints!.tilt-25)).toBeLessThan(1);
    expect(h.writes[0].pan).toBeGreaterThan(0);expect(h.writes.every(w=>Math.hypot(w.pan,w.tilt)<=60)).toBe(true);h.controller.close();
  });
  it('does not report arrival from stale position feedback',async()=>{
    const h=rig();h.start({pan:0,tilt:0});h.c.attitude!.at=-1000;
    expect(h.renew().accepted).toBe(false);expect(h.controller.recalling).toBe(false);expect(h.writes).toHaveLength(0);h.controller.close();
  });
  it('release and a lost client retire the target and do not resume it on later traffic',async()=>{
    const h=rig();h.start({pan:60,tilt:30});h.renew();await h.step(100);h.renew();await h.step(1000);
    expect(h.controller.recalling).toBe(false);const count=h.writes.length;expect(h.renew()).toMatchObject({accepted:false,reason:'inactive'});await h.step(1000);expect(h.writes).toHaveLength(count);h.controller.close();
    const stopped=rig();stopped.start();stopped.renew();stopped.controller.end('operator',stopped.grant().gesture);expect(stopped.controller.recalling).toBe(false);expect(stopped.renew().accepted).toBe(false);stopped.controller.close();
  });
  it.each(['mode','position','fault','rollLimit','stale'] as const)('cancels recall on %s and permits no later old-target writes',async kind=>{
    const h=rig();h.start({pan:40,tilt:20});h.renew();await h.step(100);
    if(kind==='mode')h.c.attitude!.mode=0;
    if(kind==='position')h.c.attitude!.joints=undefined;
    if(kind==='fault')h.c.attitude!.fault=true;
    if(kind==='rollLimit')h.c.attitude!.rollLimit=true;
    await h.step(kind==='stale'?600:100,false,kind!=='stale');const count=h.writes.length;
    expect(h.controller.recalling).toBe(false);expect(h.renew().accepted).toBe(false);await h.step(500,false,false);expect(h.writes).toHaveLength(count);h.controller.close();
  });
  it('stops an unreachable target when native joints make no progress',async()=>{
    const h=rig();h.start({pan:40,tilt:20});let failed=false;
    for(let n=0;n<45;n++){const r=h.renew();if(!r.accepted){failed=true;break}await h.step(100,false)}
    expect(failed).toBe(true);expect(h.controller.recalling).toBe(false);h.controller.close();
  });
  it('rejects a stale credential without changing the target and lets manual input replace recall',async()=>{
    const h=rig();h.start();const old=h.grant();h.renew();await h.step(100);
    expect(h.controller.renewRecall('operator',{...old,seq:20})).toMatchObject({accepted:false,reason:'credential'});
    expect(h.controller.recalling).toBe(true);const manual=h.controller.issue('operator','manual');expect(manual.accepted).toBe(true);expect(h.controller.recalling).toBe(false);expect(h.renew().accepted).toBe(false);h.controller.close();
  });
  it('requires a supported frame/mode and bounds target and speed before writing',()=>{
    const h=rig();h.c.attitude!.mode=0;expect(h.start().accepted).toBe(false);h.c.attitude!.mode=1;
    expect(h.start({pan:100,tilt:0}).accepted).toBe(false);expect(h.start({pan:0,tilt:0},61).accepted).toBe(false);expect(h.writes).toHaveLength(0);h.controller.close();
  });
});
