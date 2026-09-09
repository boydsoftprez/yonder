# Aircraft instrumentation keys

Selected autopilot keys below. For other selected-system components, insert
`c<component>` after the category: `battery.c154.0.voltageV`.
`source` includes MAVLink message name plus system and component IDs.

- `battery.<id>.voltageV,currentA,consumedMah,consumedWh,remainingPercent,temperatureC,remainingSeconds,chargeState,mode,faultFlags`
- `battery.system.voltageV,currentA,remainingPercent` — SYS_STATUS aggregate, independent of individual batteries.
- `flight.bootSeconds,armedSeconds,airborneSeconds,landedState,vtolState`
- `gps.<0|1>.fixType,satellites,latitudeDeg,longitudeDeg,altitudeM,hdop,vdop,groundspeedMps,courseDeg,horizontalAccuracyM,verticalAccuracyM,speedAccuracyMps,headingAccuracyDeg,yawDeg`
- `ekf.estimator.flags,velocityRatio,horizontalPositionRatio,verticalPositionRatio,magnetometerRatio,terrainRatio,airspeedRatio,horizontalAccuracyM,verticalAccuracyM`
- `ekf.report.flags,velocityVariance,horizontalPositionVariance,verticalPositionVariance,compassVariance,terrainVariance,airspeedVariance`
- `vibration.x,y,z` (raw dialect units); `vibration.imu<0|1|2>.clippingCount`
- `esc.<id>.temperatureC,voltageV,currentA,consumedMah,reportedRpm,packetCount` — zero-based slots 0–31, 34 bounded ESC/RPM source instances, reported RPM; sender interpretation is included in the reason.
- `esc.rpmSensor<0|1>.rpm` — independent RPM sensor message.
- `efi.<ecuIndex>.health,rpm,fuelConsumedMl,fuelFlowMlMin,loadPercent,throttlePercent,sparkDwellMs,barometricPressureKpa,manifoldPressureKpa,manifoldTemperatureC,cylinderTemperatureC,ignitionTimingDeg,injectionMs,exhaustTemperatureC,outputThrottlePercent,compensation,ignitionVoltageV,fuelPressureKpa`
- `generator.0.flags,rpm,batteryCurrentA,loadCurrentA,powerW,busVoltageV,batterySetpointA,rectifierTemperatureC,temperatureC,runtimeSeconds,maintenanceSeconds`
- `rangefinder.<id>.distanceM,minimumM,maximumM,orientation,type,signalPercent,varianceCm2`
- `rangefinder.legacy.distanceM,voltageV` — independent RANGEFINDER message.
- `terrain.heightM,clearanceM,spacingM,pendingBlocks,loadedBlocks`
- `fence.breached,breachCount,breachType,lastBreachBootSeconds,mitigation`
- `fc.hardwareUid,instrumentationTruncated,loadPercent,sensorsPresent,sensorsEnabled,sensorsHealthy,communicationDropPercent,communicationErrors,errorCount<1–4>,memoryFreeBytes`
- `fc.power.boardVoltageV,servoVoltageV,flags`; `fc.hardware.boardVoltageV,i2cErrors`
- `rc.channelCount,rssi,channel<1–18>Us`
- `servo.<port>.channel<1–16>Us`
- `radio.rssi,remoteRssi,noise,remoteNoise,txBufferPercent,receiveErrors,correctedPackets` — raw vendor RSSI/noise, not dBm or percentages.
- `camera.<cameraDeviceId>.vendor,model,resolutionWidth,resolutionHeight,capabilities,recording,imageStatus,recordingSeconds,imageIntervalSeconds,freeMiB,imageCount`
- `camera.storage<storageId>.status,type,totalMiB,usedMiB,freeMiB,readMiBS,writeMiBS`
- `gimbal.<gimbalDeviceId>.flags,failureFlags,quaternionW,quaternionX,quaternionY,quaternionZ,rollRateDegS,pitchRateDegS,yawRateDegS,deltaYawDeg,deltaYawRateDegS`

Landed/VTOL states will be labels from reported enums; other enumerations and
bitmasks retain numeric values (64-bit generator flags are a decimal string).
Measurements use 5 second independent TTLs; heartbeat/landed state and counters
will document stricter freshness. No fields are fabricated for never-seen message
families. UI should explain hardware-dependent no-data at category level.

`fc.instrumentationTruncated` is a collector diagnostic and states bounds when reached.
`fc.hardwareUid` uses AUTOPILOT_VERSION UID2 when present, otherwise UID; a
changed reported hardware UID resets previous observed history even if MAVLink
system/component IDs are reused. All counters remain explicitly partial.

ESC review correction: `reportedRpm` replaces `electricalRpm`, unit `rpm`.
Verified ArduPlane 4.7.1 describes motor RPM; other senders remain explicitly
unverified. RPM freshness is independent of the electrical telemetry counter.
Zero ESC measurements are unavailable because individual support flags are not
transmitted; zero RPM also cannot distinguish stopped from stale/unsupported.

MCU completeness addition: `fc.mcu<id>.temperatureC,voltageV,minVoltageV,maxVoltageV`.
MCU_STATUS (11039) reports centidegrees Celsius and millivolts, with no declared
sentinels. MCU instances retain normal component qualification and 5-second TTL.

AUTO timer addition: `flight.autoSeconds`, seconds, 3-second TTL, partial quality.
UI label: **Observed AUTO execution total**. It accumulates only intervals
bracketed by fresh armed AUTO heartbeats (`customMode == 10`) from the selected
ArduPlane. Pauses/disarm exclude intervals but do not reset the accumulated total.
It is not a mission-start stopwatch or the current sortie duration.

Battery cell addition (all volts): `battery.<id>.cell1VoltageV` through
`cell14VoltageV`, plus `cellMinVoltageV`, `cellMaxVoltageV`, `cellSpreadV`.
Component qualification remains `battery.c<component>.<id>.*`. Per-cell keys are
created only for unambiguous reported cells; previously created keys become
unavailable immediately when a later message omits them or uses aggregate data.
Base-array zeros remain measured zero. Extension code 1 retains its reported
0.001 V with partial quality because it can also encode measured zero.
