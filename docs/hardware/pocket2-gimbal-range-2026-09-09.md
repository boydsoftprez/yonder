# Pocket 2 usable gimbal range investigation

R-CAM-11 requires usable pan and tilt across body orientations. The operator
confirmed the camera secured, the whole moving head clear, and hands-on access
available for endpoint checks. The starting camera was already in Free mode.

## Standard-rate baseline

All moves used the existing guarded aim API and native `4/0x0c` flags `0x80`.
Each burst requested one axis at 3 degrees/s for one second, then stopped and
waited 1.2 seconds before measuring. Each completed burst away from an endpoint
rotated approximately 4.2–4.7 degrees, including the native stopping tail.
The camera run and USB generation remained unchanged.

At reported pitch 134.8 degrees and roll zero, positive pan stopped at reported
yaw -81.1 degrees. Reversing normally was immediately possible; negative pan
stopped at -161.3 degrees. The observed span was approximately 80.2 degrees.
At both endpoints the API accepted the commands but rotation fell below
0.002 degrees, with no reported native limit or fault. These are world-attitude
measurements in this placement, not validated handle-relative joint coordinates.

A later small tilt change to 130.2 degrees left the negative pan stop at about
-160.7 degrees. A small pose change between runs prevents calling the sub-degree
yaw difference a precise endpoint shift. The earlier large difference from the
published controllable pan span warrants a controlled command-path comparison.

## Bounded private range probe

DJI Onboard SDK's `Gimbal::SpeedData` names bit 2 as `extend_control_range`.
The mobile SDK speed-control bytecode independently corroborates the ordinary
control-authority bit `0x80`; bit 6 is ignore-user-stick, not range extension.
Support for the aircraft SDK's range bit on HG211 remains a hypothesis until
measured. It is not enabled by ordinary browser controls or saved configuration.

The private Unix-socket aim API accepts `probe-issue` only for a reserved bench
owner. Its normal console request grammar rejects that operation. A probe uses
flags `0x84`, restricts input to one axis at no more than 3 degrees/s, and expires
after two seconds even if credentials continue arriving. Original one-use
credentials, 500 ms freshness, queued-write deadlines, native fault/limit guards,
and mode/source cancellation still apply. Explicit Stop or a new ordinary issue
retires the probe; ordinary input retains `0x80`.

A separate private `probe-state` operation returns the latest validated raw
attitude payload for protocol investigation. It sends no camera commands and
withdraws stale/disconnected raw data. It does not promote unknown payload fields
to joint-position measurements in the interface.

Tests cover normal versus probe flags, rate/diagonal refusal, bounded duration,
queued-write cancellation, native limits, owner/console isolation, and stale raw
feedback. Hardware range-bit comparison is the next step; the normal-rate
baseline alone does not establish a production range fix.
