// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { decodeGimbalAttitude, GimbalController } from './gimbal.js';
import { decodeDuml, encodeDuml } from './duml.js';
import type { GuardContext } from './guard.js';
import type { IntentClock, IntentGrant } from './intent.js';
import type { AccessoryCommandOptions } from './aoa.js';
import { readFileSync } from 'node:fs';
import { guard } from './guard.js';

const quaternion = (degrees: number): [number,number,number,number] => [Math.cos(degrees * Math.PI / 360), 0, 0, Math.sin(degrees * Math.PI / 360)];
const settle = async () => { for (let i=0;i<8;i++) await Promise.resolve(); };
class Clock implements IntentClock {
  time=1000; serial=0; timers=new Map<number,{at:number;fn:()=>void}>();
  now=()=>this.time;
  setTimer=(ms:number,fn:()=>void)=>{ const id=++this.serial; this.timers.set(id,{at:this.time+ms,fn}); return id; };
  clearTimer=(id:unknown)=>{ this.timers.delete(id as number); };
  advance(ms:number) { this.time+=ms; }
  flush() { for (const [id,t] of [...this.timers]) if (t.at<=this.time) { this.timers.delete(id);t.fn(); } }
}
function harness(blockWrite: number | false = false) {
  const clock=new Clock();
  const context: GuardContext={ now:1000,attitudeMaxAgeMs:500,
    attitude:{yaw:179,pitch:89.7,roll:0,mode:2,at:1000,yawLimit:false,pitchLimit:false,fault:false},
    mount:null,envelopes:[],signs:{pan:null,tilt:null},limitDirections:{},actions:[],intentAllowanceMs:500,deviceStopAllowanceMs:800 };
  const writes:{at:number;options:AccessoryCommandOptions}[]=[];
  let release:()=>void=()=>{};
  const notices:(string|null)[]=[];
  const controller=new GimbalController({clock,context:()=>context,onMotionNotice:notice=>notices.push(notice),write:async(_command,options)=>{
    if (!options.admission!()) throw new Error('refused before endpoint');
    writes.push({at:clock.time,options});
    if(writes.length===blockWrite) await new Promise<void>(done=>{release=done;});
  }});
  let grant:IntentGrant; let seq=0;
  function issue(name='physical') { const r=controller.issue('owner',name);if(!r.accepted)throw new Error(r.reason);grant=r.grant;seq=0; }
  function renew(pan=5,tilt=0) { const r=controller.admit('owner',{...grant,seq:++seq,rate:{pan,tilt}});if(r.accepted&&r.next)grant=r.next;return r; }
  async function step(q:number[]|null=quaternion(0),ms=100) {
    clock.advance(ms); context.attitude={...context.attitude!,at:clock.time,quaternion:q as [number,number,number,number]|null}; controller.refresh();clock.flush();await settle();
  }
  async function run(duration:number,pan=5,tilt=0,rotation:(elapsed:number)=>number[]|null=()=>quaternion(0)) {
    for(let elapsed=100;elapsed<=duration;elapsed+=100) { await step(rotation(elapsed)); if(!renew(pan,tilt).accepted) break;await settle(); }
  }
  return {clock,context,controller,writes,notices,issue,renew,step,run,release:()=>release()};
}

describe('validated world quaternion feedback',()=>{
  const payload=(q:number[])=>{const p=Buffer.alloc(40);p[6]=0x80;p[10]=0xa0;q.forEach((v,i)=>p.writeFloatLE(v,24+i*4));return p;};
  const read=(p:Buffer)=>decodeGimbalAttitude(decodeDuml(encodeDuml({sender:4,receiver:2,commandSet:4,commandId:5,payload:p}))!,{now:()=>1000});
  it('decodes the retained measured quaternion as world rotation, separate from Euler telemetry',()=>{
    const raw=decodeDuml(Buffer.from('553a04700402b03b0004050200000074fe82001af9a00104e91b0083f0000064fc00000cd3703f4c254a3a78b10b3b76a8adbe0665a53f00bfbf','hex'))!;
    const a=decodeGimbalAttitude(raw,{now:()=>1})!;
    expect(a.quaternion).toHaveLength(4);expect(a.quaternion![0]).toBeCloseTo(0.9407203,6);
    expect(Math.hypot(...a.quaternion!)).toBeCloseTo(1,10);expect(a.yaw).toBe(-39.6);
  });
  it.each([[0,0,0,0],[2,0,0,0],[NaN,0,0,1],[1,Infinity,0,0]].map(q=>({q})))('does not invent valid rotation from $q',({q})=>{
    expect(read(payload(q))?.quaternion).toBeNull();
  });
  it('leaves quaternion unknown for a short but otherwise valid status',()=>{
    expect(read(payload([1,0,0,0]).subarray(0,11))?.quaternion).toBeNull();
  });
  const measured=JSON.parse(readFileSync(new URL('./fixtures/pocket2-orientation.json',import.meta.url),'utf8')).cases;
  it.each(measured)('preserves recorded $name rotation while admitting native rates independently of world attitude',entry=>{
    const h=harness();
    const decoded=entry.samples.map((sample:{payloadHex:string;worldEuler:{pitch:number;roll:number;yaw:number}})=>{
      const attitude=read(Buffer.from(sample.payloadHex,'hex'))!;
      expect(attitude).toMatchObject({...sample.worldEuler,fault:false,pitchLimit:false,yawLimit:false});
      h.context.attitude=attitude;
      for(const [pan,tilt] of [[5,0],[-5,0],[0,5],[0,-5]]) expect(guard({kind:'rate',pan,tilt},h.context)).toEqual({allowed:true});
      return attitude;
    });
    const q0=decoded[0].quaternion!,q1=decoded[1].quaternion!;
    const dot=Math.abs(q0.reduce((sum:number,v:number,i:number)=>sum+v*q1[i],0));
    expect(2*Math.acos(Math.min(1,dot))*180/Math.PI).toBeCloseTo(entry.rotationDegrees,4);
    h.controller.close();
  });
});

