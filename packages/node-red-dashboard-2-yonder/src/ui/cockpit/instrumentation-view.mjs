// SPDX-License-Identifier: GPL-3.0-or-later
// R-FLT-23/24: display-only telemetry catalog and explicit navigation estimates.
import {agedTelemetry,aircraftMission,bearing,distance,validPosition} from './cockpit-state.mjs';
import {isPositionItem} from './mission-import.mjs';
import {toDisplay,unitLabels,units} from './flight-units.mjs';
const finite=Number.isFinite;
export const instrumentCategories=['Navigation','Flight time','Electrical','Propulsion','Navigation health','Terrain','Aircraft state','Controller health','Fence & alerts','Links & controls','Payload','Yonder system'];
const groups={battery:'Electrical',esc:'Propulsion',efi:'Propulsion',generator:'Propulsion',gps:'Navigation health',ekf:'Navigation health',vibration:'Controller health',rangefinder:'Terrain',terrain:'Terrain',fence:'Fence & alerts',fc:'Controller health',rc:'Links & controls',servo:'Links & controls',radio:'Links & controls',camera:'Payload',gimbal:'Payload',host:'Yonder system',modem:'Links & controls',media:'Payload',flight:'Aircraft state'};
const suffixNames={voltageV:'Voltage',currentA:'Current',remainingPercent:'Remaining',consumedMah:'Charge used',consumedWh:'Energy used',temperatureC:'Temperature',remainingSeconds:'Time remaining',chargeState:'Charge state',faultFlags:'Fault flags',cpuPercent:'CPU utilisation',loadPercent:'Load',bootSeconds:'Power-on time',armedSeconds:'Observed armed total',airborneSeconds:'Observed airborne total',autoSeconds:'Observed AUTO execution total',landedState:'Landed state',vtolState:'VTOL state',rsrpDbm:'Cellular RSRP',rsrqDb:'Cellular RSRQ',sinrDb:'Modem SNR',rssiDbm:'Radio signal',memoryPercent:'Memory used',memoryFreeBytes:'Free memory',memoryAvailableBytes:'Available memory',memoryTotalBytes:'Total memory',storageFreeBytes:'Free storage',uptimeSeconds:'Uptime',reportedRpm:'Reported RPM',rpm:'RPM',fixType:'Fix',satellites:'Satellites',horizontalAccuracyM:'Horizontal accuracy',verticalAccuracyM:'Vertical accuracy',clippingCount:'Clipping count',breached:'Fence breached',boardVoltageV:'Board voltage',servoVoltageV:'Servo voltage',heightM:'Terrain elevation',clearanceM:'Terrain clearance',distanceM:'Distance',recordingSeconds:'Recording time',recordingRemainingSeconds:'Recording time remaining'};
const humanize=s=>String(s).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/[_-]/g,' ').replace(/^./,c=>c.toUpperCase());
export function formatDuration(seconds){
 if(!finite(seconds)||seconds<0)return '—';
 const n=Math.floor(seconds),h=Math.floor(n/3600),m=Math.floor(n%3600/60),s=n%60;
 return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
export function rescaleInstrumentSlots(slots,previousItems,currentItems){
 const factors={FT:.3048,M:1,KT:1852/3600,MPH:.44704,'m/s':1,NM:1852,MI:1609.344,KM:1000};
 const before=new Map(previousItems.map(i=>[i.id,i.unit])),after=new Map(currentItems.map(i=>[i.id,i.unit]));
 return slots.map(slot=>{
  const a=before.get(slot.id),b=after.get(slot.id);if(!slot.id.startsWith('nav.')||a===b||!factors[a]||!factors[b])return slot;
  const ratio=factors[a]/factors[b];return {...slot,...(finite(slot.min)?{min:slot.min*ratio}:{}),...(finite(slot.max)?{max:slot.max*ratio}:{}),...(slot.bands?{bands:slot.bands.map(band=>({...band,from:band.from*ratio,to:band.to*ratio}))}:{})};
 });
}
function meta(id,reading={}){
 const parts=id.split('.'),group=parts[0],suffix=parts.at(-1),peripheral=parts.find(p=>/^c\d+$/.test(p)),instance=parts.slice(1,-1).filter(p=>!/^c\d+$/.test(p)).join(' ');
 const title=suffixNames[suffix]||humanize(suffix);
 let prefix=({battery:'Battery',esc:'ESC',efi:'Engine',gps:'GPS',rangefinder:'Rangefinder',camera:'Camera',gimbal:'Gimbal',host:'Yonder',modem:'Aircraft modem',media:'Media',fc:'Flight controller'})[group]||humanize(group);
 if(instance==='system')prefix+=' Summary';else if(instance)prefix+=' '+(/^\d+$/.test(instance)?Number(instance)+1:humanize(instance));
 if(peripheral)prefix+=` (component ${peripheral.slice(1)})`;
 const unit=reading.unit||'', timer=/Seconds$/.test(suffix), category=timer&&group==='flight'?'Flight time':groups[group]||'Aircraft state';
 let kind=typeof reading.value==='boolean'||typeof reading.value==='string'||/State$|Flags$|^flags$|^recording$|^breached$/.test(suffix)?'status':timer?'timer':'number';
 let min,max;
 if(unit==='%'){min=0;max=100;kind='horizontal'}
 if(/cpuPercent|loadPercent|^currentA$|^rpm$|^electricalRpm$/.test(suffix))kind='arc';
 if(/temperatureC$/.test(suffix)){kind='vertical';min=0;max=100}
 if(unit==='dBm'){kind='horizontal';min=-125;max=-65}
 if(unit==='A'){min=0;max=100}
 if(/rpm/i.test(suffix)){min=0;max=10000}
 if(suffix==='consumedMah'){kind='horizontal';min=0;max=10000}
 const short=group==='battery'?({remainingPercent:`BATT ${instance==='system'?'SUM':Number(instance)+1||instance}`,voltageV:'BUS VOLTS',currentA:'CURRENT',consumedMah:'CHARGE USED',consumedWh:'ENERGY USED'})[suffix]:({cpuPercent:'YONDER CPU',rsrpDbm:'CELL SIGNAL',temperatureC:group==='host'?'BOARD TEMP':undefined,airborneSeconds:'AIRBORNE OBS',armedSeconds:'ARMED OBS',autoSeconds:'AUTO OBS',bootSeconds:'POWER ON'})[suffix];
 return {id,label:`${prefix} ${title}`,shortLabel:short||title.toUpperCase(),category,kind,min,max,bands:[]};
}
function item(id,label,value,unit='',extra={}){const available=value!==null&&value!==undefined&&(typeof value!=='number'||finite(value));return {id,label,shortLabel:label.toUpperCase(),value:available?value:null,unit,available,category:'Navigation',kind:'number',source:'Calculated in browser',ageMs:0,quality:'calculated',reason:available?'':'Required telemetry unavailable',...extra};}
export function homeNavigation(snapshot={},elapsedMs=0){
 const t=agedTelemetry(snapshot.telemetry||{},elapsedMs),position={lat:t.latitude,lon:t.longitude},home=t.homePosition;
 const valid=snapshot.connected===true&&validPosition(position)&&validPosition(home)&&elapsedMs<2000;
 const d=valid?distance(position,home):null,b=d!==null&&d>=1?bearing(position,home):null;
 return {distanceM:d,bearingDeg:b,relativeDeg:b!==null&&finite(t.headingDeg)?((b-t.headingDeg+540)%360)-180:null,source:'GLOBAL_POSITION_INT + HOME_POSITION',reason:d===null?'Fresh aircraft and reported home positions required':b===null?'At home; bearing undefined':'Direct surface distance and true bearing to reported home; not the RTL route'};
}
export function navigationItems(snapshot={},guidance={},terrain={},options={},elapsedMs=0){
 const t=agedTelemetry(snapshot.telemetry||{},elapsedMs),home=homeNavigation(snapshot,elapsedMs),u=units(options),online=snapshot.connected===true&&elapsedMs<2000;
 const distanceUnit=['nm','mi','km'].includes(options.distanceUnit)?options.distanceUnit:'nm',factor={nm:1/1852,mi:1/1609.344,km:1/1000}[distanceUnit],du=distanceUnit.toUpperCase();
 const nav=online&&guidance.valid===true,seq=nav?(guidance.targetName?.replace(/^WP(\d+)$/,(_,n)=>'WP'+n.padStart(2,'0')))||(guidance.seq!==null&&guidance.seq!==undefined?`WP${String(guidance.seq).padStart(2,'0')}`:null):null;
 const ete=nav&&finite(guidance.eteSeconds)&&guidance.eteSeconds>=0?guidance.eteSeconds:null;
 const official=terrain.officialTerrain,agl=online&&t.ready&&official?.available===true&&finite(official.estimatedAglM)?toDisplay(official.estimatedAglM,u.altitudeUnit):null;
 const remaining=remainingPlanDistance(snapshot,guidance),trail=snapshot.ownTrail,recorded=online&&finite(trail?.tail?.[4])?trail.tail[4]:null;
 const output=[
  item('nav.activeWaypoint','Waypoint',seq,'',{kind:'status',shortLabel:'WPT',source:'Reported active mission / target',quality:'reported',reason:nav?'':guidance.reason||'Current guidance unavailable'}),
  item('nav.distance','Waypoint distance',nav&&finite(guidance.distanceM)?guidance.distanceM*factor:null,du,{shortLabel:'DIST',source:guidance.guidanceSource||'Position and active target'}),
  item('nav.ete','Waypoint ETE',ete,'s',{shortLabel:'ETE',kind:'timer',displayValue:formatDuration(ete),reason:ete===null?'Current progress unavailable':'Estimate from present motion; not turn anticipation or autopilot intent'}),
  item('nav.agl','Estimated terrain AGL',agl,unitLabels[u.altitudeUnit],{shortLabel:'AGL',source:agl===null?'Official terrain service':`${official.provider} · ${official.datum} · ${official.spacingM} m`,reason:agl===null?(official?.reason||'Fresh official terrain and GLOBAL_POSITION_INT MSL altitude required'):'Estimated from authenticated official MSL terrain at the aircraft coordinate'}),
  item('nav.groundspeed','Ground speed',online&&finite(t.groundspeedKt)?toDisplay(t.groundspeedKt*1852/3600,u.speedUnit):null,unitLabels[u.speedUnit],{shortLabel:'GS',source:'VFR_HUD',quality:'reported'}),
  item('nav.desiredTrack','Desired track',nav&&finite(guidance.desiredTrackDeg)?guidance.desiredTrackDeg:null,'°T',{shortLabel:'DTK',kind:'bearing',source:'Verified active leg geometry'}),
  item('nav.crossTrack','Lateral deviation',nav&&finite(guidance.crossTrackM)?toDisplay(guidance.crossTrackM,u.altitudeUnit):null,unitLabels[u.altitudeUnit],{shortLabel:'XTK',source:'NAV_CONTROLLER_OUTPUT',quality:'reported'}),
  item('nav.homeDistance','Home distance',home.distanceM!==null?home.distanceM*factor:null,du,{shortLabel:'HOME DIST',source:home.source,reason:home.reason}),
  item('nav.homeBearing','Home bearing',home.bearingDeg,'°T',{shortLabel:'HOME BRG',kind:'bearing',source:home.source,reason:home.reason}),
  item('nav.homeRelative','Home relative direction',home.relativeDeg,'° REL',{shortLabel:'HOME DIR',kind:'bearing',source:home.source,reason:home.reason}),
  item('nav.aboveHome','Height above home',online&&finite(t.relativeAltitudeM)?toDisplay(t.relativeAltitudeM,u.altitudeUnit):null,unitLabels[u.altitudeUnit],{shortLabel:'REL ALT',source:'GLOBAL_POSITION_INT',quality:'reported'}),
  item('nav.remainingDistance','Remaining planned distance',nav&&remaining!==null?remaining*factor:null,du,{shortLabel:'PLAN REM',reason:remaining===null?'Unresolved loiter, return, jump or active geometry':'Straight planned legs; excludes actual turns, climb path and landing maneuver'}),
  item('nav.recordedDistance','Recorded ground-track distance',recorded===null?null:recorded*factor,du,{shortLabel:'TRACK DIST',quality:'partial',source:'Recorded position trail',reason:'Observed ground-track distance only; history can start after takeoff or contain gaps'}),
  item('nav.airspeed','Indicated airspeed',online&&finite(t.airspeedKt)?toDisplay(t.airspeedKt*1852/3600,u.speedUnit):null,unitLabels[u.speedUnit],{shortLabel:'IAS',source:'VFR_HUD',quality:'reported'}),
  item('flight.mode','Flight mode',online?t.mode:null,'',{category:'Aircraft state',kind:'status',source:'HEARTBEAT',quality:'reported'}),
  item('flight.armed','Armed state',online?t.armed:null,'',{category:'Aircraft state',kind:'status',source:'HEARTBEAT',quality:'reported',displayValue:t.armed===true?'ARMED':t.armed===false?'DISARMED':'—'}),
  item('link.telemetryAgeSeconds','Flight telemetry age',snapshot.connected&&finite(elapsedMs)?(elapsedMs+Math.max(0,t.ageMs||0))/1000:null,'s',{shortLabel:'FLIGHT LINK',displayValue:snapshot.connected?((elapsedMs+Math.max(0,t.ageMs||0))/1000).toFixed(1):'—',category:'Links & controls',kind:'horizontal',min:0,max:5,source:'Received flight telemetry',reason:'Age of last flight update; independent of modem signal'})
 ];
 const dependencies={
  'nav.distance':['latitude','longitude'],'nav.ete':['latitude','longitude','groundspeedKt'],
  'nav.agl':['latitude','longitude',finite(t.globalAltitudeM)?'globalAltitudeM':finite(t.gpsAltitudeM)?'gpsAltitudeM':'altitudeFt'],'nav.groundspeed':['groundspeedKt'],
  'nav.homeDistance':['latitude','longitude'],'nav.homeBearing':['latitude','longitude'],
  'nav.homeRelative':['latitude','longitude','headingDeg'],'nav.aboveHome':['relativeAltitudeM'],
  'nav.remainingDistance':['latitude','longitude'],'nav.airspeed':['airspeedKt'],
  'flight.mode':['mode'],'flight.armed':['armed']
 };
 const original=snapshot.telemetry||{},metadata=original.fields||{};
 return output.map(row=>{
  const keys=dependencies[row.id];let ageMs=null,source=row.source;
  if(keys){const ages=keys.map(key=>finite(metadata[key]?.ageMs)?metadata[key].ageMs+elapsedMs:finite(original.ageMs)?original.ageMs+elapsedMs:null);ageMs=ages.every(finite)?Math.max(...ages):null;const names=[...new Set(keys.map(key=>metadata[key]?.source||original.source).filter(Boolean))];if(names.length)source=row.quality==='reported'?names.join(' + '):row.source+' · '+names.join(' + ')}
  if(original.mode==='GUIDED'&&['nav.distance','nav.ete'].includes(row.id)){ageMs=ageMs!==null&&finite(original.positionTarget?.ageMs)?Math.max(ageMs,original.positionTarget.ageMs+elapsedMs):null;source+=' + POSITION_TARGET_GLOBAL_INT'}
  if(row.id==='nav.crossTrack'&&finite(original.navController?.ageMs))ageMs=original.navController.ageMs+elapsedMs;
  if(row.id==='nav.recordedDistance'&&finite(trail?.clockAt)&&finite(snapshot.at))ageMs=Math.max(0,snapshot.at-trail.clockAt)+elapsedMs;
  if(row.id==='link.telemetryAgeSeconds')ageMs=finite(original.ageMs)?original.ageMs+elapsedMs:null;
  return {...row,ageMs,source};
 });
}
export function remainingPlanDistance(snapshot,guidance){
 if(!snapshot.connected||snapshot.telemetry?.mode!=='AUTO'||!snapshot.mission?.currentFresh||snapshot.mission?.synchronization!=='verified'||!guidance.valid||!finite(guidance.distanceM))return null;
 const list=aircraftMission(snapshot).items,index=list.findIndex(i=>i.seq===snapshot.mission.currentSeq);if(index<0)return null;
 let total=guidance.distanceM,previous=null;
 for(const item of list.slice(index)){
  if([17,18,19,20,31,82,177,601].includes(item.command))return null;
  if(!isPositionItem(item)){if([16,21,22,84,85].includes(item.command))return null;continue}
  if(previous){const length=distance(previous,item);if(length===null)return null;total+=length}previous=item;
 }
 return previous?total:null;
}
export function instrumentationItems(snapshot={},instrumentation={},options={}){
 const elapsed=Math.max(0,options.elapsedMs||0),same=instrumentation.generation===(snapshot.identity?.generation??null),fields=instrumentation.fields||{};
 return Object.entries(fields).map(([id,r])=>{
  const host=/^(host|modem|media)\./.test(id),age=finite(r.ageMs)?r.ageMs+elapsed:null,ttl=finite(r.ttlMs)&&r.ttlMs>0?r.ttlMs:5000;
  const context=host||(same&&snapshot.connected===true&&instrumentation.connected===true),available=context&&age!==null&&age<ttl&&r.quality!=='unavailable'&&r.value!==null&&r.value!==undefined&&(typeof r.value!=='number'||finite(r.value));
  const metadata=meta(id,r),value=available?r.value:null;
  const result={...metadata,value,unit:r.unit||'',available,source:r.source||'Source unavailable',ageMs:age,quality:r.quality||'reported',reason:!context?'Aircraft connection or generation changed':!available?r.reason||(age!==null&&age>=ttl?'Sample expired':'Not reported'):r.reason||''};
  if(metadata.kind==='timer')result.displayValue=formatDuration(value)+(available&&r.quality==='partial'?'*':'');
  if(id.endsWith('fixType'))result.displayValue=({0:'NO FIX',1:'NO FIX',2:'2D',3:'3D',4:'DGPS',5:'RTK FLOAT',6:'RTK FIXED',7:'STATIC',8:'PPP'})[value]??String(value??'—');
  if(id.endsWith('chargeState'))result.displayValue=({0:'UNDEFINED',1:'OK',2:'LOW',3:'CRITICAL',4:'EMERGENCY',5:'FAILED',6:'UNHEALTHY',7:'CHARGING'})[value]??String(value??'—');
  const related=id.endsWith('.remainingPercent')?id.replace('remainingPercent','voltageV'):id.endsWith('.currentA')?id.replace('currentA','voltageV'):id.endsWith('.consumedMah')?id.replace('consumedMah','consumedWh'):id==='host.cpuPercent'?'host.temperatureC':id==='modem.rsrpDbm'?'modem.sinrDb':null;
  const companion=related&&fields[related],companionFresh=companion&&finite(companion.ageMs)&&companion.ageMs+elapsed<companion.ttlMs&&finite(companion.value)&&companion.quality!=='unavailable';
  if(available&&companionFresh)result.secondary=id.endsWith('.currentA')?`${Math.round(value*companion.value)} W`:`${companion.value.toLocaleString('en-US',{maximumFractionDigits:1})} ${companion.unit}`;
  return result;
 });
}
export function missingInstrumentItems(items){
 const defaults=[['battery.0.remainingPercent','Battery 1 remaining','Electrical','%','horizontal'],['battery.0.currentA','Battery 1 current','Electrical','A','arc'],['battery.0.consumedMah','Battery 1 charge used','Electrical','mAh','horizontal'],['modem.rsrpDbm','Aircraft LTE signal','Links & controls','dBm','horizontal'],['host.cpuPercent','Yonder CPU utilisation','Yonder system','%','arc'],['flight.airborneSeconds','Airborne time','Flight time','s','timer'],
 ['flight.autoSeconds','Observed AUTO execution total','Flight time','s','timer'],['flight.bootSeconds','Power-on time','Flight time','s','timer'],['flight.armedSeconds','Armed time','Flight time','s','timer'],
 ['esc.rpmSensor0.rpm','Reported RPM','Propulsion','rpm','arc'],['gps.0.fixType','GPS 1 fix','Navigation health','','status'],['ekf.report.flags','Estimator status','Navigation health','','status'],
 ['rangefinder.0.distanceM','Rangefinder 1 distance','Terrain','m','vertical'],['flight.vtolState','VTOL state','Aircraft state','','status'],['fc.loadPercent','Flight-controller load','Controller health','%','horizontal'],
 ['fence.breached','Fence state','Fence & alerts','','status'],['rc.rssi','RC signal','Links & controls','raw','number'],['camera.0.recording','Camera recording','Payload','','status']];
 const keys=new Set(items.map(i=>i.id));return defaults.filter(([id])=>!keys.has(id)).map(([id,label,category,unit,kind])=>item(id,label,null,unit,{category,kind,source:'Not received',quality:'unavailable',reason:'Request aircraft telemetry or connect the corresponding sensor/source',...meta(id,{unit})}));
}
export function gimbalOrientationItems(items){
 const lookup=new Map(items.map(i=>[i.id,i])),prefixes=items.filter(i=>/^gimbal\..*\.quaternionW$/.test(i.id)).map(i=>i.id.replace(/quaternionW$/,'')),result=[];
 for(const prefix of prefixes){
  const rows=['quaternionW','quaternionX','quaternionY','quaternionZ','flags'].map(k=>lookup.get(prefix+k));
  const fresh=rows.every(r=>r?.available&&finite(r.value))&&new Set(rows.map(r=>r.source)).size===1;
  const flags=fresh?rows[4].value:0,vehicle=!!(flags&32),earth=!!(flags&64),frame=fresh&&!(vehicle&&earth)?(earth||(!vehicle&&(flags&16))?'true north':'vehicle heading'):null;
  const q=rows.slice(0,4).map(r=>r?.value),norm=Math.hypot(...q),valid=!!frame&&finite(norm)&&Math.abs(norm-1)<.02;
  let angles=[null,null,null];
  if(valid){const [w,x,y,z]=q.map(v=>v/norm);angles=[Math.atan2(2*(w*x+y*z),1-2*(x*x+y*y)),Math.asin(Math.max(-1,Math.min(1,2*(w*y-z*x)))),Math.atan2(2*(w*z+x*y),1-2*(y*y+z*z))].map(v=>v*180/Math.PI);if(frame==='true north')angles[2]=(angles[2]+360)%360}
  for(const [index,name] of ['roll','pitch','yaw'].entries())result.push(item(prefix+name+'Deg',`Gimbal ${prefix.split('.').slice(1,-1).join(' ')} ${name}`,angles[index],name==='yaw'?(frame==='true north'?'°T':'° REL'):'°',{category:'Payload',kind:name==='yaw'?'bearing':'number',source:rows[0]?.source||'GIMBAL_DEVICE_ATTITUDE_STATUS',ageMs:Math.max(0,...rows.map(r=>r?.ageMs||0)),quality:valid?'calculated':'unavailable',reason:valid?`Euler orientation in reported ${frame} frame; not a camera calibration or pointing command`:'Fresh normalized attitude and a valid reported frame are required'}));
 }
 return result;
}
export function fenceStatusItems(items){
 const values=['fc.sensorsPresent','fc.sensorsEnabled','fc.sensorsHealthy'].map(id=>items.find(i=>i.id===id)),known=values.every(v=>v?.available&&finite(v.value)),bit=1048576;
 const enabled=known?!!(values[0].value&values[1].value&bit):null,healthy=known&&enabled?!!(values[2].value&bit):null;
 const ageMs=known&&values.every(v=>finite(v.ageMs))?Math.max(...values.map(v=>v.ageMs)):null,source=known?[...new Set(values.map(v=>v.source))].join(' + '):'SYS_STATUS geofence flags';
 return [item('fence.enabled','Fence enabled',enabled,'',{category:'Fence & alerts',kind:'status',source,ageMs,quality:known?'reported':'unavailable',reason:'Reported geofence present/enabled flags'}),item('fence.healthy','Fence health',healthy,'',{category:'Fence & alerts',kind:'status',source,ageMs,quality:healthy===null?'unavailable':'reported',reason:enabled?'Reported enabled geofence health':'Fence is not reported enabled'})];
}
export function instrumentationAlerts(items,snapshot={}){
 const alerts=[];
 const health=Object.fromEntries(items.filter(i=>i.available&&['fc.sensorsPresent','fc.sensorsEnabled','fc.sensorsHealthy'].includes(i.id)).map(i=>[i.id,i]));
 if(Object.keys(health).length===3){const mask=(health['fc.sensorsPresent'].value&health['fc.sensorsEnabled'].value)&~health['fc.sensorsHealthy'].value;if(mask)alerts.push({id:'fc.sensorsHealthy',label:'SENSOR HEALTH',level:'caution',reason:`Reported unhealthy enabled sensors: 0x${(mask>>>0).toString(16)}`})}
 for(const i of items){if(!i.available)continue;
  if(i.id==='fence.breached'&&i.value===true)alerts.push({id:i.id,label:'FENCE BREACH',level:'warning',reason:i.source});
  if(/\.chargeState$/.test(i.id)&&[2,3,4,5,6].includes(i.value))alerts.push({id:i.id,label:i.label.replace(/Charge state$/,'')+i.displayValue,level:i.value===2?'caution':'warning',reason:i.source});
  if(i.id==='flight.vtolState'&&/transition/i.test(String(i.value)))alerts.push({id:i.id,label:String(i.value),level:'advisory',reason:'Reported VTOL state'});
 }
 const latest=(snapshot.statustext||[]).filter(t=>t.severity<=4&&Number.isFinite(t.at)&&snapshot.at-t.at<30000).slice(-3);
 for(const t of latest)alerts.push({id:`status.${t.at}`,label:t.text,level:t.severity<=3?'warning':'caution',reason:'Aircraft status message'});
 return alerts.slice(0,6);
}
