// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ardupilotmega as ap, common, minimal, standard, type MavLinkData } from 'node-mavlink';
import { AircraftInstrumentation } from './instrumentation.js';
import type { VehicleIdentity } from './types.js';
const identity: VehicleIdentity = {system:42,component:1,autopilot:3,vehicleType:1,generation:'first'};
function rig() {
  const collector = new AircraftInstrumentation(); collector.select(identity, false);
  const feed=(data:MavLinkData,at=100,system=42,component=1)=>collector.receive({system,component,id:(data.constructor as {MSG_ID:number}).MSG_ID,data},at,identity);
  const fields=(at=100,connected=true)=>collector.snapshot(at,connected,identity).fields;
  return {collector,feed,fields};
}
const battery=(id=0)=>Object.assign(new common.BatteryStatus(),{id,voltages:[4200,4100,...Array(8).fill(65535)],voltagesExt:[4000,0,0,0],currentBattery:1250,currentConsumed:123,energyConsumed:360,batteryRemaining:80,temperature:2500,timeRemaining:10});
describe('aircraft instrumentation',()=>{
  it('converts battery cell sums and hJ to Wh, preserving instance and component identity',()=>{
    const r=rig();r.feed(battery());r.feed(battery(1));r.feed(battery(),100,42,154);r.feed(battery(2),100,9,1);
    expect(r.fields()['battery.0.voltageV']).toMatchObject({value:12.3,unit:'V',quality:'calculated'});
    expect(r.fields()['battery.0.currentA'].value).toBe(12.5);
    expect(r.fields()['battery.0.consumedWh'].value).toBe(10);
    expect(r.fields()['battery.1.consumedMah'].value).toBe(123);
    expect(r.fields()['battery.c154.0.voltageV'].source).toContain('component 154');
    expect(r.fields()['battery.2.voltageV']).toBeUndefined();
  });
  it('invalidates sentinels and expires each message independently without inventing zero readings',()=>{
    const r=rig();r.feed(battery());r.feed(Object.assign(battery(),{voltages:Array(10).fill(65535),voltagesExt:Array(4).fill(0),currentBattery:-1,currentConsumed:-1,energyConsumed:-1,batteryRemaining:-1,temperature:32767,timeRemaining:0}));
    for(const key of ['voltageV','currentA','consumedMah','consumedWh','remainingPercent','temperatureC','remainingSeconds']) expect(r.fields()[`battery.0.${key}`]).toMatchObject({value:null,quality:'unavailable'});
    r.feed(battery());r.feed(Object.assign(new common.RadioStatus(),{rssi:100,remrssi:255,noise:255,remnoise:255,txbuf:99}),4100);
    expect(r.fields(5200)['battery.0.voltageV']).toMatchObject({value:null,ageMs:5100,quality:'unavailable'});
    expect(r.fields(5200)['radio.rssi'].value).toBe(100);
    expect(r.fields(5200)['radio.rssi'].unit).toBe('raw');
    expect(r.fields(5200)['radio.remoteRssi'].value).toBeNull();
    expect(r.fields(5200,false)['radio.rssi'].value).toBeNull();
  });
  it('keeps SYS_STATUS aggregate battery separate and bounds hostile sensor instance growth',()=>{
    const r=rig();r.feed(battery());r.feed(Object.assign(new common.SysStatus(),{voltageBattery:11000,currentBattery:-1,batteryRemaining:50,load:250}));
    expect(r.fields()['battery.0.voltageV'].value).toBe(12.3);
    expect(r.fields()['battery.system.voltageV'].value).toBe(11);
    expect(r.fields()['fc.loadPercent'].value).toBe(25);
    for(let component=1;component<256;component++)for(let id=0;id<32;id++)r.feed(battery(id),100,42,component);
    expect(Object.keys(r.fields()).length).toBeLessThanOrEqual(450);
    expect(r.fields()['battery.0.voltageV'].value).toBe(12.3);
  });
});