describe('current-gesture native rotation watchdog',()=>{
  it('cancels stationary completed single-axis repeats across credential renewals without disconnecting USB',async()=>{
    const h=harness();h.issue();expect(h.renew().accepted).toBe(true);await settle();await h.run(3000);
    expect(h.controller.motionNotice).toContain('No camera rotation observed');
    const count=h.writes.length;await h.step();expect(h.writes).toHaveLength(count);
    h.issue('new-physical');expect(h.controller.motionNotice).toBeNull();expect(h.renew(-5).accepted).toBe(true);
    await h.step();expect(h.writes.length).toBeGreaterThan(count);h.controller.close();
  });
  it('does not count q/-q sign changes or stationary jitter as rotation',async()=>{
    const h=harness();h.issue();h.renew();await settle();await h.run(3000,5,0,t=>quaternion(t%200?0.001:0).map(v=>t%200?-v:v));
    expect(h.controller.motionNotice).toContain('No camera rotation observed');h.controller.close();
  });
  it('permits measured continuous world rotation without claiming joint motion',async()=>{
    const h=harness();h.issue();h.renew();await settle();await h.run(4000,5,0,t=>quaternion(179+t*.005));
    expect(h.controller.motionNotice).toBeNull();expect(h.writes.length).toBeGreaterThan(30);h.controller.close();
  });
  it('extends the observation window for a low quantized rate instead of rejecting slow real rotation',async()=>{
    const h=harness();h.issue();h.renew(.1);await settle();await h.run(6500,.1,0,t=>quaternion(t*.0001));
    expect(h.controller.motionNotice).toBeNull();h.controller.close();
    const stopped=harness();stopped.issue();stopped.renew(.1);await settle();await stopped.run(3000,.1);
    expect(stopped.controller.motionNotice).toBeNull();await stopped.run(4000,.1);
    expect(stopped.controller.motionNotice).toContain('No camera rotation observed');stopped.controller.close();
  });
  it('does not start an observation window from a queued or canceled write',async()=>{
    const h=harness(1);h.issue();h.renew();await settle();await h.run(2500);
    expect(h.writes).toHaveLength(1);expect(h.controller.motionNotice).toBeNull();
    h.issue('next');h.renew();h.release();await settle();await h.step();
    expect(h.controller.motionNotice).toBeNull();expect(h.writes.length).toBeGreaterThan(1);h.controller.close();
  });
  it('does not count a long gap behind a blocked second write as sustained commanded exposure',async()=>{
    const h=harness(2);h.issue();h.renew();await settle();await h.run(3000);
    expect(h.writes).toHaveLength(2);expect(h.controller.motionNotice).toBeNull();
    h.controller.close();h.release();await settle();
  });
  it('an old completion after source reset cannot seed the new motion epoch',async()=>{
    const h=harness(1);h.issue();h.renew();await settle();h.controller.reset();h.issue('new');h.renew(-5);
    h.release();await settle();await h.step();expect(h.controller.motionNotice).toBeNull();
    await h.run(1000,-5);expect(h.controller.motionNotice).toBeNull();h.controller.close();
  });
  it('does not infer a stalled individual joint from diagonal camera rotation',async()=>{
    const h=harness();h.issue();h.renew(5,5);await settle();await h.run(3000,5,5);
    expect(h.controller.motionNotice).toBeNull();expect(h.writes.length).toBeGreaterThan(20);h.controller.close();
  });
  it('a change of observed mode cancels the current gesture before another repeat',async()=>{
    const h=harness();h.issue();h.renew();await settle();h.context.attitude!.mode=1;await h.step();
    expect(h.writes).toHaveLength(1);expect(h.renew().accepted).toBe(false);h.controller.close();
  });
  it('missing quaternion observations cancel a sustained completed command instead of counting as movement',async()=>{
    const h=harness();h.issue();h.renew();await settle();await h.run(2500,5,0,()=>null);
    expect(h.controller.motionNotice).toContain('rotation feedback');h.controller.close();
  });
  it('sub-quantum input retires rather than repeatedly sending zero wire rates',async()=>{
    const h=harness();h.issue();expect(h.renew(.09,.09)).toMatchObject({accepted:true,next:null});expect(h.writes).toHaveLength(0);h.controller.close();
  });
});
