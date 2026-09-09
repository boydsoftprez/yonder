import {describe,it,expect} from 'vitest';
const mod=await import('./instrumentation-view.mjs').catch(()=>null);
const snapshot=(patch={})=>({at:1000,identity:{generation:'a'},connected:true,telemetry:{ready:true,mode:'AUTO',latitude:0,longitude:0,headingDeg:60,groundspeedKt:40,altitudeFt:1000,relativeAltitudeM:80,homePosition:{lat:0,lon:.01,alt:220},fields:{}},mission:{items:[],synchronization:'verified',currentFresh:true,currentSeq:1},...patch});
describe('cockpit instrument view adapter',()=>{
 it('calculates a true home bearing and surface distance, independently of an active mission',()=>{
  expect(mod).not.toBeNull();const home=mod!.homeNavigation(snapshot());expect(home.distanceM).toBeCloseTo(1111.949,2);expect(home.bearingDeg).toBeCloseTo(90);expect(home.relativeDeg).toBeCloseTo(30);expect(home.source).toContain('HOME_POSITION');
 });
 it('removes home direction when heading or position is stale, and does not point arbitrarily when at home',()=>{
  const s=snapshot();s.telemetry.homePosition.lon=0;expect(mod!.homeNavigation(s).bearingDeg).toBeNull();
  s.telemetry.homePosition.lon=.01;s.telemetry.fields={latitude:{valid:true,ageMs:2200}} as any;expect(mod!.homeNavigation(s).distanceM).toBeNull();
  expect(mod!.homeNavigation(snapshot({connected:false})).distanceM).toBeNull();
 });
 it('expires readings by sample age and rejects a previous aircraft generation while keeping independent host readings',()=>{
  const field={value:42,unit:'%',source:'MAVLink SYS_STATUS 1.1',ageMs:100,ttlMs:1000,quality:'reported'};
  const source={at:1000,generation:'b',connected:true,fields:{'fc.loadPercent':field,'host.cpuPercent':{...field,source:'Companion CPU'}}};
  const items=mod!.instrumentationItems(snapshot(),source,{elapsedMs:0});expect(items.find(x=>x.id==='fc.loadPercent')?.available).toBe(false);expect(items.find(x=>x.id==='host.cpuPercent')?.value).toBe(42);
  expect(mod!.instrumentationItems(snapshot(),source,{elapsedMs:950}).find(x=>x.id==='host.cpuPercent')?.available).toBe(false);
 });
 it('keeps primary battery instances distinct from SYS_STATUS aggregate and labels partial flight counters',()=>{
  const field={value:15.6,unit:'V',source:'MAVLink 1.1',ageMs:0,ttlMs:5000,quality:'reported'};
  const items=mod!.instrumentationItems(snapshot(),{generation:'a',connected:true,fields:{'battery.0.voltageV':field,'battery.system.voltageV':{...field,value:24},'flight.airborneSeconds':{...field,value:90,unit:'s',quality:'partial',reason:'Takeoff was not observed'}}});
  expect(items.find(x=>x.id==='battery.0.voltageV')?.value).toBe(15.6);expect(items.find(x=>x.id==='battery.system.voltageV')?.label).toContain('Summary');expect(items.find(x=>x.id==='flight.airborneSeconds')?.displayValue).toContain('*');
 });
 it('formats selected distance and flight units without confusing planned ETE with autopilot capture',()=>{
  const items=mod!.navigationItems(snapshot(),{valid:true,seq:3,distanceM:1852,eteSeconds:125,desiredTrackDeg:95},{state:'ready',estimatedAglM:91.44},{distanceUnit:'mi',speedUnit:'mph',altitudeUnit:'ft'});
  expect(items.find(x=>x.id==='nav.distance')?.value).toBeCloseTo(1.15078,4);expect(items.find(x=>x.id==='nav.ete')?.displayValue).toBe('02:05');expect(items.find(x=>x.id==='nav.agl')?.value).toBeCloseTo(300);expect(items.find(x=>x.id==='nav.groundspeed')?.unit).toBe('MPH');
 });
});

