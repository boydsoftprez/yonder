// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {Camera} from '../schema/config.js';
import {cockpitCameras} from './camera.js';
it('selects an identified ELP or the explicit configured camera without inventing calibration',()=>{
 const cameras=[Camera.parse({id:'nose',source:'usb',name:'ELP forward',device:'usb-1'}),Camera.parse({id:'tail',source:'usb',name:'Tail',device:'usb-2'})];
 const state=cockpitCameras(cameras,{found:[],rejected:[]},null,()=>null);
 expect(state.camera?.id).toBe('nose');expect(state.camera?.detected).toBe(false);
 expect(state.camera?.calibration).toBeNull();expect(state.camera?.frameCaptureMs).toBeNull();expect(state.camera?.registration.ready).toBe(false);
 expect(cockpitCameras(cameras,null,'tail',()=>null).camera?.path).toBe('tail-preview');
 expect(cockpitCameras(cameras,null,'missing',()=>null).camera).toBeNull();
 const oldProfile=state.camera!.profileId;cameras[0]!.controls.horizontalFlip=true;
 expect(cockpitCameras(cameras,null,'nose',()=>null).camera!.profileId).not.toBe(oldProfile);
});
