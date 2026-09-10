# Cockpit request follow-through — 2026-09-07

The new implementation in this pass is the missing slip/skid ball (R-FLT-17).
Existing flight, terrain, traffic and breadcrumb surfaces were checked again
against the same integration branch. [Measured evidence](2026-09-07-cockpit-followthrough.json)
contains the disposable firmware flight and passive browser profile.

## Added

The PFD has a round ball beneath the bank pointer with center marks, touch status
and a local show/hide setting. PFD Menu and Display can restore a hidden ball.
The [community G3X indicator](https://github.com/microsoft/msfs-avionics-mirror/blob/main/src/workingtitle-instruments-g3x-touch/html_ui/PFD/Components/SlipSkidIndicator/SlipSkidIndicator.tsx)
was reviewed for appearance and bounded lateral travel. This is an independently
authored Vue component, not the MSFS provider or a complete Garmin emulator.

The adapter uses ArduPlane IMU-0 calibrated body specific force. Its
[transmitter](https://github.com/ArduPilot/ardupilot/blob/master/libraries/GCS_MAVLink/GCS_Common.cpp)
converts acceleration to milli-g in both RAW_IMU and SCALED_IMU. RAW_IMU's generic
wire description does not establish those units for another firmware; decoding
here is restricted to the selected ArduPlane peer and primary sensor ID.
SYS_STATUS must report present, enabled and healthy accelerometers. Missing or
stale health, acceleration older than two seconds, sensor saturation and normal
load at or below 0.2 g make the indication unavailable. It is never centered as a
substitute for missing data.

Apparent-force deflection is atan2(-lateral g, normal g). A coordinated bank with
zero lateral force stays centered; heading, track, bank and yaw rate do not drive
the ball. Yonder maps ±10° to full travel; this scaling is not claimed as a Garmin
physical calibration or aerodynamic sideslip angle. Movement uses a 180 ms display
transition, disabled for reduced-motion preference. Invalid data removes the ball
immediately. The optional compact `i` tuple carries lateral g, normal g, age and
source ID without changing v1 columns. Old services show unavailable. Explicit
stream setup requests RAW_IMU at 5 Hz after the existing requests.

## Verified

- Core MAVLink/cockpit suite: 297 tests in 19 files passed; dashboard: 713 tests in
  58 files passed. Core build and production widget build passed.
- Chromium walkthrough passed at laptop, tablet landscape/portrait and phone
  sizes. Actual ball and wind targets open their panels. Screenshots show the
  ball beneath the bank pointer without covering tape digits or either inset.
  Existing map expansion, traffic framing, zoom preservation and own-trail
  controls passed. Browser fixture emitted no vehicle requests.
- Isolated ArduPlane 4.7.1 flight: mission upload/readback, takeoff, direct-to,
  one-shot heading, altitude, airspeed, both loiter directions, mission continuation
  and RTL passed. Acceleration was received during these stages, including airborne
  nonzero lateral acceleration. Measured VSI changed with the flight; FD desired
  attitude remained available in supported modes. Requested 180 m loiters averaged
  195.5 m CCW and 195.4 m CW over the test sample; direction signs were correct.
- Passive terrain check on Apple M5 Max: 60 terrain draws/s, p95 interval 25 ms,
  no steady-state geometry uploads or long tasks in the 15-second sample, no
  browser exceptions or writes, 40 terrain files loaded, AGL present. The aircraft
  was stationary on the ground; this is not a new long-distance streaming-flight
  benchmark or evidence of the same performance on an iPad.
- Ground ADS-B relay returned HTTP 200 and four actual targets within 10 NM.
  Source availability varies; this observation is not a guarantee of traffic
  density or provider uptime. Existing range/trail/failure tests passed.
- Updated the API behind the existing local 4198 preview after checking that its
  old simulator was disarmed with zero operations and no downloaded mission.
  The replacement starts disarmed. Native browser inspection confirmed the ball,
  live acceleration and touch status. The disposable flight test used a separate
  simulator and removed only its own container.

## Work still requiring discussion or additional source data

- The current scoreboard shows actual ArduPlane mode and reported/requested state.
  The protocol does not supply Garmin's lateral/vertical capture annunciations;
  a measured heading near a target must not be relabeled as an autopilot capture.
- Direct terrain-relative GUIDED targets remain unsupported by this adapter.
  Home/MSL direct-to and loiter are available; terrain mission items have their
  separate frame/support rules. No terrain datum is silently converted.
- The fixed camera background and registration gates exist. Image-aligned terrain
  warnings still require real capture-time/pose mapping and ELP lens/mount/profile
  calibration. Existing fixtures do not establish physical alignment.
- Full point-cloud viewing remains the agreed stretch goal. Prepared LiDAR-derived
  mapped surfaces are available now.

See the [walkthrough](../../cockpit-user-guide.md) for the implemented controls.