it('leaves remaining route distance unavailable for loiter/jump geometry and reports health faults regardless of pinned fields',()=>{
 const s=snapshot();s.mission.items=[{seq:0,command:16,frame:0,x:0,y:0,z:0},{seq:1,command:16,frame:3,x:0,y:.01,z:100},{seq:2,command:17,frame:3,x:0,y:.02,z:100}] as any;
 const rows=mod!.navigationItems(s,{valid:true,seq:1,distanceM:1112,eteSeconds:120},{},{});expect(rows.find(i=>i.id==='nav.remainingDistance')?.available).toBe(false);s.mission.items[2].command=16;expect(mod!.remainingPlanDistance(s,{valid:true,distanceM:1112})).toBeCloseTo(2223.949,2);
 const make=(id,value)=>({id,value,available:true,source:'SYS_STATUS'});
 const alerts=mod!.instrumentationAlerts([make('fc.sensorsPresent',7),make('fc.sensorsEnabled',7),make('fc.sensorsHealthy',5)],s);
 expect(alerts.some(a=>a.id==='fc.sensorsHealthy')).toBe(true);
});
it('preserves physical display limits when navigation units change',()=>{
 const slots=[{id:'nav.airspeed',kind:'arc',min:0,max:60,bands:[{from:40,to:60,color:'normal'}]}];
 const changed=mod!.rescaleInstrumentSlots(slots,[{id:'nav.airspeed',unit:'KT'}],[{id:'nav.airspeed',unit:'MPH'}]);
 expect(changed[0].max).toBeCloseTo(69.04677,4);expect(changed[0].bands[0].from).toBeCloseTo(46.03118,4);expect(slots[0].max).toBe(60);
});
it('derives gimbal orientation only in the reported frame and refuses contradictory frame flags',()=>{
 const values={flags:64,quaternionW:Math.SQRT1_2,quaternionX:0,quaternionY:0,quaternionZ:Math.SQRT1_2};
 const items=Object.entries(values).map(([key,value])=>({id:'gimbal.1.'+key,value,available:true,source:'GIMBAL_DEVICE_ATTITUDE_STATUS 1.154',ageMs:0}));
 const earth=mod!.gimbalOrientationItems(items).find(i=>i.id==='gimbal.1.yawDeg');expect(earth.value).toBeCloseTo(90);expect(earth.unit).toBe('°T');
 items[0].value=32;expect(mod!.gimbalOrientationItems(items).find(i=>i.id==='gimbal.1.yawDeg').unit).toBe('° REL');
 items[0].value=96;expect(mod!.gimbalOrientationItems(items).every(i=>!i.available)).toBe(true);
});
it('preserves source age and identity for scalar and calculated navigation readings',()=>{
 const s=snapshot();s.telemetry.fields={airspeedKt:{valid:true,ageMs:1300,source:'VFR_HUD 1.1'},groundspeedKt:{valid:true,ageMs:1300,source:'VFR_HUD 1.1'},latitude:{valid:true,ageMs:1400,source:'GLOBAL_POSITION_INT 1.1'},longitude:{valid:true,ageMs:1500,source:'GLOBAL_POSITION_INT 1.1'}} as any;
 const rows=mod!.navigationItems(s,{valid:false},{},{},400);
 expect(rows.find(i=>i.id==='nav.groundspeed').ageMs).toBe(1700);expect(rows.find(i=>i.id==='nav.groundspeed').source).toBe('VFR_HUD 1.1');expect(rows.find(i=>i.id==='nav.homeDistance').ageMs).toBe(1900);
});
it('includes a GUIDED target age and the height source actually used for terrain in composite ages',()=>{
 const s=snapshot();s.telemetry.mode='GUIDED';s.telemetry.positionTarget={lat:0,lon:.01,ageMs:1700} as any;s.telemetry.gpsAltitudeM=409;s.telemetry.globalAltitudeM=undefined;
 s.telemetry.fields={latitude:{valid:true,ageMs:100,source:'GLOBAL_POSITION_INT'},longitude:{valid:true,ageMs:100,source:'GLOBAL_POSITION_INT'},groundspeedKt:{valid:true,ageMs:200,source:'VFR_HUD'},gpsAltitudeM:{valid:true,ageMs:1400,source:'GPS_RAW_INT'}} as any;
 const rows=mod!.navigationItems(s,{valid:true,guided:true,distanceM:1000,eteSeconds:60},{state:'ready',estimatedAglM:100},{},100);
 expect(rows.find(i=>i.id==='nav.distance').ageMs).toBe(1800);expect(rows.find(i=>i.id==='nav.ete').ageMs).toBe(1800);expect(rows.find(i=>i.id==='nav.agl').ageMs).toBe(1500);expect(rows.find(i=>i.id==='nav.agl').source).toContain('GPS_RAW_INT');
});
it('shows fence enablement from reported sensor flags without treating a disabled fence as unhealthy',()=>{
 const rows=['Present','Enabled','Healthy'].map(name=>({id:'fc.sensors'+name,value:1048576,available:true,source:'SYS_STATUS',ageMs:200}));
 expect(mod!.fenceStatusItems(rows).find(i=>i.id==='fence.enabled').value).toBe(true);rows[1].value=0;
 const off=mod!.fenceStatusItems(rows);expect(off.find(i=>i.id==='fence.enabled').value).toBe(false);expect(off.find(i=>i.id==='fence.healthy').available).toBe(false);
});
