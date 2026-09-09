# Pocket 2 bench resume — 2026-09-08

Requirements: R-CAM-11, R-CAM-14, R-CAM-15, R-CAM-17, R-CAM-18, R-TEL-15.
This is hardware evidence for the deferred Task 2 and Phase 5 of the
[console instrument plan](../superpowers/plans/2026-09-04-console-instrument-library.md).
It does not claim the production integration is complete.

## Link and picture

The Raspberry Pi 4 already had `dwc2,dr_mode=peripheral` enabled. After the
bench presented the phone identity, the camera identified itself as DJI
`HG211`, completed AOA, and enabled the accessory endpoints. The initial
absence of a handshake coincided with the operator reporting that the camera
had powered off. Command route `4957` and video route `4a57` then arrived.
GStreamer decoded the latter into 1280×720 frames without a decoder error.

A fresh bench log/injection directory was used. The old injection file was
still populated; replaying it would have repeated commands from an earlier
session. A production driver must never consume that historical queue.

## Device stopping term

Five yaw bursts, each twenty `gimbal/0x0c` frames at 10 Hz and +10°/s, with
recentre between runs. Payload: `64 00 00 00 00 00 80`, receiver type 4. The
camera was secured with clearance, as confirmed by the operator. All five
runs moved about +24°, settled, and reported no limit flags.

| Run | Last observed movement after final transmitted frame | Largest observed sample gap |
|---|---:|---:|
| 1 | 574 ms | 107 ms |
| 2 | 596 ms | 151 ms |
| 3 | 601 ms | 105 ms |
| 4 | 562 ms | 112 ms |
| 5 | 514 ms | 111 ms |

The measurement tailed the raw capture, decoded the attitude pushes, and
observed the session's actual transmit log, using one board monotonic clock
and a 5 ms polling interval. Movement was accumulated in 0.2° increments to
avoid treating a single telemetry count as motion. The final 500 ms of every
run contained an unchanged yaw reading. Raw pushes arrive nominally at 20 Hz,
but delivery is batched; the largest observed gap above is part of the
measurement uncertainty, not something the nominal rate removes.

Use **800 ms as a conservative engineering allowance for the device term**:
601 ms observed, rounded up after allowing for the worst observed delivery
gap and the polling interval. This is a measured allowance, not a guaranteed
mechanical maximum. Browser command age and any remaining forwarding lease
must be added and measured separately. The old approximate 500 ms device
statement is insufficient as a complete browser-loss bound.

A separate pitch check reconfirmed that field 2 of `0x0c` is pitch and that
positive wire rate decreases reported pitch: +5°/s for one second moved
0.0° to −6.9°; −5°/s returned it to +0.1°. Field 0 is yaw. The plan's
pitch/roll/yaw wire-order sentence is incorrect; use yaw/roll/pitch.

## Mode and recentre

`gimbal/0x44`, one byte `00`, `01`, or `02`, changed the mode bits in attitude
byte 6 to 0, 1, and 2 respectively. Modes 0 and 1 held the centred pose.
Returning from 1 to Follow (2) moved pitch toward the mounting orientation,
about +93°, without a limit flag. **Mode selection is a motion command**;
changing the reported mode is not evidence that the camera held its pose.

Recentre `gimbal/0x4c 02 01` returned the unflagged +93° pose to +0.2° and
completed the between-run returns without flags. The earlier recorded
recentre-from-limit stall was not repeated. It remains evidence to refuse
that operation, not a test that needs another motor stall.

## Camera controls

Readback below means a change in an unsolicited camera status push, not the
acknowledgement. `01` acknowledgements also occurred for commands which had
no observed effect.

