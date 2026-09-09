# PFD turn cues and freshness (R-FLT-03, R-FLT-17, R-FLT-19)

The ball is above the HSI heading readout. The upper roll scale now has green
standard-rate bank pointers, and the HSI has a six-second heading-trend arc with
half/standard-rate marks and an overrange arrow. The ball's panel provides their
visibility controls, measured rate, estimated TAS, and unavailable reasons.

True airspeed is explicitly estimated from three-dimensional ground velocity
minus the reported wind vector. Its input ages remain independent. Indicated
airspeed is not substituted. Heading rate is calculated from ATTITUDE body rates,
roll and pitch, with rejection near the Euler singularity. No new MAVLink stream
is requested. Optional compact fields retain the v1 column order.

The initial browser check reproduced intermittent missing-ball indications:
packet receipt could be newer than the last UI clock tick, creating negative
sample ages. Elapsed time is now clamped at zero. The regression covers zero-age
packets between clock ticks, expiry and restored data. A recovered telemetry
outage clears its own notice without clearing an aircraft-command error.

Validation:

- Core MAVLink/cockpit: **301 tests across 20 files**, passed; core build passed.
- Dashboard: **720 tests across 59 files**, passed; production widget build passed.
- Browser walkthrough: laptop, tablet, portrait and phone passed, including
  actual ball touch access, placement above the heading readout, both bank
  pointers, four turn marks, and repeated checks for transient missing data.
- Live QuadPlane display: 20 observations across two seconds all retained the
  ball and valid turn rate, with no stale HTTP-error notice. Estimated TAS was
  below 50 KT on the ground, and the panel correctly explained hidden pointers.
- The existing simulator was retained during a telemetry-bridge refresh. A
  read-only mission download restored the bridge's mission view; no arm, mode,
  target or mission-upload request was issued by this work.

Dynamic turn direction, half/full standard rate, overrange, bank calculation,
invalid-source and independent-age cases are automated tests. The green pointers
were visually checked with synthetic fixture airspeed; this evidence does not
claim a new airborne validation flight. Source and licensing boundaries are
recorded in the cockpit's PROVENANCE.md.
