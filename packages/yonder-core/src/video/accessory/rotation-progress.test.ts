// SPDX-License-Identifier: GPL-3.0-or-later
import { expect, it } from 'vitest';
import { RotationProgress } from './rotation-progress.js';
import type { GimbalAttitude } from './guard.js';

const attitude = (at: number): GimbalAttitude => ({
  pitch: 0, roll: 0, yaw: 0, mode: 1, at,
  pitchLimit: false, yawLimit: false, fault: false,
  joints: { pan: 0, tilt: 0, roll: 0 }, quaternion: [1,0,0,0],
});

it('watches isolated roll progress with the same bounded no-rotation window',()=>{
  const progress=new RotationProgress(),epoch={};let notice:string|null=null;
  for(let at=1000;at<=2200;at+=100){
    progress.completed(epoch,{pan:0,tilt:0,roll:1},at,at-100,0);
    notice=progress.observe(epoch,attitude(at),at);
    if(notice)break;
  }
  expect(notice).toContain('No camera rotation observed');
});

it('resets the watchdog when a command mixes axes',()=>{
  const progress=new RotationProgress(),epoch={};
  for(let at=1000;at<=1500;at+=100){
    progress.completed(epoch,{pan:0,tilt:0,roll:1},at,at-100,0);
    expect(progress.observe(epoch,attitude(at),at)).toBeNull();
  }
  progress.completed(epoch,{pan:1,tilt:0,roll:1},1600,1500,0);
  expect(progress.observe(epoch,attitude(2200),2200)).toBeNull();
});
