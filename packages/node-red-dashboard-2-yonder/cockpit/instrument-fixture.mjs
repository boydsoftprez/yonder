// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit demonstration readings, imported only by the fixture browser harness.
export function instrumentFixture(at=Date.now()){
 const data={
  'battery.0.voltageV':[15.6,'V'],'battery.0.currentA':[8.4,'A'],'battery.0.remainingPercent':[78,'%'],'battery.0.consumedMah':[1760,'mAh'],'battery.0.consumedWh':[27.5,'Wh'],'battery.0.temperatureC':[30,'°C'],'battery.0.chargeState':[1,''],
  'flight.bootSeconds':[600,'s'],'flight.armedSeconds':[480,'s'],'flight.airborneSeconds':[420,'s'],'flight.autoSeconds':[390,'s'],'flight.landedState':['In air',''],'flight.vtolState':['Fixed wing',''],
  'gps.0.fixType':[3,''],'gps.0.satellites':[14,''],'gps.0.horizontalAccuracyM':[.9,'m'],'gps.0.hdop':[.7,''],'ekf.report.flags':[831,''],'ekf.report.velocityVariance':[.08,''],'ekf.report.horizontalPositionVariance':[.12,''],
  'vibration.x':[9.2,''],'vibration.y':[8.1,''],'vibration.z':[12.5,''],'vibration.imu0.clippingCount':[0,''],
  'esc.0.temperatureC':[43,'°C'],'esc.0.reportedRpm':[2400,'rpm'],'esc.0.currentA':[8.1,'A'],'esc.rpmSensor0.rpm':[2400,'rpm'],
  'rangefinder.0.distanceM':[8.2,'m'],'rangefinder.0.orientation':[25,''],'rangefinder.0.signalPercent':[92,'%'],'terrain.pendingBlocks':[0,''],'terrain.loadedBlocks':[64,''],
  'fence.breached':[false,''],'fence.breachCount':[0,''],'fc.loadPercent':[23,'%'],'fc.power.boardVoltageV':[5.1,'V'],'fc.memoryFreeBytes':[128000,'B'],'rc.rssi':[210,'raw'],'rc.channel1Us':[1500,'µs'],'servo.0.channel1Us':[1570,'µs'],
  'camera.1.recording':[true,''],'camera.1.recordingSeconds':[360,'s'],'camera.storage1.freeMiB':[16384,'MiB'],'gimbal.1.deltaYawDeg':[0,'°'],
  'host.cpuPercent':[38,'%'],'host.temperatureC':[56,'°C'],'host.memoryPercent':[42,'%'],'host.storageFreeBytes':[34359738368,'B'],'modem.rsrpDbm':[-94,'dBm'],'modem.rsrqDb':[-9,'dB'],'modem.sinrDb':[16,'dB'],'modem.technology':['LTE',''],'media.0.recording':[true,''],'media.0.recordingRemainingSeconds':[8040,'s']
 };
 return {at,generation:'fixture-only',connected:true,fields:Object.fromEntries(Object.entries(data).map(([id,[value,unit]])=>[id,{value,unit,source:'SYNTHETIC FIXTURE · '+id,ageMs:0,ttlMs:5000,quality:['flight.armedSeconds','flight.airborneSeconds','flight.autoSeconds'].includes(id)?'partial':'reported',...(['flight.armedSeconds','flight.airborneSeconds','flight.autoSeconds'].includes(id)?{reason:'Observed total in this fixture; excludes missing intervals'}:{})}]))};
}
