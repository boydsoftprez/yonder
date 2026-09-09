# Flight control protocol verification — 2026-09-07

R-FLT-12/13 and R-CMD-04/05/09. The reviewed operator action owns every
command. A mode prerequisite and the requested control are sent once; telemetry,
page refreshes, reconnects and timers never originate or repeat a flight action.

## Adapter contract

All four actions enter GUIDED when necessary. A new GUIDED heartbeat must arrive
after the mode command was dispatched before the control command can leave. The
adapter rechecks the reported mode at dispatch, and refuses a stale vehicle
generation, unconfirmed action, conflicting transaction or previously unknown
command outcome. New controls require the selected autopilot to report stable
ArduPlane 4.7.1 through AUTOPILOT_VERSION. Firmware identity is forgotten on
reconnect. Optional firmware build features are still subject to the actual ACK.

| Action | Reviewed fields | COMMAND_INT encoding |
| --- | --- | --- |
| Heading | `headingDeg`, `reference: "true"`, `turnAccelerationMps2` | 43002; p1=1, p2=heading, p3=centripetal acceleration in m/s² |
| Altitude | `altitudeM`, `datum: "msl"` or `"home"`, `verticalRateMps` | 43001; frame=0 or 3, p3=vertical rate in m/s, z=altitude |
| Speed | `airspeedMps`, `accelerationMps2` | 43000; p1=0 (airspeed), p2=speed in m/s, p3=acceleration in m/s² |
| Loiter | `target`, whole-metre `radiusM`, `direction: "cw"` or `"ccw"` | 192; p1=-1, p2=1, p3=positive radius, p4=0 for cw / 1 for ccw; x/y=degrees × 10⁷, z=altitude |

Altitude and speed permit a zero rate to request the aircraft maximum. ArduPlane
rejects altitude values -1 and 0; the adapter checks these before dispatch. The
aircraft enforces its configured airspeed envelope. Terrain-relative targets are
unavailable. Radius bounds follow the firmware's unsigned 16-bit storage.

`capabilities.flightControl` describes each kind, command, firmware-known source,
availability/reason, GUIDED prerequisite and acknowledgement-only confirmation.
`VehicleOperation.action` retains the requested fields. The ACK and live measured
telemetry are separate. None of these commands reports heading/speed/altitude
capture or selected loiter radius/direction through the subscribed messages.
The operation therefore finishes **accepted**, with an unavailable effect and an
explicit explanation. Actual FMA mode and armed state come from HEARTBEAT. ArduPlane sends the
previous waypoint through POSITION_TARGET_GLOBAL_INT during an altitude slew;
that message cannot verify the slew target altitude.

AUTOLAND (26) joins the firmware-known mode picker. Optional modes remain subject
to autopilot acceptance. The service does not claim the list was advertised by
the selected aircraft.

## Source pin and firmware evidence

The adapter follows ArduPlane source commit
`dbe792162d06cab66c3475fd5556bf7a120f119e` (4.7.1):

- [Command handlers](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/ArduPlane/GCS_MAVLink_Plane.cpp)
  define the command fields, GUIDED checks and rejection conditions.
- [GUIDED controller](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/ArduPlane/mode_guided.cpp)
  retains the heading request, uses centripetal acceleration for bank limits,
  enforces airspeed limits and stores radius/direction.
- [Mode numbers](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/ArduPlane/mode.h)
  include AUTOLAND 26.
- [Official Plane command guide](https://ardupilot.org/dev/docs/plane-commands-in-guided-mode.html)
  lists these COMMAND_INT controls. The pinned implementation resolves its
  details; in particular heading p3 is acceleration, despite the XML unit label.

The dedicated smoke script checks the official binary and defaults SHA-256,
creates its own temporary simulator state and Docker container, reserves TCP 5768,
and removes only its labelled container. It never attaches to another flight.

Run after building yonder-core:

```sh
node packages/yonder-core/scripts/flight-control-sitl-smoke.mjs \
  --firmware-dir VERIFIED_FIRMWARE_DIRECTORY \
  --output docs/console/evidence/2026-09-07-flight-control-sitl.json
```

The adjacent JSON records real ACKs, measured heading after eight seconds without
resending, measured altitude and airspeed, both loiter directions and sampled
orbit radius, followed by mission resume and RTL. These geometry checks are test
evidence; they are not presented as autopilot-reported capture or radius.

## Successful isolated run

[The successful run](2026-09-07-flight-control-sitl.json) completed in 224.7 seconds.
It sent one command each for heading, altitude and speed. Heading was 0° after
the eight-second persistence check. Later steady flight reported 150.000 m above
home and 24.991 m/s airspeed for the 150 m / 25 m/s requests. The initial response
checks allow 8 m altitude and 2 m/s speed tolerance. The requested 180 m orbits
measured 195.48 m counterclockwise and 195.45 m clockwise, with angular changes
of −184.51° and +183.58° over the sampled intervals. Mission resume and RTL both
received fresh observed-state confirmation. The labelled container was removed.

The final targeted checks passed: 256 MAVLink tests across 13 files, including
40 vehicle tests, plus the yonder-core TypeScript build.

## Observed firmware limit

The first isolated run accepted a 150 m home-relative altitude with a requested
3 m/s rate, but measured altitude rose only from 119.856 m to 129.067 m over the
90-second observation window. [The retained failed run](2026-09-07-flight-control-sitl-rate3.json)
records the accepted command and timeout. The pinned controller builds its
intermediate altitude from current aircraft altitude on each update; the
requested rate is not a guarantee of achieved vertical speed. The final smoke
uses the documented zero-rate maximum setting.

## Compact snapshot behavior

`snapshot({details:false})` removes mission items, operation history and status
texts before cloning. `detailKey` hashes the bounded current detail summary and
last operation, so ordinary attitude and heartbeat samples leave it unchanged.
A changed mission, operation, firmware identity or status text triggers a detail
refresh. Full snapshots remain the default for existing callers.