describe('installed MAVLink instrument families',()=>{
  it('requires a GPS fix for coordinates and handles extension accuracy/yaw sentinels',()=>{
    const r=rig();r.feed(Object.assign(new common.GpsRawInt(),{fixType:3,lat:350000000,lon:-830000000,alt:400000,eph:125,epv:65535,vel:1200,cog:65535,satellitesVisible:255,hAcc:2500,yaw:36000}));
    expect(r.fields()['gps.0.latitudeDeg'].value).toBe(35);expect(r.fields()['gps.0.altitudeM'].value).toBe(400);
    expect(r.fields()['gps.0.hdop'].value).toBe(1.25);expect(r.fields()['gps.0.vdop'].value).toBeNull();expect(r.fields()['gps.0.horizontalAccuracyM'].value).toBe(2.5);
    expect(r.fields()['gps.0.yawDeg'].value).toBe(0);expect(r.fields()['gps.0.verticalAccuracyM'].value).toBeNull();
    r.feed(Object.assign(new common.Gps2Raw(),{fixType:1,lat:350000000,vel:65535,yaw:0}));expect(r.fields()['gps.1.latitudeDeg'].value).toBeNull();expect(r.fields()['gps.1.yawDeg'].value).toBeNull();
  });
  it('keeps estimator outputs separate from ArduPilot variance reports and exposes vibration clipping',()=>{
    const r=rig();r.feed(Object.assign(new common.EstimatorStatus(),{flags:3,velRatio:.5,posHorizAccuracy:2}));r.feed(Object.assign(new ap.EkfStatusReport(),{flags:7,velocityVariance:.75}));r.feed(Object.assign(new common.Vibration(),{vibrationX:1.5,clipping1:99}));
    expect(r.fields()['ekf.estimator.velocityRatio'].value).toBe(.5);expect(r.fields()['ekf.report.velocityVariance'].value).toBe(.75);
    expect(r.fields()['vibration.x'].value).toBe(1.5);expect(r.fields()['vibration.imu1.clippingCount'].value).toBe(99);
  });
  it('preserves reported ESC RPM without another pole conversion and validates EFI/generator sentinels',()=>{
    const r=rig();r.feed(Object.assign(new ap.EscTelemetry5To8(),{temperature:[30,0,0,0],voltage:[2400,0,0,0],current:[500,0,0,0],totalcurrent:[12,0,0,0],rpm:[9000,0,0,0],count:[2,0,0,0]}));
    expect(r.fields()['esc.4.voltageV'].value).toBe(24);expect(r.fields()['esc.4.reportedRpm'].value).toBe(9000);expect(r.fields()['esc.5.voltageV'].value).toBeNull();
    r.feed(Object.assign(new common.EfiStatus(),{ecuIndex:2,rpm:1200,fuelFlow:25,ignitionVoltage:0,fuelPressure:0}));
    expect(r.fields()['efi.2.rpm'].value).toBe(1200);expect(r.fields()['efi.2.fuelFlowMlMin'].value).toBe(25);expect(r.fields()['efi.2.fuelPressureKpa'].value).toBeNull();
    r.feed(Object.assign(new common.GeneratorStatus(),{generatorSpeed:65535,batteryCurrent:NaN,rectifierTemperature:32767,generatorTemperature:32767,runtime:4294967295,timeUntilMaintenance:2147483647,powerGenerated:200}));
    expect(r.fields()['generator.0.powerW'].value).toBe(200);for(const key of ['rpm','batteryCurrentA','rectifierTemperatureC','temperatureC','runtimeSeconds','maintenanceSeconds'])expect(r.fields()[`generator.0.${key}`].value).toBeNull();
    expect(()=>JSON.stringify(r.fields())).not.toThrow();
  });
  it('validates range quality and terrain coverage without converting a forward sensor to height',()=>{
    const r=rig();r.feed(Object.assign(new common.DistanceSensor(),{id:5,minDistance:10,maxDistance:1000,currentDistance:250,orientation:0,signalQuality:80}));
    expect(r.fields()['rangefinder.5.distanceM'].value).toBe(2.5);expect(r.fields()['rangefinder.5.orientation'].value).toBe(0);
    r.feed(Object.assign(new common.DistanceSensor(),{id:5,minDistance:10,maxDistance:1000,currentDistance:250,signalQuality:1}));expect(r.fields()['rangefinder.5.distanceM'].value).toBeNull();
    r.feed(Object.assign(new common.TerrainReport(),{spacing:0,terrainHeight:200,currentHeight:80}));expect(r.fields()['terrain.heightM'].value).toBeNull();
    r.feed(Object.assign(new common.TerrainReport(),{spacing:100,terrainHeight:200,currentHeight:80}));expect(r.fields()['terrain.heightM'].value).toBe(200);expect(r.fields()['terrain.clearanceM'].value).toBe(80);
    r.feed(Object.assign(new ap.RangeFinder(),{distance:1.5,voltage:0}));expect(r.fields()['rangefinder.legacy.distanceM'].value).toBe(1.5);expect(r.fields()['rangefinder.legacy.voltageV'].value).toBeNull();
  });
  it('reports fence/controller power and raw RC/output channels using explicit units',()=>{
    const r=rig();r.feed(Object.assign(new common.FenceStatus(),{breachStatus:1,breachCount:2,breachTime:12000}));r.feed(Object.assign(new common.PowerStatus(),{Vcc:5100,Vservo:6200}));r.feed(Object.assign(new ap.HwStatus(),{Vcc:4900,I2Cerr:4}));r.feed(Object.assign(new ap.MemInfo(),{freemem:100,freemem32:100000}));
    expect(r.fields()['fence.breached'].value).toBe(true);expect(r.fields()['fence.lastBreachBootSeconds'].value).toBe(12);expect(r.fields()['fc.power.boardVoltageV'].value).toBe(5.1);expect(r.fields()['fc.hardware.boardVoltageV'].value).toBe(4.9);expect(r.fields()['fc.memoryFreeBytes'].value).toBe(100000);
    r.feed(Object.assign(new common.RcChannels(),{chancount:2,chan1Raw:1500,chan2Raw:65535,rssi:255}));expect(r.fields()['rc.channel1Us'].value).toBe(1500);expect(r.fields()['rc.channel2Us'].value).toBeNull();expect(r.fields()['rc.channel3Us'].value).toBeNull();
    r.feed(Object.assign(new common.ServoOutputRaw(),{port:1,servo1Raw:1900}));expect(r.fields()['servo.1.channel1Us'].value).toBe(1900);expect(r.fields()['servo.1.channel9Us'].value).toBeNull();
  });
  it('reports camera capture/storage facts and gimbal frame flags without inventing recording duration',()=>{
    const r=rig();r.feed(Object.assign(new common.CameraCaptureStatus(),{cameraDeviceId:2,videoStatus:1,recordingTimeMs:0,availableCapacity:512,imageCount:3}));
    expect(r.fields()['camera.2.recording'].value).toBe(true);expect(r.fields()['camera.2.recordingSeconds'].value).toBeNull();
    r.feed(Object.assign(new common.StorageInformation(),{storageId:1,status:0,totalCapacity:1000,availableCapacity:500}));expect(r.fields()['camera.storage1.freeMiB'].value).toBeNull();
    r.feed(Object.assign(new common.GimbalDeviceAttitudeStatus(),{gimbalDeviceId:1,flags:16,q:[1,0,0,0],angularVelocityX:NaN,deltaYaw:NaN}));
    expect(r.fields()['gimbal.1.flags'].value).toBe(16);expect(r.fields()['gimbal.1.quaternionW'].value).toBe(1);expect(r.fields()['gimbal.1.rollRateDegS'].value).toBeNull();
  });
});

