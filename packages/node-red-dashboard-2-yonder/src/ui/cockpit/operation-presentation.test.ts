// SPDX-License-Identifier: GPL-3.0-or-later
import {it,expect} from 'vitest';
import {operationPresentation,operationProtocol} from './operation-presentation.mjs';
const arm={id:'arm-one',vehicleGeneration:'one',action:{kind:'arm',armed:true},sentAt:1000,updatedAt:1100,state:'rejected',ack:{command:400,result:4,at:1095},message:'Autopilot refused command (4)'};
const snapshot={connected:true,identity:{generation:'one'},telemetry:{armed:false,fields:{armed:{valid:true}}},operations:[arm],statustext:[{at:1099,severity:2,text:'Arm: Waiting for RC'}]};
it('explains a failed arm using its reported reason and actual armed state',()=>{
 const view=operationPresentation(arm,snapshot);
 expect(view).toMatchObject({title:'Arming failed',detail:'Waiting for radio-control input. Aircraft remains disarmed.',tone:'caution'});
 expect(view.text).not.toMatch(/ACK|result 4|effect not confirmed/);
 expect(operationProtocol(arm)).toEqual({family:'COMMAND_ACK',code:4,command:400});
});
it('never borrows a prearm, stale, later-attempt or different-aircraft message',()=>{
 for(const change of [
  {statustext:[{at:999,severity:2,text:'Arm: Waiting for RC'}]},
  {statustext:[{at:1100,severity:2,text:'PreArm: Waiting for RC'}]},
  {statustext:[{at:4000,severity:2,text:'Arm: Waiting for RC'}]},
  {identity:{generation:'two'}},
  {operations:[arm,{action:{kind:'arm'},sentAt:1098}]}
 ])expect(operationPresentation(arm,{...snapshot,...change}).reason).toBeNull();
});
it('does not claim the aircraft remains disarmed when current data is absent or different',()=>{
 for(const change of [{connected:false},{telemetry:{armed:null}},{telemetry:{armed:false,fields:{armed:{valid:false}}}},{telemetry:{armed:true}}])
  expect(operationPresentation(arm,{...snapshot,...change}).text).not.toContain('remains disarmed');
});
it('distinguishes a mission storage refusal from a command execution failure',()=>{
 const upload={...arm,action:{kind:'mission-upload'},ack:{command:44,result:4}};
 expect(operationPresentation(upload).detail).toContain('storage capacity');
 expect(operationProtocol(upload)?.family).toBe('MISSION_ACK');
 expect(operationPresentation(arm).detail).toContain('No specific reason');
});
it.each([[1,'right now'],[2,'not allow'],[3,'not support'],[6,'cancelled'],[7,'format'],[8,'format'],[9,'reference'],[10,'control']])('explains command response %s without a raw code', (result,word)=>{
 expect(operationPresentation({...arm,ack:{command:400,result}}).detail).toContain(word);
});
it('keeps accepted, confirmed and unconfirmed results distinct',()=>{
 const op={...arm,action:{kind:'heading'},ack:{command:43002,result:0},message:''};
 expect(operationPresentation({...op,state:'accepted'}).title).toBe('Heading change accepted');
 expect(operationPresentation({...op,state:'observed'}).title).toBe('Heading change confirmed');
 expect(operationPresentation({...op,state:'unknown'}).text).toContain('outcome unknown');
 expect(operationPresentation({...op,state:'failed'}).title).toBe('Heading change failed');
});
