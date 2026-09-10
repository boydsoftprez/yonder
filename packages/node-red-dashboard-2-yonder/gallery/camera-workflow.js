// SPDX-License-Identifier: GPL-3.0-or-later
// UI-only fixture: production components and workspace hydration, no device requests.
import {createApp,h,reactive,ref} from 'vue'
import Picture from '../src/ui/YonderPicture.vue'
import Aim from '../src/ui/YonderAim.vue'
import Deck from '../src/ui/YonderDeck.vue'
import {CAPABILITY_KEYS} from 'yonder-core/presentation'
import {CameraWorkspace} from '../../node-red-contrib-yonder-video/src/workspace-model.ts'
import {expireCameraSession} from '../src/ui/camera-session.ts'
const scenario=ref('Running'),theme=ref('day'),epoch=ref(0),reject=ref(false),activity=ref('No device commands are sent.')
const model=new CameraWorkspace(),store=reactive({state:{data:{messages:{}}}})
const emptyCaps=Object.fromEntries(CAPABILITY_KEYS.map(key=>[key,{state:'not-offered'}]))
let report={camera:{id:'cam3',name:'Pocket 2 · fixture',spec:'1280×720 · 30 fps',identity:'USB accessory · stable camera identity'},run:{state:'running'},startBlocked:null,
 capabilities:emptyCaps,descriptors:{},values:{},commanded:{},outputs:[],recorder:null,captures:0,
 policy:{capture:{width:1280,height:720,framerate:30,codec:'h264'},stream:{mode:'fixed',floor_kbps:2000,ceiling_kbps:2000,bitrate_kbps:2000},preview:{mode:'adaptive',size:'1280x720',ladder_top:'1280x720',ladder_bottom:'640x360',floor_kbps:400,ceiling_kbps:4000,bitrate_kbps:1150,framerate:30},image:{brightness:0,contrast:100,saturation:100,hue:0}},
 runtime:{streamKbps:2000,previewKbps:1150,shape:{size:'1280x720',fps:30},decision:{reason:'Healthy receiver delivery; checking for room within the applied limits.'}},
 orientation:{says:'The board rotates the streamed picture.',turns:[{key:'horizontalFlip',value:0,by:'board'},{key:'verticalFlip',value:0,by:'board'},{key:'rotation',value:0,by:'board'}]},
 accessory:{input:{native:{width:1280,height:720,fps:30}},state:{status:{mode:'photo',modeCode:0,recordPhase:'idle',remainingPhotos:1200}},controls:[
 {key:'ev',group:'exposure',label:'Brightness',state:'present',value:'16',options:Array.from({length:13},(_,i)=>({value:String(i+10),label:String((i-6)/3),command:{kind:'ev',value:i+10}}))},
 {key:'white-balance',group:'exposure',label:'White balance',state:'present',value:'0',options:[{value:'0',label:'Auto',command:{kind:'white-balance',value:0}},{value:'40',label:'4000 K',command:{kind:'white-balance',value:40}}]},
 ]}}
