// SPDX-License-Identifier: GPL-3.0-or-later
import { ardupilotmega as ap, common, minimal, standard } from 'node-mavlink';
import { FlightCounters } from './flight-counters.js';
import type { DecodedFrame } from './protocol.js';
import type { VehicleIdentity } from './types.js';
import type { InstrumentReading, InstrumentationSnapshot } from './instrumentation-types.js';
interface Sample { at:number; reading:InstrumentReading }
export const AIRCRAFT_INSTRUMENT_LIMIT = 450;
export const INSTRUMENT_TTL_MS = 5000;
const numeric=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const scaled=(v:unknown,scale=1,invalid:number[]=[]):number|null=>numeric(v)&&!invalid.includes(v)?v*scale:null;
const bounded=(v:unknown,min:number,max:number):number|null=>numeric(v)&&v>=min&&v<=max?v:null;
/** Selected-system instrumentation only. Command/mission admission remains in VehicleService. R-FLT-23/26. */
export class AircraftInstrumentation {
  private samples=new Map<string,Sample>();
  private counters=new FlightCounters();
  private truncated=false;
  private hardwareUid:string|null=null;
  private flightSwVersion:number|null=null;
  private instances=new Map<string,Set<string>>();
  select(_identity:VehicleIdentity,sameDevice:boolean):void {this.samples.clear();this.instances.clear();this.truncated=false;this.flightSwVersion=null;if(sameDevice)this.counters.gap();else {this.counters=new FlightCounters();this.hardwareUid=null;}}
  receive(frame:DecodedFrame,now:number,identity:VehicleIdentity):void {
    if(frame.system!==identity.system)return;
    const m=frame.data;
    const put=(key:string,value:InstrumentReading['value'],unit='',quality:InstrumentReading['quality']='reported',reason?:string)=>{
      const parts=key.split('.'),category=parts[0],instance=parts.length>2?parts.slice(1,-1).join('.'):'';
      const origin=`${frame.component}:${instance}`;
      const group=this.instances.get(category)??new Set<string>();
      if(!group.has(origin)&&group.size>=(category==='esc'?34:8)){this.truncated=true;return;}
      group.add(origin);this.instances.set(category,group);
      if(frame.component!==identity.component)parts.splice(1,0,`c${frame.component}`);
      key=parts.join('.');
      if(!this.samples.has(key)&&this.samples.size>=AIRCRAFT_INSTRUMENT_LIMIT-5){this.truncated=true;return;}
      this.samples.set(key,{at:now,reading:{value,unit,source:`${(m.constructor as unknown as {MSG_NAME:string}).MSG_NAME} · system ${frame.system} component ${frame.component}`,ageMs:0,ttlMs:INSTRUMENT_TTL_MS,quality:value===null?'unavailable':quality,...(value===null?{reason:reason??'Not reported or invalid in this message'}:reason?{reason}:{})}});
    };
    if(frame.component===identity.component){
      if(m instanceof standard.AutopilotVersion){
        const uid=m.uid2.some(value=>value!==0)?`uid2:${Buffer.from(m.uid2).toString('hex')}`:typeof m.uid==='bigint'&&m.uid>0n?String(m.uid):null;
        if(uid!==null){
          if(this.hardwareUid!==null&&this.hardwareUid!==uid){this.samples.clear();this.instances.clear();this.truncated=false;this.counters=new FlightCounters();}
          this.hardwareUid=uid;
        }
        this.flightSwVersion=m.flightSwVersion;
        put('fc.hardwareUid',uid);
      }
      if(m instanceof common.SystemTime||m instanceof common.GlobalPositionInt){
        if(this.counters.observeBoot(m.timeBootMs,(m.constructor as unknown as {MSG_NAME:string}).MSG_NAME,now)){this.samples.clear();this.instances.clear();}
      }
      if(m instanceof minimal.Heartbeat)this.counters.heartbeat(!!(m.baseMode&128),now,identity.autopilot===3&&identity.vehicleType===1?m.customMode===10:null);
      if(m instanceof common.ExtendedSysState)this.counters.landed(m.landedState,now);
    }
    if(m instanceof common.ExtendedSysState){
      const landed:Record<number,string>={1:'On ground',2:'In air',3:'Taking off',4:'Landing'},vtol:Record<number,string>={1:'Transition to fixed wing',2:'Transition to multicopter',3:'Multicopter',4:'Fixed wing'};
      put('flight.landedState',landed[m.landedState]??null);put('flight.vtolState',vtol[m.vtolState]??null);
    } else if(m instanceof common.BatteryStatus){
      const p=`battery.${m.id}.`,cells=m.voltages.slice(0,10).filter(v=>numeric(v)&&v>=0&&v<65535),extra=m.voltagesExt.slice(0,4).filter(v=>numeric(v)&&v>0&&v<65535);
      put(p+'voltageV',cells.length?[...cells,...extra].reduce((a,b)=>a+b,0)/1000:null,'V','calculated');
      put(p+'currentA',scaled(m.currentBattery,.01,[-1]),'A');put(p+'consumedMah',bounded(m.currentConsumed,0,2147483647),'mAh');
      put(p+'consumedWh',m.energyConsumed>=0?scaled(m.energyConsumed,1/36):null,'Wh');put(p+'remainingPercent',bounded(m.batteryRemaining,0,100),'%');
      put(p+'temperatureC',scaled(m.temperature,.01,[32767]),'°C');put(p+'remainingSeconds',m.timeRemaining>0?m.timeRemaining:null,'s');
      put(p+'chargeState',m.chargeState===0?null:m.chargeState);put(p+'mode',m.mode===0?null:m.mode);
      put(p+'faultFlags',[5,6].includes(m.chargeState)?m.faultBitmask:null,'bitmask');
      // BATTERY_STATUS overloads its base array: one voltage is an aggregate,
      // and 65534 marks overflow pack splitting. Neither identifies cells.
      const base=m.voltages.slice(0,10),extension=Array.from({length:4},(_,i)=>m.voltagesExt[i]??0);
      const baseEnd=base.indexOf(65535),baseCount=baseEnd<0?base.length:baseEnd;
      const extEnd=extension.indexOf(0),extCount=extEnd<0?4:extEnd;
      const baseValid=base.length===10&&base.every((v,i)=>Number.isInteger(v)&&v>=0&&(i<baseCount?v<65534:v===65535));
      const extValid=extension.every((v,i)=>Number.isInteger(v)&&v>=0&&v<=65535&&(i<extCount?v>0:v===0));
      const individual=baseValid&&extValid&&baseCount>=2&&(baseCount===10||extCount===0);
      const millivolts=individual?[...base.slice(0,baseCount),...extension.slice(0,extCount)]:[];
      const unavailable=base.includes(65534)?'Pack overflow encoding does not identify individual cells'
        :baseCount<2?'No unambiguous individual cells: a single voltage slot may be the pack total'
        :'Individual cell encoding is inconsistent or unavailable';
      const storedPrefix=frame.component===identity.component?p:`battery.c${frame.component}.${m.id}.`;
      for(let i=0;i<14;i++){
        const key=`cell${i+1}VoltageV`,value=millivolts[i],encodedZero=i>=10&&value===1;
        if(value!==undefined||this.samples.has(storedPrefix+key))put(p+key,value===undefined?null:value/1000,'V',encodedZero?'partial':'reported',value===undefined
          ?individual?'Cell absent from newer report':unavailable
          :encodedZero?'Reported extension value 1 mV may encode measured zero':undefined);
      }
      const quantizedZero=individual&&extension.slice(0,extCount).includes(1);
      const summaryReason=individual?(quantizedZero?'Extended cell 1 mV may encode measured zero; summary uses reported encoding':undefined):unavailable;
      const minimum=individual?Math.min(...millivolts):null,maximum=individual?Math.max(...millivolts):null;
      put(p+'cellMinVoltageV',minimum===null?null:minimum/1000,'V',quantizedZero?'partial':'calculated',summaryReason);
      put(p+'cellMaxVoltageV',maximum===null?null:maximum/1000,'V',quantizedZero?'partial':'calculated',summaryReason);
      put(p+'cellSpreadV',minimum===null||maximum===null?null:(maximum-minimum)/1000,'V',quantizedZero?'partial':'calculated',summaryReason);
    } else if(m instanceof common.SysStatus){
      put('battery.system.voltageV',scaled(m.voltageBattery,.001,[65535]),'V');put('battery.system.currentA',scaled(m.currentBattery,.01,[-1]),'A');put('battery.system.remainingPercent',bounded(m.batteryRemaining,0,100),'%');
      put('fc.loadPercent',m.load<=1000?m.load/10:null,'%');
      put('fc.sensorsPresent',m.onboardControlSensorsPresent,'bitmask');put('fc.sensorsEnabled',m.onboardControlSensorsEnabled,'bitmask');put('fc.sensorsHealthy',m.onboardControlSensorsHealth,'bitmask');
      put('fc.communicationDropPercent',scaled(m.dropRateComm,.01),'%');put('fc.communicationErrors',m.errorsComm,'count');
      for(let i=1;i<=4;i++)put(`fc.errorCount${i}`,(m as unknown as Record<string,number>)[`errorsCount${i}`],'count');
    } else if(m instanceof common.GpsRawInt||m instanceof common.Gps2Raw){
      const p=`gps.${m instanceof common.Gps2Raw?1:0}.`,fix=m.fixType>=3&&m.fixType<=8;
      put(p+'fixType',bounded(m.fixType,0,8));put(p+'satellites',bounded(m.satellitesVisible,0,254),'count');
      put(p+'latitudeDeg',fix&&Math.abs(m.lat)<=900000000?m.lat/1e7:null,'°');put(p+'longitudeDeg',fix&&Math.abs(m.lon)<=1800000000?m.lon/1e7:null,'°');
      put(p+'altitudeM',fix?scaled(m.alt,.001):null,'m');put(p+'hdop',scaled(m.eph,.01,[65535]));put(p+'vdop',scaled(m.epv,.01,[65535]));
      put(p+'groundspeedMps',fix?scaled(m.vel,.01,[65535]):null,'m/s');put(p+'courseDeg',fix&&m.cog<36000?m.cog/100:null,'°');
      // Zero extension values are ambiguous on senders using the shorter MAVLink payload.
      for(const [key,field,scale,unit] of [['horizontalAccuracyM','hAcc',.001,'m'],['verticalAccuracyM','vAcc',.001,'m'],['speedAccuracyMps','velAcc',.001,'m/s'],['headingAccuracyDeg','hdgAcc',.00001,'°']] as const){const v=m[field];put(p+key,v>0&&v<4294967295?scaled(v,scale):null,unit);}
      put(p+'yawDeg',m.yaw>0&&m.yaw<=36000?m.yaw/100%360:null,'°');
    } else if(m instanceof common.EstimatorStatus){
      put('ekf.estimator.flags',m.flags,'bitmask');
      for(const [key,field,unit] of [['velocityRatio','velRatio',''],['horizontalPositionRatio','posHorizRatio',''],['verticalPositionRatio','posVertRatio',''],['magnetometerRatio','magRatio',''],['terrainRatio','haglRatio',''],['airspeedRatio','tasRatio',''],['horizontalAccuracyM','posHorizAccuracy','m'],['verticalAccuracyM','posVertAccuracy','m']] as const)put('ekf.estimator.'+key,scaled(m[field]),unit);
    } else if(m instanceof ap.EkfStatusReport){
      put('ekf.report.flags',m.flags,'bitmask');
      for(const [key,field] of [['velocityVariance','velocityVariance'],['horizontalPositionVariance','posHorizVariance'],['verticalPositionVariance','posVertVariance'],['compassVariance','compassVariance'],['terrainVariance','terrainAltVariance'],['airspeedVariance','airspeedVariance']] as const)put('ekf.report.'+key,scaled(m[field]));
    } else if(m instanceof common.Vibration){
      for(const axis of ['X','Y','Z'] as const)put('vibration.'+axis.toLowerCase(),scaled(m[`vibration${axis}`]),'raw');
      for(const id of [0,1,2] as const)put(`vibration.imu${id}.clippingCount`,m[`clipping${id}`],'count');
    } else if(m instanceof ap.Rpm){
      put('esc.rpmSensor0.rpm',bounded(m.rpm1,0,1e7),'rpm');put('esc.rpmSensor1.rpm',bounded(m.rpm2,0,1e7),'rpm');
    } else if(m instanceof ap.EscTelemetry1To4||m instanceof ap.EscTelemetry5To8||m instanceof ap.EscTelemetry9To12||m instanceof ap.EscTelemetry13To16||m instanceof ap.EscTelemetry17To20||m instanceof ap.EscTelemetry21To24||m instanceof ap.EscTelemetry25To28||m instanceof ap.EscTelemetry29To32){
      const classes=[ap.EscTelemetry1To4,ap.EscTelemetry5To8,ap.EscTelemetry9To12,ap.EscTelemetry13To16,ap.EscTelemetry17To20,ap.EscTelemetry21To24,ap.EscTelemetry25To28,ap.EscTelemetry29To32];
      const start=classes.findIndex(c=>m instanceof c)*4;
      for(let i=0;i<4;i++){
        const p=`esc.${start+i}.`,storedPrefix=frame.component===identity.component?p:`esc.c${frame.component}.${start+i}.`;
        // ArduPlane updates RPM separately from its electrical-telemetry count.
        // AP_BLHeli already applies configured motor poles before reporting RPM;
        // unknown senders retain a neutral label instead of an electrical claim.
        const knownMotorRpm=frame.component===identity.component&&identity.autopilot===3&&identity.vehicleType===1&&this.flightSwVersion===0x040701ff;
        const rpm=bounded(m.rpm[i],1,65535);
        put(p+'reportedRpm',rpm,'rpm',knownMotorRpm?'reported':'partial',rpm===null
          ?'Zero RPM is ambiguous: stopped, stale or unsupported in this message'
          :knownMotorRpm?'ArduPlane 4.7.1 reported motor RPM; configured pole count and sender scaling apply'
          :'Reported ESC RPM; electrical or mechanical interpretation is unverified for this sender');
        if(this.samples.get(storedPrefix+'packetCount')?.reading.value===m.count[i])continue;
        // The message omits the sender's per-field support mask. A zero cannot
        // establish a voltage/current/temperature/consumption measurement.
        for(const [key,field,scale,unit] of [['temperatureC','temperature',1,'°C'],['voltageV','voltage',.01,'V'],['currentA','current',.01,'A'],['consumedMah','totalcurrent',1,'mAh']] as const){
          const value=m[field][i];
          put(p+key,value>0?scaled(value,scale):null,unit,'reported',value>0?undefined:'Zero is ambiguous: this ESC message does not report individual field support');
        }
        put(p+'packetCount',m.count[i],'count');
      }
    } else if(m instanceof common.EfiStatus){
      if(!Number.isInteger(m.ecuIndex)||m.ecuIndex<0||m.ecuIndex>255)return;
      const p=`efi.${m.ecuIndex}.`;put(p+'health',m.health);
      for(const [key,field,unit] of [['rpm','rpm','rpm'],['fuelConsumedMl','fuelConsumed','mL'],['fuelFlowMlMin','fuelFlow','mL/min'],['loadPercent','engineLoad','%'],['throttlePercent','throttlePosition','%'],['sparkDwellMs','sparkDwellTime','ms'],['barometricPressureKpa','barometricPressure','kPa'],['manifoldPressureKpa','intakeManifoldPressure','kPa'],['manifoldTemperatureC','intakeManifoldTemperature','°C'],['cylinderTemperatureC','cylinderHeadTemperature','°C'],['ignitionTimingDeg','ignitionTiming','°'],['injectionMs','injectionTime','ms'],['exhaustTemperatureC','exhaustGasTemperature','°C'],['outputThrottlePercent','throttleOut','%'],['compensation','ptCompensation','']] as const)put(p+key,scaled(m[field]),unit);
      put(p+'ignitionVoltageV',scaled(m.ignitionVoltage,1,[0]),'V');put(p+'fuelPressureKpa',scaled(m.fuelPressure,1,[0]),'kPa');
    } else if(m instanceof common.GeneratorStatus){
      const p='generator.0.';put(p+'flags',String(m.status),'bitmask');put(p+'rpm',scaled(m.generatorSpeed,1,[65535]),'rpm');
      for(const [key,field,unit] of [['batteryCurrentA','batteryCurrent','A'],['loadCurrentA','loadCurrent','A'],['powerW','powerGenerated','W'],['busVoltageV','busVoltage','V'],['batterySetpointA','batCurrentSetpoint','A']] as const)put(p+key,scaled(m[field]),unit);
      put(p+'rectifierTemperatureC',scaled(m.rectifierTemperature,1,[32767]),'°C');put(p+'temperatureC',scaled(m.generatorTemperature,1,[32767]),'°C');
      put(p+'runtimeSeconds',scaled(m.runtime,1,[4294967295]),'s');put(p+'maintenanceSeconds',scaled(m.timeUntilMaintenance,1,[2147483647]),'s');
    } else if(m instanceof common.DistanceSensor){
      const p=`rangefinder.${m.id}.`,valid=m.signalQuality!==1&&m.maxDistance>m.minDistance&&m.currentDistance>=m.minDistance&&m.currentDistance<=m.maxDistance;
      put(p+'distanceM',valid?scaled(m.currentDistance,.01):null,'m','reported',valid?undefined:'Invalid signal or distance outside reported sensor bounds');
      put(p+'minimumM',scaled(m.minDistance,.01),'m');put(p+'maximumM',scaled(m.maxDistance,.01),'m');put(p+'orientation',m.orientation);put(p+'type',m.type);
      put(p+'signalPercent',m.signalQuality>1?bounded(m.signalQuality,2,100):null,'%');put(p+'varianceCm2',scaled(m.covariance,1,[255]),'cm²');
    } else if(m instanceof ap.RangeFinder){
      put('rangefinder.legacy.distanceM',bounded(m.distance,0,1e6),'m');put('rangefinder.legacy.voltageV',scaled(m.voltage,1,[0]),'V');
    } else if(m instanceof common.TerrainReport){
      put('terrain.heightM',m.spacing>0?scaled(m.terrainHeight):null,'m');put('terrain.clearanceM',m.spacing>0?scaled(m.currentHeight):null,'m');
      put('terrain.spacingM',m.spacing>0?m.spacing:null,'m');put('terrain.pendingBlocks',m.pending,'count');put('terrain.loadedBlocks',m.loaded,'count');
    } else if(m instanceof common.FenceStatus){
      put('fence.breached',m.breachStatus<=1?m.breachStatus===1:null);put('fence.breachCount',m.breachCount,'count');put('fence.breachType',m.breachType);put('fence.lastBreachBootSeconds',m.breachCount>0?m.breachTime/1000:null,'s');put('fence.mitigation',m.breachMitigation);
    } else if(m instanceof common.PowerStatus){
      put('fc.power.boardVoltageV',m.Vcc/1000,'V');put('fc.power.servoVoltageV',m.Vservo/1000,'V');put('fc.power.flags',m.flags,'bitmask');
    } else if(m instanceof ap.HwStatus){
      put('fc.hardware.boardVoltageV',m.Vcc/1000,'V');put('fc.hardware.i2cErrors',m.I2Cerr,'count');
    } else if(m instanceof ap.McuStatus){
      if(!Number.isInteger(m.id)||m.id<0||m.id>255)return;
      const p=`fc.mcu${m.id}.`;
      // MCU_STATUS defines cdegC/mV integer fields and no sentinel values.
      // In particular, zero and integer maxima are not battery-style sentinels.
      const temperature=bounded(m.MCUTemperature,-32768,32767);
      put(p+'temperatureC',temperature===null?null:temperature/100,'°C');
      for(const [key,field] of [['voltageV','MCUVoltage'],['minVoltageV','MCUVoltageMin'],['maxVoltageV','MCUVoltageMax']] as const){
        const voltage=bounded(m[field],0,65535);put(p+key,voltage===null?null:voltage/1000,'V');
      }
    } else if(m instanceof ap.MemInfo){
      put('fc.memoryFreeBytes',m.freemem32||m.freemem,'bytes');
    } else if(m instanceof common.RcChannels){
      put('rc.channelCount',m.chancount,'count');put('rc.rssi',bounded(m.rssi,0,254),'raw');
      for(let i=1;i<=18;i++){const value=(m as unknown as Record<string,number>)[`chan${i}Raw`];put(`rc.channel${i}Us`,i<=m.chancount&&value>0&&value<65535?value:null,'µs');}
    } else if(m instanceof common.ServoOutputRaw){
      for(let i=1;i<=16;i++){const value=(m as unknown as Record<string,number>)[`servo${i}Raw`];put(`servo.${m.port}.channel${i}Us`,value>0&&value<65535?value:null,'µs');}
    } else if(m instanceof common.CameraInformation){
      const p=`camera.${m.cameraDeviceId}.`,label=(v:number[])=>String.fromCharCode(...v.slice(0,32)).split('\0')[0].replace(/[\u0000-\u001f]/g,'').slice(0,32)||null;
      put(p+'vendor',label(m.vendorName));put(p+'model',label(m.modelName));put(p+'resolutionWidth',m.resolutionH||null,'px');put(p+'resolutionHeight',m.resolutionV||null,'px');put(p+'capabilities',m.flags,'bitmask');
    } else if(m instanceof common.CameraCaptureStatus){
      const p=`camera.${m.cameraDeviceId}.`;put(p+'recording',m.videoStatus<=1?m.videoStatus===1:null);put(p+'imageStatus',bounded(m.imageStatus,0,3));put(p+'recordingSeconds',m.recordingTimeMs>0?m.recordingTimeMs/1000:null,'s');
      put(p+'imageIntervalSeconds',m.imageInterval>0?scaled(m.imageInterval):null,'s');put(p+'freeMiB',bounded(m.availableCapacity,0,1e12),'MiB');put(p+'imageCount',bounded(m.imageCount,0,2147483647),'count');
    } else if(m instanceof common.StorageInformation){
      const p=`camera.storage${m.storageId}.`;put(p+'status',m.status);put(p+'type',m.type);
      for(const [key,field,unit] of [['totalMiB','totalCapacity','MiB'],['usedMiB','usedCapacity','MiB'],['freeMiB','availableCapacity','MiB'],['readMiBS','readSpeed','MiB/s'],['writeMiBS','writeSpeed','MiB/s']] as const)put(p+key,m.status===2?scaled(m[field]):null,unit);
    } else if(m instanceof common.GimbalDeviceAttitudeStatus){
      const p=`gimbal.${m.gimbalDeviceId}.`;put(p+'flags',m.flags,'bitmask');put(p+'failureFlags',m.failureFlags,'bitmask');
      const norm=Math.hypot(...m.q),valid=m.q.length===4&&numeric(norm)&&Math.abs(norm-1)<.05;
      for(const [i,axis] of ['W','X','Y','Z'].entries())put(p+'quaternion'+axis,valid?m.q[i]:null);
      for(const [key,field,unit] of [['rollRateDegS','angularVelocityX','°/s'],['pitchRateDegS','angularVelocityY','°/s'],['yawRateDegS','angularVelocityZ','°/s'],['deltaYawDeg','deltaYaw','°'],['deltaYawRateDegS','deltaYawVelocity','°/s']] as const)put(p+key,scaled(m[field],180/Math.PI),unit);
    } else if(m instanceof common.RadioStatus){
      put('radio.rssi',bounded(m.rssi,0,254),'raw');put('radio.remoteRssi',bounded(m.remrssi,0,254),'raw');put('radio.noise',bounded(m.noise,0,254),'raw');put('radio.remoteNoise',bounded(m.remnoise,0,254),'raw');
      put('radio.txBufferPercent',bounded(m.txbuf,0,100),'%');put('radio.receiveErrors',m.rxerrors,'count');put('radio.correctedPackets',m.fixed,'count');
    }
  }
  snapshot(at:number,connected:boolean,identity:VehicleIdentity|null):InstrumentationSnapshot {
    const fields:InstrumentationSnapshot['fields']={};
    for(const [key,sample] of this.samples){const ageMs=Math.max(0,at-sample.at),stale=at<sample.at||ageMs>=sample.reading.ttlMs;
      fields[key]={...sample.reading,ageMs,...(!connected||stale?{value:null,quality:'unavailable' as const,reason:!connected?'Aircraft disconnected':'Sample expired'}:{})};}
    fields['fc.instrumentationTruncated']={value:this.truncated,unit:'',source:'Companion instrumentation collector',ageMs:0,ttlMs:5000,quality:this.truncated?'partial':'reported',...(this.truncated?{reason:'Collection limit reached: 450 fields, 8 source instances per category (34 for ESC/RPM)'}:{})};
    Object.assign(fields,this.counters.readings(at,connected,identity?`Observed · system ${identity.system} component ${identity.component}`:'Selected autopilot'));
    return {at,connected,generation:identity?.generation??null,fields};
  }
}
