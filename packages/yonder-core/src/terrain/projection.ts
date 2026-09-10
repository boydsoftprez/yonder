// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-08/09: bounded terrain data and calibrated advisory presentation.
import type { CameraCalibration, RegistrationContext, RegistrationValidity } from './types.js';
type Point = [number,number,number];
function geometryValid(c:CameraCalibration):boolean {
  if(!c || typeof c!=='object' || Array.isArray(c) || typeof c.validated!=='boolean' || typeof c.timingVerified!=='boolean' || typeof c.mirrorX!=='boolean')return false;
  if(![c.id,c.cameraId,c.profileId].every(x=>typeof x==='string' && x.length>0 && x.length<=2048))return false;
  if(!Array.isArray(c.bodyToCamera) || c.bodyToCamera.length!==9 || !Array.isArray(c.cameraOffsetBodyM) || c.cameraOffsetBodyM.length!==3 || !c.distortion || typeof c.distortion!=='object' || Array.isArray(c.distortion))return false;
  if(![c.width,c.height,c.fx,c.fy,c.cx,c.cy,c.residualPx,c.maxResidualPx,...Array.from(c.bodyToCamera),...Array.from(c.cameraOffsetBodyM),c.distortion.k1,c.distortion.k2,c.distortion.p1,c.distortion.p2,c.distortion.k3].every(Number.isFinite))return false;
  if(!Number.isInteger(c.width) || !Number.isInteger(c.height) || c.width>32768 || c.height>32768)return false;
  if(c.width<=0 || c.height<=0 || c.fx<=0 || c.fy<=0 || c.residualPx<0 || c.maxResidualPx<=0 || c.residualPx>c.maxResidualPx || c.distortion.model!=='brown-conrady' || ![0,90,180,270].includes(c.rotation))return false;
  const r=c.bodyToCamera;
  for(let row=0;row<3;row++) for(let col=0;col<3;col++) {
    let dot=0;for(let k=0;k<3;k++)dot+=r[row*3+k]*r[col*3+k];
    if(Math.abs(dot-(row===col?1:0))>1e-5)return false;
  }
  const determinant=r[0]*(r[4]*r[8]-r[5]*r[7])-r[1]*(r[3]*r[8]-r[5]*r[6])+r[2]*(r[3]*r[7]-r[4]*r[6]);
  return Math.abs(determinant-1)<1e-5;
}
/** Validate imported JSON without treating truthy strings or incomplete arrays as calibration. */
export function validateCameraCalibration(input:unknown):input is CameraCalibration {
  const c=input as CameraCalibration;
  return geometryValid(c) && c.validated===true && c.timingVerified===true && Number.isFinite(c.maxTimeErrorMs) && c.maxTimeErrorMs>0;
}
export function registrationValidity(calibration:CameraCalibration|null, context:RegistrationContext):RegistrationValidity {
  const no=(reason:string)=>({ready:false,reason});
  const c=calibration;
  if(!c || c.validated!==true || !geometryValid(c))return no('Camera calibration unavailable');
  if(!context || typeof context!=='object' || Array.isArray(context))return no('Registration context unavailable');
  if(c.cameraId!==context.cameraId || c.profileId!==context.profileId)return no('Camera calibration profile mismatch');
  if(context.terrainCovered!==true)return no('Terrain coverage unavailable');
  if(!['NAVD88','EGM96','WGS84_ELLIPSOID'].includes(context.terrainDatum) || context.terrainDatum!==context.aircraftDatum)return no('Height references differ or are unknown');
  if(context.verticalTransformVerified!==true)return no('Height reference unverified');
  if(c.timingVerified!==true || context.frameCaptureMs===null || context.poseTimeMs===null || context.timeErrorMs===null || ![context.nowMs,context.frameCaptureMs,context.poseTimeMs,context.timeErrorMs,c.maxTimeErrorMs,context.frameMaxAgeMs,context.telemetryMaxAgeMs].every(Number.isFinite))return no('Capture-time mapping unavailable');
  if(context.timeErrorMs<0 || c.maxTimeErrorMs<=0 || context.timeErrorMs>c.maxTimeErrorMs || Math.abs(context.poseTimeMs-context.frameCaptureMs)>c.maxTimeErrorMs)return no('Capture-time uncertainty too large');
  if(context.frameMaxAgeMs<=0 || context.nowMs-context.frameCaptureMs<0 || context.nowMs-context.frameCaptureMs>context.frameMaxAgeMs)return no('Video frame stale');
  if(context.telemetryMaxAgeMs<=0 || context.nowMs-context.poseTimeMs<0 || context.nowMs-context.poseTimeMs>context.telemetryMaxAgeMs)return no('Telemetry stale');
  if(context.poseBracketed!==true)return no('Frame-time pose unavailable');
  return {ready:true,reason:'Ready'};
}
/** Input: body forward/right/down metres relative to position sensor; output: optical right/down/forward. */
export function bodyPointToCamera(point:Point, calibration:CameraCalibration):Point {
  const d=point.map((v,i)=>v-calibration.cameraOffsetBodyM[i]), r=calibration.bodyToCamera;
  return [r[0]*d[0]+r[1]*d[1]+r[2]*d[2],r[3]*d[0]+r[4]*d[1]+r[5]*d[2],r[6]*d[0]+r[7]*d[1]+r[8]*d[2]];
}
/** Optical projection only; callers must enforce registrationValidity before displaying scene annotations. */
export function projectCameraPoint(point:Point, c:CameraCalibration, viewport:{x:number;y:number;width:number;height:number}):{x:number;y:number;depthM:number}|null {
  if(!geometryValid(c) || !Array.isArray(point) || point.length!==3 || !viewport || typeof viewport!=='object' || ![...point,viewport.x,viewport.y,viewport.width,viewport.height].every(Number.isFinite) || point[2]<=0 || viewport.width<=0 || viewport.height<=0)return null;
  const x=point[0]/point[2],y=point[1]/point[2],r2=x*x+y*y,d=c.distortion;
  const radial=1+d.k1*r2+d.k2*r2*r2+d.k3*r2*r2*r2;
  let u=c.fx*(x*radial+2*d.p1*x*y+d.p2*(r2+2*x*x))+c.cx;
  let v=c.fy*(y*radial+d.p1*(r2+2*y*y)+2*d.p2*x*y)+c.cy;
  if(!Number.isFinite(u) || !Number.isFinite(v) || u<0 || v<0 || u>c.width || v>c.height)return null;
  if(c.mirrorX)u=c.width-u;
  const w=c.width,h=c.height;
  let imageWidth=w,imageHeight=h;
  if(c.rotation===90){[u,v]=[h-v,u];[imageWidth,imageHeight]=[h,w];}
  else if(c.rotation===180)[u,v]=[w-u,h-v];
  else if(c.rotation===270){[u,v]=[v,w-u];[imageWidth,imageHeight]=[h,w];}
  const scale=Math.min(viewport.width/imageWidth,viewport.height/imageHeight);
  return {x:viewport.x+(viewport.width-imageWidth*scale)/2+u*scale,y:viewport.y+(viewport.height-imageHeight*scale)/2+v*scale,depthM:point[2]};
}
