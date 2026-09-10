// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {Camera,ConfigSchema,DEFAULT_CONFIG} from '../../schema/config.js';
import {updatePresets,validPresetRequest} from './presets.js';
const config=()=>({...structuredClone(DEFAULT_CONFIG),cameras:[Camera.parse({id:'cam1',name:'Pocket',source:'accessory',device:'pocket2:test'})]});
it('saves six native positions without wrapping pan or clipping tilt, and keeps the input immutable',()=>{
 const original=config();let current=original;
 for(let slot=1;slot<=6;slot++)current=updatePresets(current,'cam1',{op:'save',slot,name:`View ${slot}`,revision:slot-1},{pan:-220,tilt:-100},1000);
 expect(original.cameras[0].gimbal_presets).toBeUndefined();expect(current.cameras[0].gimbal_presets?.slots).toHaveLength(6);
 expect(current.cameras[0].gimbal_presets?.slots[0]).toMatchObject({pan:-220,tilt:-100,frame:'hg211-joints-v1',mode:1});expect(ConfigSchema.safeParse(current).success).toBe(true);
});
it('renames without moving the saved position and uses revisions to prevent stale overwrites',()=>{
 const saved=updatePresets(config(),'cam1',{op:'save',slot:1,name:'First',revision:0},{pan:20,tilt:30},1000);
 const renamed=updatePresets(saved,'cam1',{op:'rename',slot:1,name:'Front',revision:1});
 expect(renamed.cameras[0].gimbal_presets?.slots[0]).toMatchObject({pan:20,tilt:30,name:'Front'});
 expect(()=>updatePresets(renamed,'cam1',{op:'delete',slot:1,revision:1})).toThrow('changed');
 expect(updatePresets(renamed,'cam1',{op:'delete',slot:1,revision:2}).cameras[0].gimbal_presets).toEqual({revision:3,slots:[]});
});
it('refuses client-supplied positions, duplicate slots and invalid names',()=>{
 expect(validPresetRequest({op:'save',slot:1,name:'Front',revision:0,pan:0,tilt:0})).toBe(false);
 expect(validPresetRequest({op:'save',slot:7,name:'Front',revision:0})).toBe(false);
 expect(validPresetRequest({op:'save',slot:1,name:'\u0000',revision:0})).toBe(false);
 const c=updatePresets(config(),'cam1',{op:'save',slot:1,name:'Front',revision:0},{pan:0,tilt:0},1000);c.cameras[0].gimbal_presets!.slots.push({...c.cameras[0].gimbal_presets!.slots[0]});
 expect(ConfigSchema.safeParse(c).success).toBe(false);
});