describe('service-owned observed flight counters',()=>{
  const heartbeat=(armed:boolean)=>Object.assign(new minimal.Heartbeat(),{baseMode:armed?128:0});
  const landed=(landedState:number)=>Object.assign(new common.ExtendedSysState(),{landedState,vtolState:4});
  it('distinguishes boot, armed and airborne time and marks late attachment partial',()=>{
    const r=rig();r.feed(heartbeat(true),100);r.feed(Object.assign(new common.SystemTime(),{timeBootMs:100000}),100);r.feed(landed(1),100);
    r.feed(heartbeat(true),1100);r.feed(landed(1),1100);
    expect(r.fields(1100)['flight.bootSeconds'].value).toBe(100);expect(r.fields(1100)['flight.armedSeconds']).toMatchObject({value:1,quality:'partial'});expect(r.fields(1100)['flight.airborneSeconds'].value).toBe(0);
    r.feed(landed(2),1100);r.feed(heartbeat(true),2100);r.feed(landed(2),2100);
    expect(r.fields(2100)['flight.airborneSeconds']).toMatchObject({value:1,quality:'partial'});expect(r.fields(2100)['flight.landedState'].value).toBe('In air');expect(r.fields(2100)['flight.vtolState'].value).toBe('Fixed wing');
    // Repeated reads/browser polls must not add time or create a flight from arming.
    expect(r.fields(2500)['flight.airborneSeconds'].value).toBe(1);expect(r.fields(2500)['flight.armedSeconds'].value).toBe(2);
  });
  it('retains same-device reconnect observations but excludes gaps and resets on reboot',()=>{
    const r=rig();r.feed(heartbeat(true),100);r.feed(Object.assign(new common.GlobalPositionInt(),{timeBootMs:100000}),100);r.feed(landed(2),100);
    r.feed(heartbeat(true),1100);r.feed(landed(2),1100);
    const next={...identity,generation:'reconnected'};r.collector.select(next,true);
    r.feed(heartbeat(true),10100);r.feed(landed(2),10100);
    expect(r.fields(10100)['flight.armedSeconds'].value).toBe(1);expect(r.fields(10100)['flight.airborneSeconds'].value).toBe(1);
    expect(r.fields(10100)['flight.airborneSeconds'].reason).toMatch(/gap/i);
    r.feed(heartbeat(true),11100);r.feed(landed(2),11100);expect(r.fields(11100)['flight.airborneSeconds'].value).toBe(2);
    r.feed(Object.assign(new common.GlobalPositionInt(),{timeBootMs:100}),11300);r.feed(Object.assign(new common.GlobalPositionInt(),{timeBootMs:300}),11600);r.feed(Object.assign(new common.GlobalPositionInt(),{timeBootMs:500}),11900);r.feed(heartbeat(false),11900);r.feed(landed(1),11900);
    expect(r.fields(11900)['flight.bootSeconds'].value).toBe(.5);expect(r.fields(11900)['flight.armedSeconds'].value).toBe(0);expect(r.fields(11900)['flight.airborneSeconds'].value).toBe(0);
    expect(r.fields(11900)['flight.airborneSeconds'].reason).toMatch(/reboot/i);
  });
  it('never infers airborne time from speed, arming, peripherals or undefined landed state',()=>{
    const r=rig();r.feed(heartbeat(true),100);r.feed(Object.assign(new common.VfrHud(),{groundspeed:30,airspeed:35}),100);r.feed(landed(2),100,42,154);
    expect(r.fields()['flight.airborneSeconds'].value).toBeNull();
    r.feed(landed(0),100);r.feed(heartbeat(true),1100);r.feed(landed(0),1100);
    expect(r.fields(1100)['flight.airborneSeconds'].value).toBeNull();expect(r.fields(1100)['flight.landedState'].value).toBeNull();
    r.feed(landed(2),1100);r.feed(heartbeat(true),10100);r.feed(landed(2),10100);expect(r.fields(10100)['flight.airborneSeconds'].value).toBe(0);
    expect(r.fields(16000)['flight.airborneSeconds']).toMatchObject({value:null,quality:'unavailable'});
  });
});

