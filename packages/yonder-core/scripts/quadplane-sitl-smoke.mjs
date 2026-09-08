// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-18/20, R-CMD-04/09, R-TEL-01/06: opt-in real-firmware smoke in a fresh, disposable simulator.
// Usage: node packages/yonder-core/scripts/quadplane-sitl-smoke.mjs --firmware-dir DIR --output FILE
// DIR contains the checksummed official ArduPlane 4.7.1 bin/arduplane and quadplane.parm.
// Build yonder-core first. Never attaches to the existing research preview or to hardware.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {createConnection,createServer} from 'node:net';
import {MavLinkPacketSplitter, MavLinkProtocolV2, common} from 'node-mavlink';
import {decodeDatagram} from '../dist/mav/protocol.js';
import {VehicleService} from '../dist/mav/vehicle.js';
import {systemClock} from '../dist/apply/types.js';
import demo from '../../node-red-dashboard-2-yonder/src/ui/cockpit/data/cove-vtol-demo.mjs';
import {navigationView,cdiDeflection} from '../../node-red-dashboard-2-yonder/src/ui/cockpit/navigation-view.mjs';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){assert(['--firmware-dir','--output'].includes(args[i])&&args[i+1],'Expected --firmware-dir DIR and optional --output FILE');options[args[i]]=args[i+1];}
assert(options['--firmware-dir'],'A verified firmware directory is required');
const firmware=resolve(options['--firmware-dir']);
for(const [file,hash] of [['bin/arduplane','1b6f6810016531f81a2ab240c1353aa7310334079b4c0954ecac8d17cf1adabe'],['quadplane.parm','3b736735829637583fcac4349d1dabc925dddb29dacf3cd023ddbf30587c24e9']])assert.equal(createHash('sha256').update(readFileSync(join(firmware,file))).digest('hex'),hash,`Unverified simulator input ${file}`);
const port=5778,name=`yonder-quadplane-smoke-${randomUUID().slice(0,8)}`,runtime=mkdtempSync(join(tmpdir(),'yonder-quadplane-sitl-'));
const evidence={schema:1,sourceCommit:'dbe792162d06cab66c3475fd5556bf7a120f119e',firmware:'Official ArduPlane 4.7.1',model:'quadplane',evidence:'Independent disposable SITL; no physical aircraft',startedAt:new Date().toISOString(),stages:[],outcome:'running'};
let started=false,socket,service,firstBytes;
const commands=[], extendedStates=[], flightSamples=[], navigationSamples=[];let lastSample=0;
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate,description,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const result=predicate();if(result)return result;await wait(100);}throw new Error(`Timed out: ${description}`);}
async function connect(){for(let i=0;i<30;i++){try{return await new Promise((resolve,reject)=>{const s=createConnection({host:'127.0.0.1',port});const timeout=setTimeout(()=>{s.destroy();reject(new Error('No simulator data'));},2000);s.once('data',bytes=>{clearTimeout(timeout);firstBytes=bytes;resolve(s);});s.once('close',()=>{clearTimeout(timeout);reject(new Error('Simulator not ready'));});s.once('error',reject);});}catch{await wait(500);}}throw new Error('Disposable simulator never sent data on its private TCP connection');}
async function operation(action,expect='observed'){
 const snapshot=service.snapshot(),id=randomUUID();
 const admitted=service.submit({id,sessionId:'local-sitl-smoke',vehicleGeneration:snapshot.identity.generation,expectedMissionRevision:snapshot.mission.revision??undefined,confirmed:true,action});
 assert.equal(admitted.accepted,true,admitted.message);
 const completed=await until(()=>{const s=service.snapshot(),op=s.operations.find(o=>o.id===id);return !s.busy&&op?op:null;},action.kind,70000);
 evidence.stages.push({action:action.kind,operation:completed,telemetry:service.snapshot().telemetry,mission:service.snapshot().mission});
 console.log(`${action.kind}: ${completed.state} / ${completed.message}`);
 assert.equal(completed.state,expect,completed.message);
 return completed;
}
try{
 const probe=createServer();await new Promise((ok,no)=>{probe.once('error',no);probe.listen(port,'127.0.0.1',ok);});await new Promise(r=>probe.close(r));
 docker('run','-d','--name',name,'--platform','linux/amd64','--label','yonder.test=quadplane-mission-smoke','-p',`127.0.0.1:${port}:5760`,
  '--mount',`type=bind,src=${firmware},dst=/opt/sitl,readonly`,'--mount',`type=bind,src=${runtime},dst=/data`,'-w','/data',
  'ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517',
  '/opt/sitl/bin/arduplane','--model','quadplane','--home','35.9607874,-83.3668696,315.641734,90','--defaults','/opt/sitl/quadplane.parm','--speedup','1','--sysid','1');
 started=true;socket=await connect();socket.on('error',()=>{});
 service=new VehicleService({clock:systemClock,send:bytes=>new Promise((ok,no)=>{for(const frame of decodeDatagram(bytes))if(frame.id===75||frame.id===76)commands.push({at:Date.now(),command:frame.data.command,bytes:Buffer.from(bytes).toString('base64')});socket.write(bytes,e=>e?no(e):ok());})});
 const splitter=new MavLinkPacketSplitter();splitter.on('data',({buffer})=>{
  service.receive(buffer);
  for(const f of decodeDatagram(buffer)) if(f.id===245) extendedStates.push({at:Date.now(),vtolState:f.data.vtolState,landedState:f.data.landedState});
  const now=Date.now();if(now-lastSample>500){lastSample=now;const s=service.snapshot(),t=s.telemetry;flightSamples.push({at:now,mode:t.mode,armed:t.armed,seq:s.mission.currentSeq,lat:t.latitude,lon:t.longitude,altitudeM:t.relativeAltitudeM,groundspeedKt:t.groundspeedKt,airspeedKt:t.airspeedKt,verticalSpeedFpm:t.verticalSpeedFpm});
    if(t.mode==='AUTO'){const g=navigationView(s);navigationSamples.push({at:now,currentSeq:s.mission.currentSeq,view:g,deflection:cdiDeflection(g,250),nav:t.navController});}
  }
 });splitter.on('error',()=>{});socket.on('data',bytes=>splitter.write(bytes));
 if(firstBytes)splitter.write(firstBytes);
 await until(()=>service.snapshot().connected,'ArduPlane heartbeat');assert.equal(service.snapshot().identity.autopilot,3);assert.equal(service.snapshot().identity.vehicleType,1);
 await operation({kind:'stream-setup'},'accepted');
 // Test-only telemetry observation: explicitly request EXTENDED_SYS_STATE at 2 Hz.
 const interval=Object.assign(new common.CommandLong(),{targetSystem:1,targetComponent:1,command:511,_param1:245,_param2:500000});
 socket.write(new MavLinkProtocolV2(253,191).serialize(interval,0));
 await until(()=>extendedStates.length>0,'test receives EXTENDED_SYS_STATE before flight',10000);
 await until(()=>service.snapshot().telemetry.ready&&service.snapshot().telemetry.fixType>=3,'fresh flight telemetry and GPS fix',40000);
 assert(Math.abs(service.snapshot().telemetry.latitude-35.9607874)<0.01,'Simulator home must match this smoke test');
 await operation({kind:'mission-download'});
 const home=service.snapshot().telemetry.homePosition??{lat:35.9607874,lon:-83.3668696,alt:315.641734};
 const items=[{seq:0,command:16,frame:0,params:[0,0,0,0],x:home.lat,y:home.lon,z:home.alt,current:false,autocontinue:true},
  ...demo.items.map(i=>({seq:i.seq,command:i.command,frame:i.frame,params:i.params,x:i.lat,y:i.lon,z:i.alt,current:i.current,autocontinue:i.autocontinue}))];
 assert.equal(items[1].command,84);assert.equal(items[1].z,54.864);
 await operation({kind:'mission-upload',items});
 assert.equal(service.snapshot().mission.items[1].command,84);
 // ArduPlane stores mission altitude in whole centimetres.
 assert(Math.abs(service.snapshot().mission.items[1].z-54.864)<0.01);
 // Let the normal EKF readiness and arming checks settle; do not force arm.
 await wait(35000);
 await operation({kind:'mode',customMode:19});
 await operation({kind:'arm',armed:true});
 const takeoffAt=Date.now();
 await operation({kind:'mission-start'},'accepted');
 await until(()=>service.snapshot().telemetry.mode==='AUTO','reported AUTO mission mode');
 await until(()=>service.snapshot().telemetry.relativeAltitudeM>10,'vertical takeoff climb',90000);
 const climb=service.snapshot();
 const homeDistance=t=>Math.hypot((t.latitude-home.lat)*111320,(t.longitude-home.lon)*111320*Math.cos(home.lat*Math.PI/180));
 assert.equal(climb.mission.currentSeq,1,'Vertical climb is still mission item 1');
 assert(homeDistance(climb.telemetry)<15,'Vertical takeoff holds near the takeoff point');
 assert(climb.telemetry.groundspeedKt<5,'Initial takeoff is vertical, not a runway departure');
 assert(climb.telemetry.verticalSpeedFpm>100,'Measured VSI reports the vertical climb');
 evidence.stages.push({action:'vertical takeoff observed',distanceFromHomeM:homeDistance(climb.telemetry),telemetry:climb.telemetry});
 console.log(`Vertical climb observed: ${climb.telemetry.relativeAltitudeM.toFixed(1)} m, ${homeDistance(climb.telemetry).toFixed(1)} m from home`);
 await until(()=>service.snapshot().mission.currentSeq===2,'VTOL takeoff completed; first route waypoint active',120000);
 const transition=service.snapshot();
 assert(Math.abs(transition.telemetry.relativeAltitudeM-54.864)<6,'Takeoff completes near the requested 180 ft altitude');
 evidence.stages.push({action:'180 ft takeoff completed',telemetry:transition.telemetry,mission:transition.mission});
 console.log(`Takeoff completed: ${transition.telemetry.relativeAltitudeM.toFixed(1)} m, route item 02 active`);
 await until(()=>extendedStates.some(s=>s.at>takeoffAt&&s.vtolState===4),'autopilot reports fixed-wing transition completed',90000);
 await until(()=>service.snapshot().telemetry.relativeAltitudeM>85 && service.snapshot().telemetry.airspeedKt>30,'forward flight climbing toward the 300 ft route',90000);
 await until(()=>service.snapshot().mission.currentSeq>=5,'three geographic waypoints completed',240000);
 for(const seq of [2,3,4]){
   const samples=navigationSamples.filter(s=>s.currentSeq===seq&&s.view.lateralValid);
   assert(samples.length>=2,`Live CDI must follow route item ${seq}, not only a fixture`);
   assert(samples.every(s=>s.view.seq===seq&&s.nav.missionSeq===seq&&s.view.fromSeq===seq-1),'CDI source and displayed leg must agree');
   assert(samples.every(s=>Number.isFinite(s.view.desiredTrackDeg)&&Math.abs(s.deflection)<=1),'Course and deviation remain finite and bounded');
 }
 evidence.stages.push({action:'CDI sequenced through route items 02, 03 and 04',courses:[2,3,4].map(seq=>({seq,course:navigationSamples.find(s=>s.currentSeq===seq&&s.view.lateralValid).view.desiredTrackDeg}))});
 assert(extendedStates.some(s=>s.at>takeoffAt&&s.vtolState===3),'Autopilot reported multicopter flight');
 assert(extendedStates.some(s=>s.at>takeoffAt&&s.vtolState===1),'Autopilot reported transition to fixed wing');
 evidence.stages.push({action:'transition and three route waypoints completed',telemetry:service.snapshot().telemetry,mission:service.snapshot().mission});
 assert.equal(commands.filter(c=>c.command===300).length,1,'Only one mission start request');
 evidence.outcome='passed';

}catch(error){evidence.outcome='failed';evidence.error=error.message;if(started)evidence.simulatorLog=docker('logs','--tail','40',name);if(service)evidence.lastSnapshot=service.snapshot();console.error(error.message);process.exitCode=1;}
finally{
 evidence.commands=commands;evidence.extendedStates=extendedStates;evidence.flightSamples=flightSamples;evidence.navigationSamples=navigationSamples;service?.close();socket?.destroy();
 // Preserve observations even if Docker cleanup fails or stalls.
 if(options['--output']){const file=resolve(options['--output']);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify({...evidence,cleanup:'pending'},null,2)+'\n');}
 if(started){assert.equal(docker('inspect','--format','{{index .Config.Labels "yonder.test"}}',name),'quadplane-mission-smoke');docker('rm','-f',name);}
 rmSync(runtime,{recursive:true,force:true});evidence.finishedAt=new Date().toISOString();
 if(options['--output']){const file=resolve(options['--output']);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');}
 console.log(`SITL smoke ${evidence.outcome}; disposable simulator stopped`);
}