| Operation | Wire payload | Observation |
|---|---|---|
| Manual exposure | `2/1e 04 00` | `0x81` byte 20 becomes 4 |
| ISO 100–6400 | `2/2a 03` through `09` | all seven native codes read back individually; code 9 reports actual ISO 6400 |
| Shutter 1/60 | `2/28 01 3c 80 00` | bytes 2–4 become `3c 80 00`; mean luma 19.12 at ISO 100 |
| Shutter 1/1000 | `2/28 01 e8 83 00` | bytes 2–4 become `e8 83 00`; mean luma 1.63 at ISO 100 |
| Shutter 1/100 and 1/500 | reciprocal values 100 and 500 in the same four-byte shape | both read back exactly in Manual; 1/30 and 1/250 did not and remain unavailable |
| Exposure compensation | `2/2e 0a` through `16` | all thirteen codes read back; −2 to +2 EV in thirds, code 16 means zero |
| White balance | `2/2c 00 00`, `06 28`, `06 41` | Auto, custom 4000 K and 6500 K; custom mode 6 plus temperature 40/65 both read back |
| Program exposure | `2/1e 01 00` | mode 1, automatic ISO 0; mean luma returns to about 107 |
| Shutter priority | `2/1e 02 00` | mode 2; shutter requests are clamped: 1/30 returned 1/60, 1/250 returned 1/100 |
| Single/continuous autofocus | `2/24 01` / `02` | `0x87` byte 0 changes `85` / `86` |
| Focus point | `2/30`, two little-endian float32 values | `(0.25,0.25)` and `(0.5,0.5)` return at offsets 13 and 17 of `0x87` |
| Photo/video mode | `2/10 00` / `01` | `0x80` byte 4 changes 0 / 1 |
| Photo size code | `2/12 04 01` / `05 01` | `0x81` byte 9 changes 4 / 5; actual file dimensions have not been inspected |
| Record format | `2/18 10 03 01 00 00` / `10 06 01 00 00` | five bytes change rate code at `0x81` byte 14 from 6 to 3 and back; the earlier three-byte forms were ignored. Actual file rate has not been inspected |
| Colour tone | `2/3e 01` / `00` | `e0` response; no demonstrated colour control |
| Filter | `2/42 01` / `03` | acknowledged; no demonstrated filter change |