describe('telemetry clock and capacity edge cases',()=>{
  const hb=()=>Object.assign(new minimal.Heartbeat(),{baseMode:128});
  const air=()=>Object.assign(new common.ExtendedSysState(),{landedState:2});
  it('does not bridge a missing heartbeat interval when landed-state samples span the gap',()=>{
    const r=rig();r.feed(hb(),100);r.feed(air(),100);r.feed(hb(),3100);r.feed(air(),3100);
    expect(r.fields(3100)['flight.airborneSeconds'].value).toBe(0);
  });
  it('ignores one delayed boot packet and treats uint32 wrap as continuous uptime',()=>{
    const r=rig(),boot=(ms:number,at:number)=>r.feed(Object.assign(new common.GlobalPositionInt(),{timeBootMs:ms}),at);
    r.feed(hb(),100);boot(100000,100);r.feed(hb(),1100);boot(101000,1100);boot(10000,1200);
    expect(r.fields(1200)['flight.bootSeconds'].value).toBe(101);expect(r.fields(1200)['flight.armedSeconds'].value).toBe(1);
    boot(102000,2100);boot(4294967000,2200);boot(1000,3200);
    expect(r.fields(3200)['flight.bootSeconds'].value).toBeCloseTo(4294968.296);
    boot(4294967200,3300);expect(r.fields(3300)['flight.bootSeconds'].value).toBeCloseTo(4294968.296);
  });
  it('requires advancing low-clock observations before resetting a rebooted counter',()=>{
    const r=rig(),boot=(ms:number,at:number)=>r.feed(Object.assign(new common.SystemTime(),{timeBootMs:ms}),at);
    r.feed(hb(),100);boot(100000,100);r.feed(hb(),1100);boot(500,1200);
    expect(r.fields(1200)['flight.armedSeconds'].value).toBe(1);
    boot(800,1500);boot(1100,1800);r.feed(hb(),1800);
    expect(r.fields(1800)['flight.armedSeconds'].value).toBe(0);expect(r.fields(1800)['flight.bootSeconds'].value).toBe(1.1);
  });
  it('does not refresh cached ESC samples when the underlying received-packet count has not advanced',()=>{
    const r=rig(),esc=()=>Object.assign(new ap.EscTelemetry1To4(),{voltage:[2400,0,0,0],rpm:[10000,0,0,0],count:[42,0,0,0]});
    r.feed(esc(),100);r.feed(esc(),4100);
    expect(r.fields(5200)['esc.0.voltageV']).toMatchObject({value:null,ageMs:5100});
  });
  it('surfaces bounded collection and allows the full 32 ESC slots supported by this dialect',()=>{
    const r=rig();const classes=[ap.EscTelemetry1To4,ap.EscTelemetry5To8,ap.EscTelemetry9To12,ap.EscTelemetry13To16,ap.EscTelemetry17To20,ap.EscTelemetry21To24,ap.EscTelemetry25To28,ap.EscTelemetry29To32];
    for(const c of classes)r.feed(Object.assign(new c(),{voltage:[2400,2400,2400,2400],count:[1,1,1,1]}));
    expect(r.fields()['esc.31.voltageV'].value).toBe(24);
    for(let id=0;id<40;id++)r.feed(battery(id));
    expect(r.fields()['fc.instrumentationTruncated'].value).toBe(true);
    expect(Object.keys(r.fields()).length).toBeLessThanOrEqual(450);
  });
});

