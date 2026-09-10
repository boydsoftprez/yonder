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

## Range-bit comparison and current recovery point

The private probe was installed with the original configuration, USB helpers,
video pipeline and other service processes preserved. The planned core restart
used 45.06 seconds of USB absence and restored the camera to a stable run.
All 3680 core tests and the core build passed before installation.

At the same negative pan stopping point (reported yaw -160.7, pitch 130.2,
mode 0), standard `0x80` produced 0.0012 degrees of rotation, and the bounded
`0x84` comparison produced 0.0105 degrees. Both sent ten requests without a
reported refusal, fault or limit. Neither produced meaningful additional travel.
The range flag therefore is not established as a solution and remains absent
from ordinary controls.

A subsequent native mode change to mode 1 was accepted but raised status bit 1.
Movement testing stopped. The flag persisted after settling, at approximately
pitch 132, roll 4, yaw -159.5. Hands-on power-cycle recovery was requested;
no reverse, recenter or further mode command was sent while the flag was set.
Do not repeat mode comparisons at an already-stalled endpoint.

The existing bit labels need renewed investigation. The mobile SDK's
`DataGimbalGetPushParams` labels status bit 0 pitch, bit 1 roll and bit 2 yaw.
Earlier local notes labeled bit 1 yaw after observing world-yaw movement, which
does not establish the physical joint when the handle is reoriented. The current
guard blocks all nonzero input for these states, so protection remains, but its
axis interpretation must not be used as proof of native pan travel.

DJI's SDK also documents the speed command in a world-related reference frame.
The limited sweep may therefore involve a different physical joint than the
operator intends in the present placement. Next: record the actual handle
orientation after recovery, compare from a central pose, and establish the
appropriate native joystick or coordinate conversion using bounded inputs.
This is a working hypothesis, not a completed full-range fix or a reason to
remove the native safeguards.
