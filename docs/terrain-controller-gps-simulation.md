# Terrain requests with simulated GPS — bench evidence

Date: 2026-09-11. This experiment follows the [GPS-free cache test](terrain-controller-bench.md), supporting the onboard terrain design and planned R-FLT-27/28. It does not establish flight readiness.

## Build and connection

A temporary HEEWING-F405v2 ArduPlane 4.7.1 build used source `dbe792162d06cab66c3475fd5556bf7a120f119e`, Arm GNU 10-2020-q4-major, AP_TERRAIN_AVAILABLE=1 and AP_GPS_MAV_ENABLED=1. Extracted features differed from the prior terrain build only by enabling MAVLink GPS. The image occupies 907672 of 983040 flash bytes, leaving 75368 bytes spare. Candidate APJ SHA-256: `f46d0dab0880db14f060ac8c96bbf9831604f7c75b3d51ca5355678b74439df6`.

The Radxa USB path repeatedly disconnected while the controller's UART uptime continued. Direct USB to the Mac passed a 70-second passive check and subsequent transfers. The saved terrain-only firmware matched the installed image's bootloader CRC before erase; the test image passed programming CRC verification. All 1501 parameters and the 15 mission items were backed up. A complete postflash comparison found only startup barometer/gyro offsets changed; mission, fence and rally contents were identical.

## Experiment contract

The bench remained disarmed. GPS1_TYPE was temporarily changed from 1 to 14, acknowledged, and the controller rebooted; GPS2_TYPE remained 0. Terrain remained enabled, diskless, at 30 m spacing with a 12-entry cache and TERRAIN_FOLLOW=0. No arming, flight-mode, mission, EKF-check or output commands were issued.

The simulator used the existing 115200-baud MAVLink UART through the Radxa router. It sent GPS_INPUT at 5 Hz: 60 seconds stationary at 35.70°N, 83.36°W, 800 m MSL; 180 seconds of northward movement with a velocity ramp; then 10 seconds stationary. Read-only observation requests used MAV_CMD_REQUEST_MESSAGE without changing telemetry stream settings.

The responder ran on the Mac for this experiment, using the same official HGT tile as the prior test. It answered actual controller TERRAIN_REQUEST masks, with no TERRAIN_CHECK or unsolicited cache seeding. Replies were capped at 10 frames/second, with a 64-subgrid queue and five-second expiry. Missing or unsupported data were withheld. This validates the controller and UART path, not the unimplemented persistent Yonder service.

Stop conditions included an armed heartbeat, heartbeat gap above four seconds, boot-time regression and observed free RAM below 8000 bytes. A parent wrapper stops the simulator and restores GPS1_TYPE on exit, including simulator failure.

## Observed result

The bounded request/response experiment completed in 254.4 seconds including preflight:

| Observation | Result |
| --- | --- |
| Simulated northward travel | 4.95 km |
| GPS_INPUT messages | 1250 at 5 Hz |
| Controller terrain requests | 24 across eight distinct origins |
| TERRAIN_DATA replies | 460 frames |
| Queue peak / drops / expiry | 56 subgrids / zero / zero |
| Invalid or unavailable source requests | Zero |
| Free RAM | 14560–19088 bytes |
| Reported CPU load | 18.2–37.3% |
| Largest heartbeat interval | 1.116 seconds |
| Observed arming or boot-time regression | None |
| Terrain reports with 30 m spacing | 756 of 767 |

GPS_RAW_INT and GLOBAL_POSITION_INT followed the route, with both reaching its final coordinate. This establishes input reception and movement of reported position, not uninterrupted EKF aiding. EKF initialized and used GPS at rest, but movement produced repeated stopped-aiding/yaw-alignment messages and an AHRS switch to DCM. The reported position following GPS cannot be attributed to a continuously healthy EKF.

Missing-RC failsafes autonomously switched modes through Circle and RTL during simulated movement despite disarmed heartbeats. The harness sent no mode commands. The firmware also accumulated simulated flight statistics. These side effects make this an unsuitable protocol for claiming realistic flight or VTOL transition readiness; future navigation testing needs a physically consistent simulation or real sensors and controlled RC inputs.

Terrain availability reports showed an initial gap of about 1.34 seconds and seven later gaps of about 0.31–0.35 seconds. These durations are bounded by report sampling, not exact internal outage measurements. Final terrain height was 566.013 m MSL. Pending/loaded remained 672/0 despite valid point elevations, consistent with the known diskless-state limitation.

## Interpretation limits

GPS reception, reported global position, terrain request turnover, and healthy EKF aiding are separate observations. The stationary physical IMU does not reproduce the acceleration of a moving aircraft. The experiment must not be described as a full hardware-in-the-loop flight simulation or navigation qualification. Real GPS, operational peripherals, airborne navigation load, logging, and VTOL transition headroom remain separate acceptance work.

The pinned diskless implementation also leaves populated entries in DISKWAIT state. Its pending/loaded counters cannot independently establish usable coverage, and its cache request scan skips those entries. With valid position, the current-grid request path works separately. Ahead-of-aircraft, mission and other cached-location preparation must therefore be tested explicitly; successful current-position replies do not prove prefetch behavior. Relevant implementation: [TerrainGCS.cpp](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/libraries/AP_Terrain/TerrainGCS.cpp).

## Restoration and final verification

The simulator exited normally and the temporary bridge/tunnel closed. GPS1_TYPE was restored to 1 and acknowledged before reboot. The terrain-only firmware was then restored and its programming CRC verified. The pretest statistics were all zero; the documented STAT_RESET mechanism removed only the experiment's simulated flight count/time/distance, and all six statistics parameters read back as zero. Experiment evidence was retained.

A final complete read of all 1501 parameters matched the immediate pretest backup except normal startup barometer and gyro offsets. All 15 mission items, and empty fence/rally sets, matched exactly. Final telemetry showed Manual, disarmed, GPS1_TYPE=1, GPS2_TYPE=0, no GPS fix, zero reported latitude/longitude and 19480 free RAM bytes in the final observation. No simulated GPS feed remains active. The test firmware is retained as an artifact but is not the firmware left on the controller.