describe('ESC sender semantics',()=>{
  const esc=(rpm:number,count=0)=>Object.assign(new ap.EscTelemetry1To4(),{
    rpm:[rpm,0,0,0],count:[count,0,0,0],voltage:[0,0,0,0],current:[0,0,0,0],temperature:[0,0,0,0],totalcurrent:[0,0,0,0],
  });
  it('keeps independently reported RPM fresh while a separate electrical telemetry counter is unchanged',()=>{
    const r=rig();
    for(const [at,rpm] of [[100,9000],[1100,12000],[6100,15000]]){
      r.feed(esc(rpm),at);
      expect(r.fields(at)['esc.0.reportedRpm']).toMatchObject({value:rpm,unit:'rpm',ageMs:0});
      for(const key of ['voltageV','currentA','temperatureC','consumedMah']) expect(r.fields(at)[`esc.0.${key}`]).toMatchObject({value:null,quality:'unavailable'});
    }
    expect(r.fields(6100)['esc.0.electricalRpm']).toBeUndefined();
  });
  it('does not establish support for zero members from another member or an advancing counter',()=>{
    const r=rig();r.feed(Object.assign(esc(9000,1),{voltage:[2400,0,0,0]}),100);
    r.feed(Object.assign(esc(10000,2),{voltage:[2400,0,0,0]}),1100);
    expect(r.fields(1100)['esc.0.voltageV'].value).toBe(24);
    expect(r.fields(1100)['esc.0.currentA'].value).toBeNull();
    r.feed(Object.assign(esc(0,3),{voltage:[2400,0,0,0]}),2100);
    expect(r.fields(2100)['esc.0.reportedRpm']).toMatchObject({value:null,quality:'unavailable'});
  });
  it('describes unverified sender RPM neutrally and known ArduPlane motor RPM without another pole conversion',()=>{
    const r=rig();r.feed(esc(9000));
    expect(r.fields()['esc.0.reportedRpm'].reason).toMatch(/interpretation.*unverified/i);
    r.feed(Object.assign(new standard.AutopilotVersion(),{flightSwVersion:0x040701ff}));r.feed(esc(9000));
    expect(r.fields()['esc.0.reportedRpm']).toMatchObject({value:9000,unit:'rpm',quality:'reported'});
    expect(r.fields()['esc.0.reportedRpm'].reason).toMatch(/ArduPlane 4.7.1.*motor RPM/);
    r.feed(esc(9000),100,42,154);expect(r.fields()['esc.c154.0.reportedRpm'].reason).toMatch(/interpretation.*unverified/i);
  });
});

