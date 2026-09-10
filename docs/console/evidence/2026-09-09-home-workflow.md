# Planning and controller home workflow

R-FLT-04. The Home screen separates local mission metadata from a command that
changes the aircraft's home reference. It can be opened from Mission controls,
the expanded flight-plan HOME row, or the map-position menu. The HOME map marker
opens the same editor. Neither opening it nor editing its fields sends a command.

## Behavior reference

Mission Planner was inspected at commit
[`0cdb16308e751bedc649aa2ede3567ad96cd2ae8`](https://github.com/ArduPilot/MissionPlanner/tree/0cdb16308e751bedc649aa2ede3567ad96cd2ae8).
Its [PLAN Set Home Here handler](https://github.com/ArduPilot/MissionPlanner/blob/0cdb16308e751bedc649aa2ede3567ad96cd2ae8/GCSViews/FlightPlanner.cs#L6626)
fills planning coordinates/elevation; the field handlers update
`PlannedHomeLocation`. Its [DATA Set Home Here handler](https://github.com/ArduPilot/MissionPlanner/blob/0cdb16308e751bedc649aa2ede3567ad96cd2ae8/GCSViews/FlightData.cs#L4854)
obtains terrain elevation, asks the operator to confirm the onboard reference
change, sends `DO_SET_HOME` using `COMMAND_INT`, and reads home back. The public
[PLAN guide](https://ardupilot.org/planner/docs/mission-planner-flight-plan.html)
and [DATA guide](https://ardupilot.org/planner/docs/mission-planner-flight-data.html)
describe those separate surfaces. These are behavioral references; Yonder's
component and command adapter are independently implemented.

Yonder uses one touch screen with distinct actions rather than overloading a
single Set Home Here action. Manual elevation is always available. **Use terrain
elevation** reads the explicitly selected prepared EGM96 source and states its
provenance; missing coverage or incompatible height references leave the value
unavailable. It does not silently substitute an elevation estimate. Public-tile
elevation lookup outside a prepared package is not included in this control.

## Protocol and reference handling

The tested firmware is official ArduPlane 4.7.1, source
[`dbe792162d06cab66c3475fd5556bf7a120f119e`](https://github.com/ArduPilot/ardupilot/tree/dbe792162d06cab66c3475fd5556bf7a120f119e).
The [common command handler](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/libraries/GCS_MAVLink/GCS_Common.cpp#L5501)
treats zero/zero coordinates as current location. Yonder rejects that sentinel
in its explicit-coordinate controller action. Planning metadata can still
represent a legitimate zero/zero geographic location.
The [Plane home handler](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/ArduPlane/GCS_MAVLink_Plane.cpp#L562)
locks an explicitly set home and re-enters RTL/QRTL when applicable, which can
redirect the aircraft. Review names that consequence.

The typed `set-home` action carries the requested latitude, longitude and MSL
elevation plus the previously reported home (or explicit null). The server
validates bounds and confirmation, checks vehicle identity and the home reference
at admission, and checks home again immediately before writing. It uses integer
geographic coordinates, waits for command 179 acceptance, requests HOME_POSITION
with command 512, and requires a subsequent matching response from the selected
autopilot. Comparison tolerance is 2e-7 degrees and 0.1 m, accommodating wire
representation; a mismatching or absent response is not an observed success.

The mission's planning home remains separate throughout. A planning edit does
not renumber waypoints or remap jumps. WPL export carries the edited planning
record. Aircraft upload continues to use the reported controller home and shows
that elevation in review. Home-relative waypoint numbers are unchanged; their
planned MSL heights change when the planning elevation changes. Current-location
takeoff uses planning home in route/list geometry and stays unresolved without
one. Setting home does not set an EKF origin or supply a live position.

## Validation

Core tests cover confirmation, coordinate bounds/sentinel, stale home at admission
and before send, rejection, wrong peer, mismatching readback and ACK-only timeout.
UI tests cover units, map selection with preserved elevation, local Undo, WPL
export, first-leg geometry, readback/plan separation and no send before review.
The disposable `packages/yonder-core/scripts/home-sitl-smoke.mjs` verifies manual
home initialization, first mission upload, and a subsequent home update both with
GPS disabled and enabled. Its simulator never arms, changes mode or starts a
mission, and its port is bound to localhost. Physical controller home changes
remain an explicit operator action.