The shutter encoding follows DJI's public
[`ShutterReq`](https://github.com/dji-sdk/Onboard-SDK/blob/master/osdk-core/modules/inc/payload/dji_camera_module.hpp):
a mode byte followed by a three-byte shutter value, with the reciprocal flag
in bit 15. The
[public camera dissector](https://github.com/o-gs/dji-firmware-tools/blob/master/comm_dissector/wireshark/dji-dumlv1-camera.lua)
provides candidate state offsets; the operations above establish which
candidates this Pocket 2 actually answers. In particular, `0x32` is an
exposure-metering region command, **not a second focus command** as the old
bench queue described it.

Image measurements decoded three-second clips after each command had time to
settle, resized to 160×90 RGB, and measured the last complete frame. These
show a shutter effect, not calibrated photometry. Focus readback alone does
not establish sharpness on a different subject.

Auto white balance reports a changing temperature, so completion must match
mode 0 without requiring the request's zero temperature placeholder. Decoded
4000 K and 6500 K clips had red/blue mean ratios 0.615 and 1.007 respectively,
with 373 and 363 frames decoded successfully. This establishes a picture
effect as well as register readback; Auto was restored afterward.

## Recording and photos on the camera card

The camera initially reported no card, correctly: the operator later confirmed
it had not been inserted and then inserted it. With the card recognized,
`0x80` flags became `0x00800200`, card state 0, total size 29807 and free size
29234 in native units, consistent with MiB on the fitted 32 GB card.

Record start `2/02 01` produced state 2 and flags `0x00800280`. After four
seconds, the timer read 4, free space fell to 29203 and remaining recording
time fell from 3955 to 3951. Stop `2/02 00` first produced state 3 (finalizing),
flags `0x008002c0` and timer zero, then state 0 (idle). **Timer zero alone does
not establish that recording has stopped.** A photo-mode command during
finalizing was acknowledged but ignored.

After observed idle, photo mode `2/10 00` took effect. Photo `2/01 01` produced
photo state 1 plus the storing flag (`0x00880208`), then idle; free space fell
from 29200 to 29188 and remaining photos from 2381 to 2380. Native recording
and photo operations are therefore demonstrated. Files remain on the camera
card; filenames, downloads and actual file dimensions/rates are not inferred.
The camera was returned to video, Program exposure and continuous autofocus.

Battery request `13/02` to camera type 1 returned `e0`. Unsolicited set 5/id 6
matches a public battery packet family, but its 40-byte Pocket variant has
not been correlated with the camera's displayed percentage. Battery remains
unknown; camera status byte 46 is not used as a substitute. Native video
resolution, rotation/flip and zoom retain the earlier
[USB bench findings](dji-pocket-2-over-usb.md): this is not a V4L2 device, and
probing the attached UVC camera says nothing about the Pocket 2's controls.

## Silent link during the resume

Later, all inbound picture and state data stopped while the USB controller
still reported `configured`. The bench process and its reader/talker threads
remained alive, with no Python exception in the journal. A subsequent probe
refused to move the gimbal because attitude was stale. The operator was asked
to check camera power. The cause is not yet confirmed. Production liveness
must therefore depend on fresh protocol traffic, not USB enumeration alone.

Recovery in this session: stop the bench processes, remove the gadget, leave
it absent for at least 45 seconds, and present the phone identity again in a
fresh session. `HG211` completed the new handshake in about 0.8 seconds and
resumed both channels. No additional cable action was requested between
teardown and that successful handshake. Recovery must discard the previous
motion generation and command queue.

The reusable `scripts/spikes/gimbal-stop-bound.py` was also run on the
recovered link: +5°/s for one second moved +7.0°, settled with an observed
560 ms tail, and recentre returned to the preceding pose without a limit.
Its stale-state refusal was exercised before reconnect. The shell wrapper
runs the five Task 2 yaw bursts with recentre between them, and stops on
any refused or invalid measurement. Pass `--mounted-ready --logdir <fresh-logdir>`
only after securing the camera and checking clearance.

## Power correlation and media clock

Both silent-link events closely preceded under-voltage reports from the Pi.
The first last-attitude observation was at approximately 2606.37 seconds on
the board's monotonic clock, followed by under-voltage at 2607.65 seconds.
The second was approximately 3636.28 seconds, followed by under-voltage at
3637.83 seconds. Two further voltage dips were logged. The association points
to the board supply, but voltage at the pins was not measured independently.
The operator was asked for the supply rating and wiring. The bench was stopped
and its gadgets removed after the second stalled session; testing a motion
against stale status was refused before any rate was sent.

The decoded media record timestamps advance by 33 or 34 milliseconds: 114
H.264 records span 3770 ms, about 29.97 frames/s. In contrast, probing the raw
SPS reports `60000/1001`. A production pipeline must preserve the measured
frame timing or explicitly verify its interpretation; the SPS-derived value
alone is not a measurement of delivery cadence.

## Production transport

The DUML/AOA framing, separated H.264/AAC parsing, expiring owner-bound intent
and Linux FunctionFS transport are implemented and independently reviewed.
The transport owns its resources, bounds actual endpoint syscalls, invalidates
identity on unexpected detach, and refuses automatic reuse after uncertain
cleanup. It never consumes the bench injection queue. A real preparation
failure established that the complete `ffs.<instance>` name counts toward the
kernel's limit; separate short instance names fixed it.

## Production driver after the operator's update

The operator confirmed that the card had not been inserted earlier, inserted
it, and reported that the camera had powered down after inactivity. The original GPIO feed came from a 2.4 A USB supply port. The operator
subsequently replaced that source, as described below.

With the camera responding again, the corrected Linux driver ran for 80.143
seconds: 5,094 validated DUML messages, 2,330 H.264 records, and a `live` state
until the test deliberately closed it. The first 120 saved records decoded to
1280×720. Card-inserted became true with flags `0x00800200`. The handshake
reached `live` in about 1.2 seconds, and closing cleaned up the helper and its
owned gadgets. One 66 ms gap appeared among the usual 33/34 ms media timestamp
intervals; no zero-loss claim is made.

A continuous private bench session was subsequently prepared so the pings can
continue while camera operations are verified. The camera stopped answering
between the bounded proof and that continuous session; the operator was asked
to power it on again. The continuous driver subsequently supported the recording, photo and
control measurements above. The full console integration has a separate
acceptance check; a bench operation alone does not prove the browser path.

## Existing hardware is the target

After changing the GPIO supply, the operator observed that removing that lead
left the Pi running, consistent with camera-side VBUS reaching the Pi's 5 V
rail. That observation explains another power path; it does not establish
that an added adapter is necessary. The operator explicitly required this
integration to work with the equipment already available. The earlier adapter
recommendation is withdrawn as a prerequisite.

The GPIO lead was confirmed reconnected to the stronger supply. Subsequent
checks included periods with current under-voltage bits clear, followed by
further brief dips and USB interruptions. Historical `0x50000` flags are
distinct from current `0x50005` faults. The production transport retired each
silent connection and restored fresh video/status after its 45-second retry
interval, without resuming previous motion.

A reversible runtime CPU-frequency cap of 1.2 GHz, down from 1.8 GHz, reduced
the observed interruption frequency. The first minute, including tilt
movements, stayed live; a longer five-minute sample still included one
voltage-linked interruption. This is a useful load experiment, not evidence
that the supply problem is eliminated. No boot clock configuration was changed.
The operator subsequently replaced the supply again, removed the ELP camera,
and explicitly requested normal CPU operation. The ondemand governor and
1.8 GHz ceiling were restored and remain the test configuration. No persistent
CPU cap was installed, and lowering the ceiling is no longer part of this work.

A full-speed observation lasted 305.79 seconds with 150 voltage samples:
all current under-voltage readings were clear and the ceiling remained
1.8 GHz. Native video stayed on the same USB generation at about 29.97 fps.
The encoded pipeline retried twice in the first approximately 30 seconds,
then remained stable for the remaining approximately 275 seconds. This proves
that observed interval, not an absence of future voltage dips or restarts.

## Measured operating profile and normal flags

With the handle stationary, Follow mode centred near yaw −40.1° and pitch 0°.
Yaw rate reached soft stops near −80° and −0.4°, with the limit flags still
clear. Pitch down stopped near −8.1°; upward movement to +36.3° was traversed
without flags. These are observed operating bounds, not claimed full factory
mechanical ranges. Positive public pan/tilt increases reported yaw/pitch;
the pitch sign is inverted when encoding the wire command.

Four combined poses near yaw −60°/−20° and pitch −5°/+20° returned through
recentre without flags, with reported roll zero. The dev configuration initially used
an interior Follow region and a narrower central recentre region from those
checks. The operator's later orientation tests supersede that approach:
world-angle regions are not transferable gimbal geometry and must not gate
portable rate control. Other mode trajectories are not filled in from factory figures.

Recentre `4/4c 02 01` also changes modes 0 and 1 to Follow (2). Its endpoint
is not invariably level: one near-vertical FPV return remained near +92.5°.
Direct Follow-to-FPV and Free-to-FPV changes produced different pitch paths.
Near vertical in FPV, a yaw command appeared primarily in reported roll.
These observations prevent a generic centred-pose or whole-mode sign claim.

Normal attitude flags were repeatedly `0x80` or `0xa0`; treating every bit
above the two verified limit bits as a fault incorrectly disabled all live
motion. The decoder now excludes only those measured normal bits. Fault mask
`0x5c` retains bits 2, 3, 4 and 6 as inhibitions. A literal CRC-valid frame
from the capture and all limit/fault combinations cover the correction.

## Integrated source and pipeline evidence

The deployed daemon successfully created its FunctionFS resources inside the
service sandbox, detected `DJI Pocket 2 (HG211)`, and adopted it through the
normal configuration API. The existing UVC camera and configured absent-camera
entry were retained. The bench service released USB ownership to the
persistent daemon source for these integration checks. A later announced
maintenance handoff returned ownership to the private orientation probe.

The daemon's private framed endpoint delivered 1,338 H.264 records in a
45-second observation. The first 150 saved records decoded as 1280×720. A
45-byte trailing non-picture unit produced a finite-capture boundary warning;
all 150 picture frames decoded. No zero-warning or end-to-end preview claim
is inferred from that native-input check.

The initial preview composition had an independently reproducible defect:
with no enabled main outputs, its main tee had no consumer. The host's pad
probe does not drain it. An actual GStreamer comparison on the Pi produced
`not-linked (-1)` with the default property and exited cleanly with
`allow-not-linked=true`. The composer now sets that property, retaining both
encoders, the separate preview and later recorder attachment. This is
consistent with the [GStreamer tee contract](https://gstreamer.freedesktop.org/documentation/coreelements/tee.html#tee:allow-not-linked).

Source review also corrected directional refusals being used as a global
lock, and camera/gimbal writers contending for one endpoint. One active and
one waiting write now retain their original expiry and cancellation; safe
inward directions are judged separately. A mode/recentre action that expires
before admission cannot leave an interlock for a command that was never sent.
Browser teardown and generation changes retire the held pointer as well as
its credential.

The combined suite passed 4,020 tests before the final mode-interlock fix;
that fix passed 144 focused tests, a fresh core build and its mutation checks.
The code reviews are recorded separately from physical acceptance. Full
browser preview, both camera surfaces/palettes and five complete browser-loss
stop measurements remain open during the camera workspace revision.

The operator deliberately restarted and moved the Pi during later checks;
those restarts are not classified as crashes. Its camera configuration survived.
The administrator credential was compared with the pre-deployment backup and
was unchanged; an existing login was verified and used successfully.
No password reset was performed.

## Camera workspace and orientation revision

The operator reported missing thumbnails, overlapping Aim and READY content,
popup messages over controls, duplicate Live/Setup navigation, hidden Keep/Revert
actions, and an outside-envelope refusal after changing the physical placement.
The [camera workspace revision](../superpowers/specs/2026-09-08-camera-workspace.md)
addresses these as a connected usability problem. The missing thumbnail chain
was found in earlier repository history; a CSS image fix alone cannot restore it.

For new measurements the operator confirmed the handle was horizontal with
its screen facing up, then placed it upright and confirmed clearance again.
Each movement below consists of five native rate frames at 5 degrees/second
over approximately half a second, followed by a second of observation. Angular
movement is measured from the reported unit quaternion, avoiding Euler branch
and near-vertical ambiguity. Positive wire pitch is the opposite of public tilt.

| Placement | Wire axis and direction | Quaternion movement | Gimbal flags throughout |
|---|---|---:|---|
| Horizontal, screen up | yaw + / − | 4.814° / 5.010° | `0xa0` |
| Horizontal, screen up | pitch + / − | 4.769° / 4.804° | `0xa0` |
| Operator-positioned upright | yaw + / − | 4.815° / 4.820° | `0x00` |
| Operator-positioned upright | pitch + / − | 4.675° / 4.810° | `0x00` |
| Sideways, before mode cycle | yaw + / − | 4.846° / 4.670° | `0x00` |
| Sideways, before mode cycle | pitch + / − | 4.830° / 4.706° | `0x00` |
| Sideways, settled native Follow | yaw + / − | 4.840° / 4.830° | `0x00` |
| Sideways, settled native Follow | pitch + / − | 4.820° / 4.955° | `0x00` |

The horizontal reported pitch was approximately 89.7°, and the upright
reported pitch approximately 178.9°. Both placements would fail the old
world-angle envelope despite these successful native movements. An upright
stationary sample contained 41 unique quaternion observations over 4011 ms,
with maximum pairwise angular variation 0.00163° and maximum delivery gap
101 ms. A no-rotation watchdog threshold remains an engineering choice, not
a factory joint limit or proof of joint movement while the body moves.

The signed word at offset 8 changed by about −4.8° during an upright +4.8°
yaw movement, but remained almost constant during the horizontal yaw pulses.
DJI's SDK identifies this field as body-relative yaw on supported products;
these Pocket observations do not yet establish a portable joint-angle model.
It is not used to invent a pan or tilt stopping margin.

The private probe's first handoff session stopped sending protocol traffic
near monotonic 927.7 s; the Pi logged under-voltage at 928.64 s and normal
voltage at 934.69 s. The driver recovered automatically after its retry
interval. All movements above occurred after fresh status returned, with the
CPU ceiling still 1.8 GHz. A prior clean five-minute interval does not erase
this later observed dip.

Recentre and the sequence Follow → mode 0 → mode 1 → Follow were also
observed in the upright and sideways placements. Every recorded gimbal flag
remained zero and each target mode appeared in fresh status. Upright recentre
turned yaw from approximately −154.5° to +25.7°. Sideways recentre changed
reported pitch from approximately −90.1° to −179.7°, and returning to Follow
later selected a representation near pitch 180° and roll −90°.

At that settled sideways pose, native yaw pulses rotated the world quaternion
by approximately 4.84° while the reported Euler triplet ended unchanged. Tilt
pulses produced large Euler branch jumps despite only approximately 4.8° of
quaternion rotation. This directly rules out Euler differences as a portable
movement or stopping measurement. Native discrete operations are admitted as
the measured device commands, with fresh status, fault/hard-limit refusal,
operator ownership, deadlines and target-mode readback retained; no world-box
trajectory certificate is claimed.

The operator declined an additional upside-down hand-held check because it
would require an open-ended hold. That request was withdrawn. No fourth
physical placement is claimed, and completion of the software correction does
not depend on further manual repositioning.

## Deployed control and interface corrections

The unified Camera surface, RAM thumbnails, inline transaction area and native
control updates were deployed. An actual browser showed a decoded 640×360 live
preview and a real active-camera thumbnail with frame age. Desktop widget bounds
had no intersections. A remaining full-rate explanation overflow was corrected
by giving that control the same content-height treatment as the variable panels.
The Name draft/Discard path was exercised and the original name retained; live
Apply/Keep/Revert and both-palette/narrow-layout acceptance remain to finish.

Normal intent cancellation was found to retire USB with the exact reason
`Pocket 2 active write canceled`. An already-admitted physical write now settles
under its original deadline and session signal; command cancellation still
prevents queued and future writes. Late completion cannot resume old intent.
This distinguishes ordinary release/renewal from a genuine link failure.

The native motion context also performed unnecessary fresh configuration reads
for the obsolete world-profile guard. A deterministic 1.95-second sequence of
40 attitude pushes and 20 renewals made 319 configuration callbacks before the
fix and none afterward. Public configuration/identity lookups remain fresh; no
configuration cache or relaxed freshness limit was introduced.

After verifying the corrected module on the board, the production API sustained
six renewals for each pan and tilt direction and stopped with clear flags,
unchanged USB generation and no pipeline restart during those four runs. Measured
quaternion movements were 5.010°, 4.945°, 4.964° and 5.996°. A subsequent expiry
case exposed a write being started too close to its original deadline. The
controller now reserves 200 ms within that deadline at scheduling and actual
queued admission. Budget-only skips leave the controller healthy and a fresh
credential can continue; a real write error still faults the transport.

An isolated production expiry check then passed: six renewals, approximately
2.129° of observed movement, zero admitted rate after expiry, unchanged control
and media generation, and no additional pipeline restart. This is a production
API expiry check, not a claim that five physical browser-disconnect runs have
been completed. The original measured device stopping allowance remains 800 ms;
the new reservation does not extend the 500 ms operator-intent limit.

The operator's additional usability feedback led to continuous captured drags,
immediate first-rate submission, request-start pacing and corrected SVG input
geometry. Fresh native controls now survive media-only timestamp discontinuities;
Picture gestures still retire with their media epoch and true USB changes still
revoke all old control.

A short optical check in native Free mode, with output rotation zero and no
mirror/flip, established the direction error. Positive public pan at 3°/s changed
reported yaw from 164.5° to 166.8° and moved room features left in the image, as
expected when looking right. The old positive public tilt, encoded as negative
native pitch, changed reported pitch from 173.8° to 176.0° and moved features up
in the image: it looked down. The wire inversion has therefore been removed.
Reported Euler-angle sign alone was not an optical-direction measurement.

The final usability bundle was installed with a successful service restart,
normal 1.8 GHz CPU ceiling and a clear current voltage alarm. Its full workspace
suite passed 4,234 tests. The camera then reported USB `not attached` while the
phone identity remained presented; the operator was asked to power it on without
holding or repositioning it. The corrected optical Up check and final live UI
acceptance are pending that camera connection. No completion of those checks is
claimed from automated tests.

During a separate network interruption the operator removed/reinserted the Pi's
card and rebooted it. Local access returned first. ZeroTier subsequently reported
ONLINE, network OK, the same managed address and a direct peer path; three mesh
pings then succeeded. No network configuration was changed for that recovery and
no specific cause of the earlier interruption was established.

## Restart interruption: corrected diagnosis

The operator correctly noted that the camera was working before the deployment
stopped the core service. Logs show that service stop tore down FunctionFS at
03:42:13 BST. The phone identity was bound at 03:42:19 and the camera completed
phone/accessory enumeration at 03:42:20. A subsequent teardown at 03:42:40–42
reported DWC2 endpoint-stop and FIFO-flush timeouts. The retry bound a phone
identity at 03:43:27 and then remained not attached.

Thus the camera did briefly enumerate after the restart. These logs do not
establish that it powered off, or why protocol traffic on the replacement
session stopped; the kernel timeouts may belong to cleanup rather than the
initiating failure. No under-voltage entry appeared in that interval. The
working session was interrupted by the deployment, and automatic recovery
failed. Asking the operator to handle the camera is not a resolution of that
restart/recovery defect. No further service or USB restart was performed during
this inspection while the operator could not access the device.
