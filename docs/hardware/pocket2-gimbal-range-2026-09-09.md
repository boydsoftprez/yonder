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

## Recovered native-joint measurements and resolution

After the operator power-cycled the camera, status limits cleared and mode 1
(FPV) was observed. The handle was horizontal, screen facing up. Isolated normal
`0x80` pan and tilt bursts established the physical-joint fields in HG211's
`gimbal/0x05` payload: signed tenths at offsets 8 (pan), 20 (tilt) and 22 (roll).
These measurements differ from the world Euler angles at offsets 0, 2 and 4.
The decoder exposes native joints only for a recognized HG211 with a complete,
plausible payload and valid quaternion. Retained numeric payload fixtures cover
horizontal, upright and FPV positions; they contain no camera images.

With ordinary control flags and FPV, native pan reached approximately -227.2 to
+70.9 degrees: 298.1 degrees of travel. Tilt reached -100 to +49.9 degrees,
approximately 150 degrees. Endpoint commands settled without a native fault,
and reversing away from the stops worked. One earlier tilt sample included
operator control input and was excluded from the commanded-motion comparison.
The completed sequences preserved the video run and USB generation.

The original 80-degree world-yaw sweep was therefore not the native pan span.
When the horizontal handle is held in a level-maintaining mode, another joint
can limit a world-referenced move. FPV allows the measured native travel. The UI
now states that mode distinction and reports position relative to the handle;
it does not infer a fixed mapping from world Euler angles. Native limit bits
are labeled pitch, roll and yaw in that order, and every limit still inhibits
motion. Recenter is labeled "Recenter in Follow" because the camera changes mode.
The experimental range-extension flag remains absent from normal input.

## Six saved positions (R-CAM-23)

Aim includes six named slots with Save current position, Recall, Rename, Clear
and a visible Stop during recall. Save obtains fresh, settled joint feedback
from the device; the browser cannot supply substitute angles. Presets belong
to the configured accessory camera and use the handle-relative HG211 reference
in FPV mode. They are not geographic or compass targets. Recall does not switch
modes automatically. Moving the camera mount changes the view associated with
its saved handle-relative positions.

Recall approaches the saved joint values using ordinary speed commands, capped
by the operator's speed setting and 60 degrees/s. It never wraps an asymmetric
pan target through an end stop. Fresh one-use browser grants retain the existing
500 ms expiry, transport deadlines, mode/source cancellation and native fault
safeguards. Stop, manual input or lost browser intent retires the recall; it does
not resume automatically. Missing progress and a bounded timeout stop a target
that cannot be reached. This is an explicitly requested camera move, not an
independent aircraft control action.

Preset edits are revision-checked and saved through the configuration engine.
The metadata-only path verifies every other configuration field is unchanged,
then journals and saves without invoking network or video renderers. Concurrent
edits are refused rather than overwriting a newer slot. Tests exercise long
native paths, arrival, cancellation, stale data, faults, concurrent edits and
configuration isolation. Hardware preset verification is recorded separately
when completed; the measured native range above does not by itself prove recall.

## Installed validation

Signed source `500297c` was installed on the development Pi with targeted core,
console middleware and four widget bundles. The 45.06-second USB pause restored
video automatically; its new run remained stable for more than 30 seconds.
Configuration and existing secrets were unchanged by activation; media serving
and telemetry routing kept their process instances. The full suites passed 3704
core and 949 widget tests, followed by an additional stale-arrival regression
and the final core build.

The operator then saved two positions through the page while retaining the same
video run and zero restarts. A separate scripted recall check detected changed
position before issuing a command and stopped; operator movement and preset use
were observed instead. Thus persistence and uninterrupted video were verified
live, while a controlled hardware arrival/Stop accuracy check remains pending.
The implementation owner is the Pocket 2 camera task. No test overwrites the
operator's saved slots.