let previous=null,id=0,auth=true,recallCount=0,fixtureMode='FPV'
let fixturePresets={revision:1,slots:[{slot:1,name:'Forward',pan:0,tilt:0,frame:'hg211-joints-v1',mode:1,savedAt:1},{slot:2,name:'Inspection',pan:-180,tilt:-40,frame:'hg211-joints-v1',mode:1,savedAt:1}]}
const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720
const ctx=canvas.getContext('2d');let count=0
setInterval(()=>{ctx.fillStyle='#203c4b';ctx.fillRect(0,0,1280,720);ctx.strokeStyle='#78949e';for(let x=0;x<1280;x+=80){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,720);ctx.stroke()}ctx.fillStyle='#f4f0df';ctx.font='30px sans-serif';ctx.fillText('Component fixture — no camera connection',60,95);ctx.fillText(`Frame ${++count}`,60,145)},100)
const stream=canvas.captureStream(10)
class Peer {
 addTransceiver(){} async createOffer(){return{sdp:'fixture'}} async setLocalDescription(){}
 async setRemoteDescription(){this.connectionState='connected';this.ontrack?.({streams:[stream]})}
 close(){this.connectionState='closed'}
 async getStats(){return new Map([['in',{type:'inbound-rtp',kind:'video',packetsLost:0,packetsReceived:count*10,bytesReceived:count*14000,frameWidth:1280,frameHeight:720,framesPerSecond:10}],['pair',{type:'candidate-pair',state:'succeeded',currentRoundTripTime:.025}]])}
}
window.RTCPeerConnection=Peer
window.fetch=async(url,options={})=>{
 if(url==='/session')return new Response(JSON.stringify({authenticated:auth}),{status:auth?200:401})
 if(!auth)return new Response('',{status:401})
 if(String(url).endsWith('/presets')){const b=JSON.parse(options.body);if(b.revision!==fixturePresets.revision)return new Response(JSON.stringify({error:'Presets changed'}),{status:409});let rows=fixturePresets.slots.filter(p=>p.slot!==b.slot);const old=fixturePresets.slots.find(p=>p.slot===b.slot);if(b.op!=='delete')rows.push(b.op==='rename'?{...old,name:b.name}:{slot:b.slot,name:b.name,pan:12.4,tilt:-5.2,frame:'hg211-joints-v1',mode:1,savedAt:Date.now()});fixturePresets={revision:fixturePresets.revision+1,slots:rows.sort((a,b)=>a.slot-b.slot)};hydrate();return new Response(JSON.stringify({presets:fixturePresets}),{status:200})}
 if(String(url).endsWith('/aim')){const b=JSON.parse(options.body);if(b.op==='issue-recall')recallCount=0;if(b.op==='mode'){fixtureMode=['Free','FPV','Follow'][b.mode];hydrate()}return new Response(JSON.stringify({accepted:true,grant:{gesture:'fixture',credential:'fixture',deadline:Date.now()+500},next:{gesture:'fixture',credential:'fixture',deadline:Date.now()+500},arrived:b.op==='recall'&&++recallCount>=5,name:'Fixture position',rate:{pan:0,tilt:0}}),{status:200})}
 if(String(url).endsWith('/connection'))return new Response(JSON.stringify({renderings:[{kind:'url',title:'RTSP URL',body:'',usable:false,note:'Enable RTSP in Outputs and Apply to create a player address.'},{kind:'gstreamer',title:'GStreamer',body:'gst-launch-1.0 fixture',usable:false,note:'No RTP destination configured.'}]}),{status:200})
 if(String(url).endsWith('/whep'))return new Response('fixture',{status:scenario.value==='Unavailable'?503:['stopped','failed','starting'].includes(report.run.state)?404:201,headers:{'x-yonder-viewer':'fixture'}})
 return new Response(JSON.stringify({camera:'cam3',viewer:'fixture',shared:{mode:report.policy.preview.mode},mine:{receiverBufferMs:25,decodeMs:2},overlay:{head:report.policy.preview.mode==='fixed'?'fixed':'held',size:'1280×720',rate:'30 fps',bitrate:'1.19 Mb/s',step:report.runtime.decision.reason}}))
}
function send(message){const result=model.receive(message);if(result)store.state.data.messages.deck={payload:result}}
function hydrate(){
 report.applied=structuredClone(report.policy)
 send({workspaceKind:'report',camera:'cam3',payload:structuredClone(report)})
 store.state.data.messages.picture={payload:{path:scenario.value==='No camera'?'':'cam3',runState:report.run.state,running:report.run.state==='running'?true:report.run.state==='stopped'?false:null,startBlocked:report.startBlocked,cameras:[{id:'cam3',name:report.camera.name,active:true,caption:report.run.state,thumbSrc:canvas.toDataURL('image/jpeg'),ageSeconds:0}],state:null}}
 store.state.data.messages.aim={payload:{state:'present',url:'/video/fixture/aim',generation:1,positionFrame:'handle',presets:fixturePresets,modeHelp:'FPV follows the handle on all axes.',recentreLabel:'Recenter in Follow',pan:12.4,tilt:-5.2,bounds:null,maxRate:120,mode:fixtureMode,modes:['Free','FPV','Follow'],inhibited:null,imageDirection:'identity'}}
}
function phase(state){send({workspaceKind:'pending',payload:{pending:state==='pending',id:`fixture-${id}`,engineState:state,observedAt:Date.now(),what:'Changes are active.',keys:[{label:'Keep',action:'confirm'},{label:'Revert',action:'revert'}]},yonder:{state:state==='pending'?'pending':'idle',expiresAt:state==='pending'?Date.now()+120000:null,at:Date.now()}})}
function result(operation,state,message){send({workspaceKind:'result',camera:'cam3',operation,yonder:{operation,state,message,at:Date.now(),id:`fixture-${id}`}})}
const socket={on(){},off(){},emit(_event,widget,message){
 const payload=message.payload;activity.value=`Fixture action: ${JSON.stringify(payload)}`
 if(widget==='picture'&&(payload==='start'||payload==='stop')){
  report.run.state=payload==='start'?'starting':'stopped';hydrate();if(payload==='start')setTimeout(()=>{report.run.state='running';hydrate()},900);return
 }
 if(payload?.video){report.run.state=payload.video==='start'?'starting':'stopped';hydrate();result(payload.video,'confirmed','Video request completed.');if(payload.video==='start')setTimeout(()=>{report.run.state='running';hydrate()},900)}
 if(payload?.apply){
  id++;phase('applying');previous=structuredClone(report.policy)
  setTimeout(()=>{
   if(reject.value){phase('idle');result('apply','rejected','The device rejected this change. Review the current camera settings.');reject.value=false;return}
   for(const[key,value]of Object.entries(payload.apply)){
    const image={imageBrightness:'brightness',imageContrast:'contrast',imageSaturation:'saturation',imageHue:'hue'}[key]
    if(image)report.policy.image[image]=value
    if(key==='previewSize')report.policy.preview.size=value
    if(key==='streamMode')report.policy.stream.mode=String(value).toLowerCase()
    if(key==='streamBitrate')report.policy.stream.bitrate_kbps=value
    if(key==='previewMode')report.policy.preview.mode=String(value).toLowerCase()
    if(key==='previewBitrate')report.policy.preview.bitrate_kbps=value
   }
   phase('pending');result('apply','pending','Changes applied.');hydrate()
  },800)
 }
 if(payload?.transaction){const operation=payload.transaction.endsWith('confirm')?'confirm':'revert';phase(operation==='revert'?'reverting':'applying');setTimeout(()=>{if(operation==='revert'&&previous)report.policy=previous;phase(operation==='confirm'?'confirmed':'reverted');result(operation,'confirmed',operation==='confirm'?'Changes kept.':'Previous settings restored.');hydrate()},800)}
 if(payload?.refresh){hydrate();result('probe','confirmed','Camera refreshed.')}
 if(payload?.nativeControl){const c=report.accessory.controls.find(c=>c.key===payload.nativeControl.kind);if(c)c.value=String(payload.nativeControl.value);hydrate();result('controls','confirmed','Camera setting updated.')}
}}
function choose(value){
 if(value.startsWith('RTSP ')){
  report.policy.stream.mode='adaptive';report.policy.stream.floor_kbps=400;report.policy.stream.ceiling_kbps=4000
  report.outputs=[{kind:'rtsp',label:'RTSP',enabled:true,costKbps:2000,reach:{reachable:true,note:'Fixture connection'}}]
  const waiting=value==='RTSP waiting',unavailable=value==='RTSP unavailable',congested=value==='RTSP congestion'
  report.runtime.streamKbps=congested?700:1000
  report.runtime.streamDecision={reason:unavailable?'No fresh delivery feedback; holding the encoder target.':waiting?'No receiver feedback for this output; its bitrate is held.':congested?'RTSP delivery is congested: receiver loss or queued/discarded video. Requesting 700 kb/s.':'Receiver delivery is healthy; probing within 400–4000 kb/s.'}
  report.runtime.rtspFeedback={status:unavailable?'unavailable':waiting?'waiting':'active',message:unavailable?'RTSP feedback is unavailable. Adaptive cannot evaluate this connection.':waiting?'Waiting for an RTSP player to receive video.':'RTSP feedback is active for 1 receiver(s).',readers:waiting?0:1,freshReaders:waiting||unavailable?0:1,loss:congested?0.02:0,queuedMs:congested?900:20,discarded:congested?18:0,deliveredKbps:congested?600:1100}
 }
 scenario.value=value;auth=value!=='Expired session';document.documentElement.removeAttribute('data-yonder-camera-auth');report.run.state={Stopped:'stopped',Starting:'starting',Failed:'failed'}[value]||'running';report.startBlocked=value==='Camera unavailable'?'Connect and power on the camera, then refresh its status.':null;if(value==='Camera unavailable')report.run.state='stopped';epoch.value++;hydrate();if(!auth)expireCameraSession()}
