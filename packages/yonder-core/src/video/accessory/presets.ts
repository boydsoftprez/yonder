// SPDX-License-Identifier: GPL-3.0-or-later
import { z } from 'zod';
import { GimbalPreset, type Config } from '../../schema/config.js';
const slot = z.number().int().min(1).max(6);
const name = GimbalPreset.shape.name;
const revision = z.number().int().nonnegative();
export const PresetRequest = z.discriminatedUnion('op', [
  z.object({op:z.literal('save'),slot,name,revision}).strict(),
  z.object({op:z.literal('rename'),slot,name,revision}).strict(),
  z.object({op:z.literal('delete'),slot,revision}).strict(),
]);
export function validPresetRequest(value:unknown): boolean { return PresetRequest.safeParse(value).success; }
export function updatePresets(config:Config,cameraId:string,input:unknown,position?:{pan:number;tilt:number},now=Date.now()):Config {
  const request=PresetRequest.parse(input);const next=structuredClone(config);
  const camera=next.cameras.find(c=>c.id===cameraId);
  if(!camera || camera.source!=='accessory')throw new Error('This camera has no gimbal presets');
  if(request.revision!==(camera.gimbal_presets?.revision??0))throw new Error('Presets changed in another session. Try again with the current list.');
  const rows=[...(camera.gimbal_presets?.slots??[])];const i=rows.findIndex(p=>p.slot===request.slot);
  if(request.op==='delete') {if(i>=0)rows.splice(i,1);}
  else if(request.op==='rename') {if(i<0)throw new Error('That preset is empty');rows[i]={...rows[i],name:request.name};}
  else {
    if(!position)throw new Error('Fresh gimbal position is required');
    const value=GimbalPreset.parse({slot:request.slot,name:request.name,frame:'hg211-joints-v1',mode:1,pan:position.pan,tilt:position.tilt,savedAt:now});
    if(i<0)rows.push(value);else rows[i]=value;
  }
  camera.gimbal_presets={revision:request.revision+1,slots:rows.sort((a,b)=>a.slot-b.slot)};return next;
}
