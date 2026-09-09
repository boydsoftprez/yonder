# QuadPlane vertical takeoff to the cove route

Requirements: R-FLT-18, R-FLT-02/04, R-CMD-04/09.

The native preview supports `--model quadplane` with the verified official
ArduPlane 4.7.1 executable, upstream QuadPlane physics and checksummed defaults.
The source is identified as **ArduPlane QuadPlane SITL**. Startup remains disarmed
and passive. This work does not configure or command a physical aircraft.

**Load VTOL cove example as local draft** selects an explicit variant: item 01 is
`NAV_VTOL_TAKEOFF` at 54.864 m (180 ft). The thirteen original geographic route
items remain unchanged at 91.44 m (300 ft). Item 02 is the first geographic
waypoint. The original example remains separate. A transition command is not
inserted: ArduPlane owns the normal transition after its VTOL takeoff completes.
See [ArduPlane's mission behavior](https://ardupilot.org/plane/docs/quadplane-auto-mode.html).

Mission start is above the mode list, immediately below Arm/Disarm. A draft now
explains why start is disabled and directs the operator to upload/verify and
**Show aircraft mission**. No action is sent by loading the example or switching
the displayed mission. Existing command review and identity/revision checks stay
in place.

## Verification

- Dashboard: 715 tests across 58 files passed; production build passed.
- Chromium fixture walkthrough passed at laptop, tablet, portrait and phone
  sizes, with no vehicle requests.
- The separate `quadplane-sitl-smoke.mjs` used a newly created, uniquely labeled
  simulator on its own loopback port. It uploaded the same VTOL mission, selected
  QLOITER, armed through normal checks and sent one mission-start request.
- Measured climb stayed near the takeoff position, completed near the requested
  180 ft target and continued toward the 300 ft route. EXTENDED_SYS_STATE reported
  multicopter, transition-to-fixed-wing and fixed-wing states. Mission progress
  passed the first geographic waypoint. The smoke removed only its own container.
- Evidence and observed values are in [the result](2026-09-07-cockpit-vtol.json).

An initial test assertion used millimetre tolerance for ArduPlane's centimetre
mission storage; it was corrected to one centimetre. A subsequent run physically
flew the route but the test's extra transition-status request used incorrect
node-mavlink parameter property names. The request was corrected, made a checked
precondition before flight, and the complete flight test passed. These were test
observation issues; no arming checks or flight assertions were bypassed.

## Limits

The preview tests one standard QuadPlane model and its upstream tuning. It does
not validate other airframes. The vertical takeoff height is relative to the
takeoff point under standard QuadPlane settings, which is home in this fresh
ground-start demo. Re-executing takeoff in flight can add that height to the
current altitude. The example contains no landing command. Selecting QLOITER
alone does not command a climb; the demonstrated launch uses the AUTO mission.
The flight-mode display remains AUTO during the mission; dedicated VTOL phase
annunciation is not added by this change.