describe('MCU status instruments',()=>{
  const mcu=(id=0)=>Object.assign(new ap.McuStatus(),{id,MCUTemperature:4250,MCUVoltage:3300,MCUVoltageMin:3250,MCUVoltageMax:3350});
  it('converts reported MCU units and preserves source instance and expiry',()=>{
    const r=rig();r.feed(mcu());r.feed(Object.assign(mcu(1),{MCUTemperature:-1250}));r.feed(mcu(),100,42,154);r.feed(mcu(2),100,9,1);
    expect(r.fields()['fc.mcu0.temperatureC']).toMatchObject({value:42.5,unit:'°C',quality:'reported',ageMs:0,ttlMs:5000});
    expect(r.fields()['fc.mcu0.voltageV'].value).toBe(3.3);expect(r.fields()['fc.mcu0.minVoltageV'].value).toBe(3.25);expect(r.fields()['fc.mcu0.maxVoltageV'].value).toBe(3.35);
    expect(r.fields()['fc.mcu1.temperatureC'].value).toBe(-12.5);expect(r.fields()['fc.c154.mcu0.temperatureC'].source).toContain('component 154');expect(r.fields()['fc.mcu2.temperatureC']).toBeUndefined();
    expect(r.fields(5100)['fc.mcu0.temperatureC']).toMatchObject({value:null,quality:'unavailable',ageMs:5000});
  });
  it('uses declared integer ranges without inventing sentinels, and bounds MCU instances',()=>{
    const r=rig();r.feed(Object.assign(mcu(),{MCUTemperature:0,MCUVoltage:0,MCUVoltageMin:65535}));
    expect(r.fields()['fc.mcu0.temperatureC'].value).toBe(0);expect(r.fields()['fc.mcu0.voltageV'].value).toBe(0);expect(r.fields()['fc.mcu0.minVoltageV'].value).toBe(65.535);
    r.feed(Object.assign(mcu(),{MCUTemperature:32767}));expect(r.fields()['fc.mcu0.temperatureC'].value).toBe(327.67);
    r.feed(Object.assign(mcu(),{MCUTemperature:NaN,MCUVoltage:-1,MCUVoltageMin:65536,MCUVoltageMax:Infinity}));
    for(const key of ['temperatureC','voltageV','minVoltageV','maxVoltageV'])expect(r.fields()[`fc.mcu0.${key}`]).toMatchObject({value:null,quality:'unavailable'});
    for(let id=1;id<40;id++)r.feed(mcu(id));
    expect(r.fields()['fc.instrumentationTruncated'].value).toBe(true);expect(Object.keys(r.fields()).length).toBeLessThanOrEqual(450);
  });
});

describe('AUTO counter source admission',()=>{
  it('uses only the selected ArduPlane armed AUTO heartbeat and stays inside the total field bound',()=>{
    const r=rig(),hb=(customMode:number,armed=true)=>Object.assign(new minimal.Heartbeat(),{customMode,baseMode:armed?128:0});
    r.feed(hb(0),100);r.feed(hb(10),1100,42,154);r.feed(hb(10),2100,42,154);
    expect(r.fields(2100)['flight.autoSeconds'].value).toBe(0);
    r.feed(hb(10),2100);r.feed(hb(10),3100);expect(r.fields(3100)['flight.autoSeconds'].value).toBe(1);
    for(let id=0;id<40;id++)r.feed(battery(id),3100);
    expect(Object.keys(r.fields(3100)).length).toBeLessThanOrEqual(450);
    const copter={...identity,vehicleType:2};r.collector.select(copter,false);
    for(const at of [4100,5100])r.collector.receive({system:42,component:1,id:0,data:hb(10)},at,copter);
    expect(r.collector.snapshot(5100,true,copter).fields['flight.autoSeconds'].value).toBeNull();
  });
});

