// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-04: isolated, disarmed ArduPlane home + first mission upload checks.
// Usage: node packages/yonder-core/scripts/home-sitl-smoke.mjs --firmware-dir DIR --output FILE
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createConnection,createServer} from 'node:net';
import {MavLinkPacketSplitter} from 'node-mavlink';
import {VehicleService} from '../dist/mav/vehicle.js';
import {decodeDatagram} from '../dist/mav/protocol.js';
import {systemClock} from '../dist/apply/types.js';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){assert(['--firmware-dir','--output'].includes(args[i])&&args[i+1]);options[args[i]]=args[i+1]}
assert(options['--firmware-dir'],'A checksummed official firmware directory is required');
const firmware=resolve(options['--firmware-dir']);
for(const [file,hash] of [['bin/arduplane','1b6f6810016531f81a2ab240c1353aa7310334079b4c0954ecac8d17cf1adabe'],['plane.parm','93ba9a70c771609a90b81249d6a1d5a9df8d48bef7d149b42b2d9c7fbd06494a']])assert.equal(createHash('sha256').update(readFileSync(join(firmware,file))).digest('hex'),hash);
const evidence={firmware:'Official ArduPlane 4.7.1',sourceCommit:'dbe792162d06cab66c3475fd5556bf7a120f119e',scope:'Disposable SITL only; never connects to physical hardware',startedAt:new Date().toISOString(),cases:[],outcome:'running'};
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']}).trim();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){const value=fn();if(value)return value;await wait(100)}throw new Error('Timed out: '+label)}
async function run(gps){
 const name='yonder-home-smoke-'+randomUUID().slice(0,8),runtime=mkdtempSync(join(tmpdir(),'yonder-home-smoke-')),result={gps,operations:[]};evidence.cases.push(result);
 let started=false,socket,service;const commands=[];
 const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
 async function operation(action){const snapshot=service.snapshot(),id=randomUUID();const admission=service.submit({id,sessionId:'isolated-home-smoke',confirmed:true,vehicleGeneration:snapshot.identity.generation,expectedMissionRevision:snapshot.mission.revision??undefined,action});assert(admission.accepted,admission.message);
  const op=await until(()=>{const s=service.snapshot();return !s.busy&&s.operations.find(o=>o.id===id)},action.kind);
  result.operations.push(op);assert.equal(op.state,action.kind==='stream-setup'?'accepted':'observed',op.message);console.log(`${gps?'GPS':'No GPS'} ${action.kind}: ${op.state}`);return op;
 }
 try{
  writeFileSync(join(runtime,'home-test.parm'),gps?'':'GPS1_TYPE 0\nGPS2_TYPE 0\n');
  docker('run','-d','--name',name,'--platform','linux/amd64','--label','yonder.test=home-protocol-smoke','-p',`127.0.0.1:${port}:5760`,
   '--mount',`type=bind,src=${firmware},dst=/opt/sitl,readonly`,'--mount',`type=bind,src=${runtime},dst=/data`,'-w','/data',
   'ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517','/opt/sitl/bin/arduplane','--model','plane','--home','35.9607874,-83.3668696,315.641734,90','--defaults',gps?'/opt/sitl/plane.parm':'/opt/sitl/plane.parm,/data/home-test.parm','--speedup','1','--sysid','1');started=true;
  let first;
  for(let i=0;i<40&&!socket;i++){
   try{socket=await new Promise((ok,no)=>{const s=createConnection({host:'127.0.0.1',port});const timer=setTimeout(()=>{s.destroy();no(new Error('No data'))},1500);s.once('data',bytes=>{clearTimeout(timer);first=bytes;ok(s)});s.once('error',e=>{clearTimeout(timer);no(e)});s.once('close',()=>{clearTimeout(timer);no(new Error('Not ready'))})})}catch{await wait(250)}
  }
  assert(socket,'Isolated SITL did not connect');socket.on('error',()=>{});
  service=new VehicleService({clock:systemClock,send:bytes=>new Promise((ok,no)=>{for(const f of decodeDatagram(bytes))if([75,76].includes(f.id))commands.push(f.data.command);socket.write(bytes,e=>e?no(e):ok())})});
  const splitter=new MavLinkPacketSplitter();splitter.on('data',({buffer})=>service.receive(buffer));splitter.on('error',()=>{});socket.on('data',bytes=>splitter.write(bytes));if(first)splitter.write(first);
  await until(()=>service.snapshot().connected,'heartbeat');await operation({kind:'stream-setup'});
  await until(()=>{const t=service.snapshot().telemetry;return Number.isFinite(t.rollDeg)&&t.armed===false&&(gps?t.fixType>=3:t.fixType===null||t.fixType<2)},'requested GPS state');
  await operation({kind:'mission-download'});assert.equal(service.snapshot().mission.items.length,0);
  const home={lat:35.9612345,lon:-83.3654321,alt:333.25};
  await operation({kind:'set-home',home,expectedHome:service.snapshot().telemetry.homePosition});
  assert(Math.abs(service.snapshot().telemetry.homePosition.alt-home.alt)<.1);
  const base={params:[0,0,0,0],current:false,autocontinue:true};
  await operation({kind:'mission-upload',items:[{...base,seq:0,command:16,frame:0,x:home.lat,y:home.lon,z:home.alt},{...base,seq:1,command:16,frame:3,x:home.lat+.001,y:home.lon,z:100}]});
  await operation({kind:'set-home',home:{...home,alt:343.25},expectedHome:service.snapshot().telemetry.homePosition});
  const state=service.snapshot();assert.equal(state.telemetry.armed,false);assert.equal(state.mission.items[1].z,100);
  assert(!commands.some(c=>[176,400,300,192,43000,43001,43002].includes(c)),'No arm, mode, flight target or mission-start commands');
  if(!gps)assert(state.telemetry.fixType===null||state.telemetry.fixType<2,'Setting home does not create a GPS fix');
  result.home=state.telemetry.homePosition;result.fixType=state.telemetry.fixType;result.armed=state.telemetry.armed;result.mission=state.mission;result.outcome='passed';
 }catch(error){result.outcome='failed';result.error=error.message;if(service)result.lastSnapshot=service.snapshot();if(started)result.log=docker('logs','--tail','35',name);throw error}
 finally{service?.close();socket?.destroy();if(started){assert.equal(docker('inspect','--format','{{index .Config.Labels "yonder.test"}}',name),'home-protocol-smoke');docker('rm','-f',name)}rmSync(runtime,{recursive:true,force:true})}
}
try{await run(false);await run(true);evidence.outcome='passed'}catch(error){evidence.outcome='failed';evidence.error=error.message;console.error(error);process.exitCode=1}
finally{evidence.finishedAt=new Date().toISOString();if(options['--output']){const path=resolve(options['--output']);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(evidence,null,2)+'\n')}console.log('Home SITL smoke '+evidence.outcome)}