hydrate()
const app=createApp({setup:()=>()=>h('main',{id:'nrdb-page-page-camera'},[
 h('section',{class:'fixture-tools'},[h('strong','Camera workflow fixture'),h('span','No real device connections'),h('label',['Scenario ',h('select',{'aria-label':'Scenario',value:scenario.value,onChange:e=>choose(e.target.value)},['Running','Stopped','Starting','Failed','Unavailable','Camera unavailable','Expired session','No camera','RTSP active','RTSP waiting','RTSP unavailable','RTSP congestion'].map(value=>h('option',value)))]),h('label',['Theme ',h('select',{'aria-label':'Theme',value:theme.value,onChange:e=>{theme.value=e.target.value;document.querySelector('#theme').href=`/theme.${theme.value}.css`}},['day','night'].map(value=>h('option',value)))]),h('label',[h('input',{type:'checkbox',checked:reject.value,onChange:e=>{reject.value=e.target.checked}}),' Reject next Apply'])]),
 h('div',{class:'fixture-grid',key:epoch.value},[h('section',{class:'fixture-picture'},[h(Picture,{id:'picture',props:{path:'cam3-preview'}})]),h('section',[h(Aim,{id:'aim',props:{}})])]),h('section',{class:'fixture-deck',key:'deck-'+epoch.value},[h(Deck,{id:'deck',props:{}})]),h('p',{role:'status'},activity.value)
])})
app.provide('$socket',socket);app.provide('$dataTracker',()=>{});app.config.globalProperties.$store=store;app.mount('#app')
document.addEventListener('click',event=>{const link=event.target.closest('a');if(link?.getAttribute('href')?.startsWith('/login?')){event.preventDefault();choose('Running')}})
const style=document.createElement('style');style.textContent=`body{margin:0;background:var(--yonder-background,#eeead9);color:var(--yonder-value,#243e50);font-family:system-ui}main{max-width:1440px;margin:auto;padding:16px}.fixture-tools{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:14px}.fixture-tools label{font-size:13px}.fixture-grid{display:grid;grid-template-columns:minmax(0,3fr) minmax(260px,1fr);gap:14px}.fixture-grid>section,.fixture-deck{border:1px solid var(--yonder-divider);background:var(--yonder-pane);padding:12px;min-width:0}.fixture-picture .y-pic{grid-template-rows:auto auto minmax(34px,auto) 80px;height:auto!important;min-height:0}.fixture-picture .y-pic__fit{container-type:normal;display:block}.fixture-picture .y-pic__fit,.fixture-picture .y-pic__frame{height:auto!important;max-height:none;width:100%}.fixture-deck{margin-top:14px}@media(max-width:760px){main{padding:8px}.fixture-grid{grid-template-columns:1fr}.fixture-tools{gap:10px}}`;document.head.appendChild(style)