describe('unambiguous battery cell measurements',()=>{
  const cells=(values:number[],id=0,ext=[0,0,0,0])=>Object.assign(battery(id),{voltages:[...values,...Array(10-values.length).fill(65535)],voltagesExt:ext});
  it('reports real cell voltages including zero and calculates min/max/spread from millivolts',()=>{
    const r=rig();r.feed(cells([4200,4100,0]));r.feed(cells([3900,3800],1));r.feed(cells([4100,4000]),100,42,154);
    expect(r.fields()['battery.0.cell1VoltageV']).toMatchObject({value:4.2,unit:'V',quality:'reported'});
    expect(r.fields()['battery.0.cell3VoltageV'].value).toBe(0);
    expect(r.fields()['battery.0.cellMinVoltageV']).toMatchObject({value:0,quality:'calculated'});
    expect(r.fields()['battery.0.cellMaxVoltageV'].value).toBe(4.2);expect(r.fields()['battery.0.cellSpreadV'].value).toBe(4.2);
    expect(r.fields()['battery.1.cellSpreadV'].value).toBe(.1);expect(r.fields()['battery.c154.0.cell1VoltageV'].source).toContain('component 154');
  });
  it('preserves extended-cell slot numbering and its measured-zero encoding without guessing a true zero',()=>{
    const r=rig();r.feed(cells(Array(10).fill(4000),0,[3900,1,0,0]));
    expect(r.fields()['battery.0.cell11VoltageV'].value).toBe(3.9);
    expect(r.fields()['battery.0.cell12VoltageV']).toMatchObject({value:.001,quality:'partial'});
    expect(r.fields()['battery.0.cell12VoltageV'].reason).toMatch(/zero/i);
    expect(r.fields()['battery.0.cellMinVoltageV']).toMatchObject({value:.001,quality:'partial'});
    expect(r.fields()['battery.0.cellSpreadV'].value).toBe(3.999);
    expect(r.fields()['battery.0.cell13VoltageV']).toBeUndefined();
  });
  it('never derives cells or imbalance from a single pack slot or overflow pack splitting',()=>{
    const r=rig();
    for(const values of [[12600],[65534,14466],[65534,65534,1000]]){
      r.feed(cells(values));
      expect(r.fields()['battery.0.cell1VoltageV']).toBeUndefined();
      expect(r.fields()['battery.0.cellMinVoltageV']).toMatchObject({value:null,quality:'unavailable'});
      expect(r.fields()['battery.0.cellMaxVoltageV'].value).toBeNull();expect(r.fields()['battery.0.cellSpreadV'].value).toBeNull();
    }
    expect(r.fields()['battery.0.voltageV'].value).toBe(132.068);
  });
  it('immediately invalidates old cell readings and derived spread when format changes or the cell count shrinks',()=>{
    const r=rig();r.feed(cells([4200,4100,4000]));r.feed(cells([4100,4050],1));
    r.feed(cells([4200,4100]),1100);expect(r.fields(1100)['battery.0.cell3VoltageV']).toMatchObject({value:null,ageMs:0});
    r.feed(cells([12300]),2100);
    for(const key of ['cell1VoltageV','cell2VoltageV','cell3VoltageV','cellMinVoltageV','cellMaxVoltageV','cellSpreadV'])expect(r.fields(2100)[`battery.0.${key}`]).toMatchObject({value:null,quality:'unavailable',ageMs:0,ttlMs:5000});
    expect(r.fields(2100)['battery.1.cellSpreadV'].value).toBe(.05);
    r.feed(cells([4200,4100]),3100);expect(r.fields(8100)['battery.0.cellSpreadV']).toMatchObject({value:null,ageMs:5000});
  });
  it('rejects inconsistent sentinel placement instead of joining disconnected voltage slots into a cell set',()=>{
    const r=rig();
    for(const message of [cells([4200,65535,4100]),cells([4200,4100],0,[3900,0,0,0]),cells(Array(10).fill(4000),0,[3900,0,3800,0])]){
      r.feed(message);expect(r.fields()['battery.0.cellSpreadV']).toMatchObject({value:null,quality:'unavailable'});
    }
  });
});
