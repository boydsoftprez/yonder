# PFD wind display evidence — 2026-09-07

Requirements: R-FLT-03, R-FLT-12, R-FLT-16.

## Behavior and source boundary

The PFD now has a touch wind box beside the lower airspeed tape, above the mission
inset. Component view is the default. Positive headwind points down; positive
crosswind (from the right) points left. Vector and direction/speed views rotate a
blowing-toward arrow relative to aircraft heading. Numeric bearings are FROM
bearings referenced to true north. Components are horizontal, heading-relative
values, not a ground-track or runway-crosswind calculation.

The community [wind component](https://github.com/microsoft/msfs-avionics-mirror/blob/main/src/garminsdk/components/nextgenpfd/wind/WindDisplay.tsx)
and [data provider](https://github.com/microsoft/msfs-avionics-mirror/blob/main/src/garminsdk/wind/WindDataProvider.ts)
were reviewed for the three display options, component signs, arrow direction and
no-data behavior. The Vue presentation is authored in this repository; it does
not run the MSFS event bus or its ambient-wind provider. That provider's simulator
on-ground/TAS/ADC validity and smoothing are not represented as available MAVLink
signals. This adapter explicitly displays an estimate instead.

ArduPlane's [WIND transmitter](https://github.com/ArduPilot/ardupilot/blob/master/ArduPlane/GCS_MAVLink_Plane.cpp)
uses a signed FROM bearing from its north/east wind estimate. The [MAVLink WIND
message](https://mavlink.io/en/messages/ardupilotmega.html#WIND) reports horizontal
speed in m/s, converted to knots. This message has no estimator confidence flag;
ArduPlane can transmit an unconverged estimate. The box says EST and its touch
panel explains why a fresh zero is not verified calm.

Only the selected ArduPlane system/component supplies this estimate. Invalid
messages clear it, five seconds without a sample expires it, and vehicle/link
replacement clears it. Missing heading or unavailable flight telemetry hides
arrows and values. Wind does not substitute inferred IAS/groundspeed differences
or an external weather API.

## Wire and stream setup

The v1 column order is unchanged. Optional `w` contains three numbers: true FROM
bearing, knots and sample age. Older clients ignore it; older services produce an
unavailable wind display without borrowing prior details. Decode rejects malformed
or stale tuples. The extra wind tuple is small (the regression fixture adds fewer
than 70 JSON bytes per flight response). Mission/history/geography separation is
unchanged. The operator's existing stream-setup action now requests WIND at 1 Hz,
after the existing requests, without adding requests on load/reconnect.

## Validation

- Core tests exercise wire-level selected-peer decoding, signed bearings, invalid
  data, freshness, link/identity changes, compact compatibility and explicit 1 Hz
  stream setup.
- Presentation tests exercise all four cardinal component signs, north wrap,
  heading versus track, invalid/zero estimates, actual rendered arrowheads, vector
  direction, unavailable states and touch preference emission.
- Core MAVLink/cockpit suite: **295 tests in 19 files passed**.
- Dashboard suite: **709 tests in 56 files passed**.
- Core TypeScript/assets and production dashboard widget builds passed.
- Chromium fixture walkthrough passed at 1440×900, 1024×768, 768×1024 and 390×844.
  It clicks the actual wind box at each size, changes view, verifies bearing text,
  checks saved Off across reload and restores it through PFD Menu. No vehicle
  requests or browser exceptions occurred. Existing map/mission/trail checks pass.
- Screenshots were inspected for tablet/phone readability and placement: the wind
  box stays clear of tape digits, attitude reference, HSI and both insets.
- Restored the stopped API behind local preview port 4198 with a newly isolated
  ArduPlane SITL instance, initially MANUAL/DISARMED. Passive reads through the
  browser proxy returned the actual wind tuple (example: 90.0533° FROM,
  0.7850 kt, sample age 275 ms). Native browser inspection confirmed the live wind
  box and touch panel. No arming, mode, mission or flight commands were issued.

This validates transport and display behavior, not convergence or accuracy of an
in-flight wind estimator. The preview simulator remains operator-controlled.
