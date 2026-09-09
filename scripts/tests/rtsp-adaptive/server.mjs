// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { ConfigSchema } from '../../../packages/yonder-core/dist/schema/config.js';
import { mediamtxConfig } from '../../../packages/yonder-core/dist/media/config.js';
import { RtspFeedback } from '../../../packages/yonder-core/dist/video/rtsp-feedback.js';
import { Adaptation } from '../../../packages/yonder-core/dist/video/adaptation.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const camera = ConfigSchema.parse({version:1,network:{ap:{psk:{secret:'fixture'}}},ui:{editor:{}},cameras:[{
 id:'cam0',name:'Fixture',source:'usb',device:'fixture',width:640,height:360,framerate:30,bitrate_kbps:1200,
 stream:{mode:'adaptive',floor_kbps:300,ceiling_kbps:2000},preview:{mode:'fixed'},
 outputs:[{kind:'rtsp',enabled:true,password:{secret:'fixture'}}]
}]}).cameras[0];
const config = ConfigSchema.parse({version:1,network:{ap:{psk:{secret:'fixture'}}},ui:{editor:{}},cameras:[camera]});
writeFileSync('/tmp/mediamtx.yml',mediamtxConfig({config,rtspPassword:'fixture-video',observerPassword:'fixture-observer'}));
const media=spawn('/usr/local/bin/mediamtx',['/tmp/mediamtx.yml']);
for(const stream of [media.stdout,media.stderr])stream.on('data',chunk=>appendFileSync('/results/media.log',chunk));
let publisher,observer,adaptation;let rate=1200,sequence=0;const requests=new Map(),changes=[],samples=[];
const transport=process.env.TEST_TRANSPORT || 'tcp';
let phase='startup';
function shape(kbps){execFileSync('tc',['qdisc','replace','dev','eth0','root','netem','delay','35ms','5ms','rate',kbps+'kbit','limit','50']);}
function requestRate(kbps,origin="adaptive"){return new Promise((resolve,reject)=>{
 const id='fixture-'+(++sequence);const timeout=setTimeout(()=>{requests.delete(id);reject(Error('encoder timeout'));},3000);
 requests.set(id,{resolve:answer=>{clearTimeout(timeout);rate=answer.observed;changes.push({at:Date.now(),phase,origin,requested:kbps,observed:rate,continuous:answer.continuous,pid:answer.pid});resolve({requested:kbps,observed:rate,continuous:answer.continuous,at:Date.now()});}});
 publisher.stdin.write(JSON.stringify({op:'retune',id,sets:[{element:'enc-stream',property:'bitrate',value:String(kbps)}]})+'\n');
});}
const channel={inForce:()=>({stream:rate,preview:null,shape:null}),retune:(_camera,encode,kbps)=>{assert.equal(encode,'stream');return requestRate(kbps);},reconfigurePreview:async()=>({notControllable:'No preview in this fixture'})};
async function metadata(){
 const response=await fetch('http://127.0.0.1:9997/v3/rtspsessions/list',{headers:{Authorization:'Basic '+Buffer.from('yonder-observer:fixture-observer').toString('base64')}});
 if(response.status!==200)throw Error('metadata HTTP '+response.status+' '+await response.text());return response.json();
}
async function runPhase(name,kbps,seconds){
 phase=name;shape(kbps);const start=Date.now();const rows=[];
 while(Date.now()-start<seconds*1000){
  await sleep(1000);const body=await metadata();const reader=body.items.find(s=>s.state==='read'&&!s.remoteAddr.startsWith('127.'));
  const row={at:Date.now(),phase,rate,feedback:observer.state('cam0'),discarded:reader?.outboundRTPPacketsDiscarded??null,rtpSent:reader?.outboundRTPPackets,reportedLost:reader?.outboundRTPPacketsReportedLost,rtcp:reader?.inboundRTCPPackets};rows.push(row);samples.push(row);
  appendFileSync('/results/samples.jsonl',JSON.stringify(row)+'\n');
 }
 const receiver=existsSync('/results/receiver.jsonl')?readFileSync('/results/receiver.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(r=>r.at>start+seconds*1000-8000):[];
 const endRows=rows.slice(-8);const summary={name,linkKbps:kbps,startRate:rows[0]?.rate,endRate:rate,minRate:Math.min(...rows.map(r=>r.rate)),endDiscardDelta:endRows.at(-1)?.discarded-endRows[0]?.discarded,decodedFps:receiver.length?receiver.reduce((sum,r)=>sum+r.fps,0)/receiver.length:0};
 console.log(JSON.stringify(summary));appendFileSync('/results/phases.jsonl',JSON.stringify(summary)+'\n');return summary;
}
try{
 for(let i=0;i<60;i++){try{await metadata();break;}catch(error){if(i===59)throw error;await sleep(100);}}
 for(const auth of [undefined,'Basic '+Buffer.from('yonder:fixture-video').toString('base64')]){
  const r=await fetch('http://127.0.0.1:9997/v3/rtspsessions/list',{headers:auth?{Authorization:auth}:{}});assert.equal(r.status,401);
 }
 const args=['/work/installer/payload/yonder-pipeline','-q','videotestsrc','is-live=true','pattern=snow','!','video/x-raw,format=I420,width=640,height=360,framerate=30/1','!','tee','name=raw','raw.','!','queue','!','x264enc','name=enc-stream','bitrate=1200','speed-preset=ultrafast','tune=zerolatency','key-int-max=30','!','h264parse','!','tee','name=main','main.','!','queue','leaky=downstream','max-size-time=200000000','max-size-buffers=0','max-size-bytes=0','!','rtspclientsink','location=rtsp://127.0.0.1:8554/cam0','latency=0'];
 publisher=spawn('python3',args);publisher.stderr.on('data',chunk=>appendFileSync('/results/publisher.log',chunk));
 createInterface({input:publisher.stdout}).on('line',line=>{try{const answer=JSON.parse(line);const pending=requests.get(answer.id);if(pending){requests.delete(answer.id);pending.resolve(answer);}}catch{}});
 publisher.on('exit',code=>{if(!existsSync('/results/stop'))console.error('publisher exited',code);});
 shape(3000);
 for(let i=0;i<100;i++){const state=await metadata();if(state.items.some(s=>s.state==='publish'))break;if(i===99)throw Error('Publisher never became ready');await sleep(100);}
 writeFileSync('/results/ready','ready');
 for(let i=0;i<200&&!existsSync('/results/client-ready');i++)await sleep(100);
 assert.ok(existsSync('/results/client-ready'),'receiver never decoded video');
 adaptation=new Adaptation({channel,cameras:()=>[camera]});
 observer=new RtspFeedback({cameras:()=>[camera],password:()=> 'fixture-observer',report:r=>adaptation.observe(r),forget:(c,v)=>adaptation.forget(c,v),blockIncrease:(c,b)=>adaptation.blockRtspIncrease(c,b)});
 observer.start();adaptation.start();
 const baseline=await runPhase('baseline',3000,10);
 const constrained=await runPhase('constrained',650,transport==='udp'?45:35);
 const recovered=await runPhase('recovered',3000,35);
 camera.stream.mode='fixed';await adaptation.settled();await requestRate(1200,"fixed-mode setup");const fixedChanges=changes.length;
 const fixed=await runPhase('fixed-constrained',650,12);
 assert.ok(constrained.minRate<baseline.endRate,'Adaptive never reduced the actual encoder');
 assert.ok(constrained.endRate<=800,'Adaptive did not fit the constrained link');
 assert.ok(constrained.decodedFps>=25,'constrained delivery did not recover useful frame rate');
 assert.ok(constrained.endDiscardDelta<=5,'server still discards video after settling');
 assert.ok(recovered.endRate>constrained.endRate,'Adaptive did not recover bitrate');
 assert.equal(fixed.endRate,1200);assert.equal(changes.length,fixedChanges,'Fixed mode retuned itself');
 assert.ok(changes.every(c=>c.observed>=300&&c.observed<=2000),'bounds violated');
 assert.ok(changes.every(c=>c.continuous&&c.pid===publisher.pid),'encoder restarted or stopped producing frames during a retune');
 writeFileSync('/results/result.json',JSON.stringify({passed:true,transport,baseline,constrained,recovered,fixed,changes},null,2));
}catch(error){console.error(error);writeFileSync('/results/result.json',JSON.stringify({passed:false,error:String(error),changes},null,2));process.exitCode=1;}
finally{observer?.stop();adaptation?.stop();writeFileSync('/results/stop','stop');publisher?.kill('SIGTERM');media.kill('SIGTERM');}
