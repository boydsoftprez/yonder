// SPDX-License-Identifier: GPL-3.0-or-later
// Display-only translation; never changes an operation or retries a command.
// MAV_RESULT and MAV_MISSION_RESULT are separate namespaces (common.xml).
const commandResults={
  1:'The controller cannot do this right now.',
  2:'The controller did not allow this request or its settings.',
  3:'The controller does not support this command.',
  4:'The controller reported a failure. No specific reason is available.',
  6:'The controller cancelled the command.',
  7:'The controller requires a different command format.',
  8:'The controller requires a different command format.',
  9:'The controller does not support this coordinate or altitude reference.',
  10:'This connection does not have control of the aircraft.'
};
const missionResults={
  1:'The controller could not accept the mission.',2:'The mission uses an unsupported coordinate or altitude reference.',
  3:'The mission contains an unsupported command.',4:'The mission exceeds the controller’s storage capacity.',
  5:'The mission contains an invalid parameter.',6:'Mission parameter 1 is invalid.',7:'Mission parameter 2 is invalid.',
  8:'Mission parameter 3 is invalid.',9:'Mission parameter 4 is invalid.',10:'A mission latitude or X value is invalid.',
  11:'A mission longitude or Y value is invalid.',12:'A mission altitude or Z value is invalid.',
  13:'Mission items arrived out of sequence.',14:'The controller did not allow this mission transfer.',15:'The mission transfer was cancelled.'
};
const names={'mode':'Mode change','goto':'Direct-To','heading':'Heading change','altitude':'Altitude change','speed':'Airspeed change',
 'loiter':'Loiter request','set-home':'Home change','set-current':'Waypoint selection','continue-auto':'Mission continuation',
 'mission-start':'Mission start','mission-upload':'Mission upload','mission-clear':'Mission removal','mission-download':'Mission read',
 'stream-setup':'Telemetry setup','immediate':'Aircraft command'};
export function operationProtocol(operation){
 const ack=operation?.ack;
 return ack?{family:operation.action?.kind==='mission-upload'&&ack.command===44?'MISSION_ACK':'COMMAND_ACK',code:ack.result,command:ack.command}:null;
}
function armReason(operation,snapshot){
 if(operation.action?.kind!=='arm'||operation.action.armed!==true||!Number.isFinite(operation.sentAt))return null;
 if(operation.vehicleGeneration&&operation.vehicleGeneration!==snapshot.identity?.generation)return null;
 const end=operation.ack?.at??operation.updatedAt;
 if(!Number.isFinite(end))return null;
 const next=(snapshot.operations||[]).find(o=>o!==operation&&o.action?.kind==='arm'&&o.sentAt>operation.sentAt);
 // Only an explicit Arm failure during this attempt; old/periodic PreArm
 // messages are not attributed to a particular failed command.
 const report=(snapshot.statustext||[]).filter(m=>m.at>=operation.sentAt&&m.at<=end+2000&&(!next||m.at<next.sentAt)
   &&m.severity<=4&&/^Arm:\s*\S/i.test(m.text||'')).at(-1);
 if(!report)return null;
 const text=report.text.replace(/^Arm:\s*/i,'').trim();
 return /^Waiting for RC$/i.test(text)?'Waiting for radio-control input.':text;
}
function usefulMessage(operation){
 const text=operation.message||'';
 return /ACK|Autopilot refused (?:command|mission) \(\d+\)|^Queued$/i.test(text)?'':text;
}
export function operationPresentation(operation,snapshot={}){
 if(!operation)return {title:'',detail:'',text:'',tone:'neutral',reason:null};
 const kind=operation.action?.kind, name=kind==='arm'?(operation.action.armed?'Arming':'Disarming'):(names[kind]||'Aircraft request');
 const state=operation.state, protocol=operationProtocol(operation), result=protocol?.code;
 const mission=protocol?.family==='MISSION_ACK';
 const terminal=['rejected','failed','unknown'].includes(state);
 let title=name,detail='',reason=null,tone=terminal?'caution':'neutral';
 if(state==='observed'){
   title=`${name} confirmed`;detail=usefulMessage(operation)||'Verified from the aircraft response.';tone='observed';
 }else if(state==='unknown'){
   title=`${name}: outcome unknown`;detail=usefulMessage(operation)||'No confirmation received. Check aircraft state before trying again.';
 }else if(terminal){
   title=`${name} ${state==='failed'||(!mission&&result===4)?'failed':'declined'}`;
   reason=armReason(operation,snapshot);
   detail=reason||(mission?missionResults[result]:commandResults[result])||usefulMessage(operation)||'No specific reason is available. Open Aircraft notices for details.';
   if(kind==='arm'&&snapshot.connected===true&&snapshot.telemetry?.fields?.armed?.valid!==false&&typeof snapshot.telemetry?.armed==='boolean'){
     detail+=snapshot.telemetry.armed?' Aircraft currently reports armed.':' Aircraft remains disarmed.';
   }
 }else if(state==='accepted'){
   title=`${name} accepted`;detail=usefulMessage(operation)||'Waiting for confirmation from the aircraft.';
 }else if(state==='in-progress'){
   title=`${name} in progress`;detail=usefulMessage(operation)||'The controller is still working on the request.';
 }else{
   title=`${name} ${state==='sent'?'sent':'queued'}`;detail='Waiting for the aircraft response.';
 }
 return {title,detail,text:detail?`${title} — ${detail}`:title,tone,reason};
}
