// SPDX-License-Identifier: GPL-3.0-or-later
import {expect,it} from 'vitest';
import {videoAction,previewFailure} from './camera-workflow.js';
it.each([['stopped','start','Start video'],['running','stop','Stop video'],['starting',null,'Starting video…'],['failed','start','Retry video'],['unknown',null,'Checking camera…']])('names the reachable action in %s', (state,action,label)=>{
  expect(videoAction(state)).toMatchObject({action,label});
});
it('keeps a start refusal visible and never offers an unavailable start',()=>{
  expect(videoAction('stopped',false,'Connect the camera')).toEqual({action:null,label:'Start video',message:'Connect the camera'});
});
it('does not turn a missing preview into a false claim that its camera was stopped',()=>{
  expect(previewFailure(404)).toMatchObject({retry:true,signIn:false});
  expect(previewFailure(404).message).not.toMatch(/rail|stopped|start it/i);
  expect(previewFailure(401)).toMatchObject({retry:false,signIn:true});
  expect(previewFailure(403)).toMatchObject({retry:false,signIn:false});
});
