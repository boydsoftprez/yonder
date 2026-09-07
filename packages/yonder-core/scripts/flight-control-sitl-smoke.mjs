// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-12/13, R-CMD-04/09, R-TEL-01/06: opt-in real-firmware smoke in a fresh, disposable simulator.
// Usage: node packages/yonder-core/scripts/flight-control-sitl-smoke.mjs --firmware-dir DIR --output FILE
// DIR contains the checksummed official ArduPlane 4.7.1 bin/arduplane and plane.parm.
// Build yonder-core first. Never attaches to the existing research preview or to hardware.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {createConnection,createServer} from 'node:net';
import {MavLinkPacketSplitter} from 'node-mavlink';
import {decodeDatagram} from '../dist/mav/protocol.js';
import {VehicleService} from '../dist/mav/vehicle.js';
import {systemClock} from '../dist/apply/types.js';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){assert(['--firmware-dir','--output'].includes(args[i])&&args[i+1],'Expected --firmware-dir DIR and optional --output FILE');options[args[i]]=args[i+1];}
assert(options['--firmware-dir'],'A verified firmware directory is required');
const firmware=resolve(options['--firmware-dir']);
for(const [file,hash] of [['bin/arduplane','1b6f6810016531f81a2ab240c1353aa7310334079b4c0954ecac8d17cf1adabe'],['plane.parm','93ba9a70c771609a90b81249d6a1d5a9df8d48bef7d149b42b2d9c7fbd06494a']])assert.equal(createHash('sha256').update(readFileSync(join(firmware,file))).digest('hex'),hash,`Unverified simulator input ${file}`);
const port=5768,name=`yonder-flight-control-smoke-${randomUUID().slice(0,8)}`,runtime=mkdtempSync(join(tmpdir(),'yonder-flight-control-sitl-'));
const evidence={schema:1,sourceCommit:'dbe792162d06cab66c3475fd5556bf7a120f119e',firmware:'Official ArduPlane 4.7.1',evidence:'Independent disposable SITL; no physical aircraft',startedAt:new Date().toISOString(),stages:[],outcome:'running'};
let started=false,socket,service,firstBytes;
const commands=[];
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
 docker('run','-d','--name',name,'--platform','linux/amd64','--label','yonder.test=flight-control-protocol-smoke','-p',`127.0.0.1:${port}:5760`,
  '--mount',`type=bind,src=${firmware},dst=/opt/sitl,readonly`,'--mount',`type=bind,src=${runtime},dst=/data`,'-w','/data',
  'ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517',
  '/opt/sitl/bin/arduplane','--model','plane','--home','35.9607874,-83.3668696,315.641734,90','--defaults','/opt/sitl/plane.parm','--speedup','1','--sysid','1');
 started=true;socket=await connect();socket.on('error',()=>{});
 service=new VehicleService({clock:systemClock,send:bytes=>new Promise((ok,no)=>{for(const frame of decodeDatagram(bytes))if(frame.id===75||frame.id===76)commands.push({at:Date.now(),command:frame.data.command,bytes:Buffer.from(bytes).toString('base64')});socket.write(bytes,e=>e?no(e):ok());})});
 const splitter=new MavLinkPacketSplitter();splitter.on('data',({buffer})=>service.receive(buffer));splitter.on('error',()=>{});socket.on('data',bytes=>splitter.write(bytes));
 if(firstBytes)splitter.write(firstBytes);
 await until(()=>service.snapshot().connected,'ArduPlane heartbeat');assert.equal(service.snapshot().identity.autopilot,3);assert.equal(service.snapshot().identity.vehicleType,1);
 await operation({kind:'stream-setup'},'accepted');
 await until(()=>service.snapshot().telemetry.ready&&service.snapshot().telemetry.fixType>=3,'fresh flight telemetry and GPS fix',40000);
 assert(Math.abs(service.snapshot().telemetry.latitude-35.9607874)<0.01,'Simulator home must match this smoke test');
 await operation({kind:'mission-download'});
 const home=service.snapshot().telemetry.homePosition??{lat:35.9607874,lon:-83.3668696,alt:315.641734};
 const base={params:[0,0,0,0],current:false,autocontinue:true};
 const items=[{...base,seq:0,command:16,frame:0,x:home.lat,y:home.lon,z:home.alt},
  {...base,seq:1,command:22,frame:3,x:0,y:0,z:100},
  {...base,seq:2,command:16,frame:3,x:home.lat+0.003,y:home.lon+0.004,z:100}];
 await operation({kind:'mission-upload',items});
 // EKF readiness is reported by the autopilot; retain ordinary arming checks.
 await wait(35000);
 await operation({kind:'arm',armed:true});
 await operation({kind:'continue-auto',seq:1,autoMode:10});
 await until(()=>service.snapshot().telemetry.relativeAltitudeM>20,'AUTO takeoff observed',60000);
 evidence.stages.push({action:'AUTO flight observed',telemetry:service.snapshot().telemetry});
 await operation({kind:'goto',target:{lat:home.lat+0.004,lon:home.lon+0.003,altitudeM:home.alt+120,datum:'msl'}});
 await until(()=>service.snapshot().telemetry.navController?.mode==='GUIDED','fresh GUIDED navigation controller');
 assert(service.snapshot().capabilities.flightControl.every(c=>c.available),'Reported 4.7.1 firmware enables flight controls');
 await operation({kind:'heading',headingDeg:0,reference:'true',turnAccelerationMps2:2},'accepted');
 await until(()=>{const t=service.snapshot().telemetry;return t.headingDeg!==null&&Math.min(t.headingDeg,360-t.headingDeg)<8;},'measured north heading',90000);
 await wait(8000);
 assert(service.snapshot().telemetry.headingDeg!==null&&Math.min(service.snapshot().telemetry.headingDeg,360-service.snapshot().telemetry.headingDeg)<10,'One-shot heading continues beyond GUIDED_TIMEOUT');
 evidence.stages.push({action:'one-shot heading measured after 8 seconds',telemetry:service.snapshot().telemetry});
 await operation({kind:'altitude',altitudeM:150,datum:'home',verticalRateMps:0},'accepted');
 await until(()=>Math.abs(service.snapshot().telemetry.relativeAltitudeM-150)<8,'measured home-relative altitude',90000);
 evidence.stages.push({action:'altitude physically reached',telemetry:service.snapshot().telemetry});
 await operation({kind:'speed',airspeedMps:25,accelerationMps2:1},'accepted');
 await until(()=>Math.abs(service.snapshot().telemetry.airspeedKt/1.9438444924406-25)<2,'measured airspeed',60000);
 evidence.stages.push({action:'airspeed physically reached',telemetry:service.snapshot().telemetry});
 // Actual flight geometry is smoke evidence only. The service never labels radius as reported telemetry.
 const center={lat:service.snapshot().telemetry.latitude,lon:service.snapshot().telemetry.longitude,altitudeM:150,datum:'home'};
 const polar=()=>{const t=service.snapshot().telemetry,north=(t.latitude-center.lat)*111320,east=(t.longitude-center.lon)*111320*Math.cos(center.lat*Math.PI/180);return {at:Date.now(),radiusM:Math.hypot(north,east),bearingDeg:Math.atan2(east,north)*180/Math.PI};};
 for(const direction of ['ccw','cw']){
  await operation({kind:'loiter',target:center,radiusM:180,direction},'accepted');
  await until(()=>service.snapshot().telemetry.positionTarget&&Math.abs(service.snapshot().telemetry.positionTarget.lat-center.lat)<2e-7&&Math.abs(service.snapshot().telemetry.positionTarget.lon-center.lon)<2e-7,'reported loiter center');
  await wait(40000);
  const samples=[];for(let i=0;i<25;i++){samples.push(polar());await wait(1000);}
  const turns=samples.slice(1).map((s,i)=>(s.bearingDeg-samples[i].bearingDeg+540)%360-180),rotation=turns.reduce((a,b)=>a+b,0),meanRadius=samples.reduce((a,s)=>a+s.radiusM,0)/samples.length;
  evidence.stages.push({action:`${direction} loiter geometry`,requestedRadiusM:180,meanRadiusM:meanRadius,rotationDeg:rotation,samples});
  assert.equal(Math.sign(rotation),direction==='cw'?1:-1,'Measured orbit direction matches operator request');
  assert(meanRadius>100&&meanRadius<270,`Measured orbit ${meanRadius.toFixed(1)} m remains near requested 180 m radius`);
 }
 await operation({kind:'continue-auto',seq:2,autoMode:10});
 await operation({kind:'mode',customMode:11});
 evidence.commands=commands;
 assert.equal(commands.filter(c=>c.command===43002).length,1,'Only one heading command sent');
 assert.equal(commands.filter(c=>c.command===43001).length,1,'Only one altitude command sent');
 assert.equal(commands.filter(c=>c.command===43000).length,1,'Only one speed command sent');

 evidence.outcome='passed';
}catch(error){evidence.outcome='failed';evidence.error=error.message;if(started)evidence.simulatorLog=docker('logs','--tail','40',name);if(service)evidence.lastSnapshot=service.snapshot();console.error(error.message);process.exitCode=1;}
finally{
 evidence.commands=commands;service?.close();socket?.destroy();
 if(started){assert.equal(docker('inspect','--format','{{index .Config.Labels "yonder.test"}}',name),'flight-control-protocol-smoke');docker('rm','-f',name);}
 rmSync(runtime,{recursive:true,force:true});evidence.finishedAt=new Date().toISOString();
 if(options['--output']){const file=resolve(options['--output']);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');}
 console.log(`SITL smoke ${evidence.outcome}; disposable simulator stopped`);
}
