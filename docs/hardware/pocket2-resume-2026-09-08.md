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
| ISO 100 | `2/2a 03` | byte 5 becomes 3; image darkens |
| Shutter 1/60 | `2/28 01 3c 80 00` | bytes 2–4 become `3c 80 00`; mean luma 19.12 at ISO 100 |
| Shutter 1/1000 | `2/28 01 e8 83 00` | bytes 2–4 become `e8 83 00`; mean luma 1.63 at ISO 100 |
| Program exposure | `2/1e 01 00` | mode 1, automatic ISO 0; mean luma returns to about 107 |
| Shutter priority | `2/1e 02 00` | mode 2; shutter requests are clamped: 1/30 returned 1/60, 1/250 returned 1/100 |
| Single/continuous autofocus | `2/24 01` / `02` | `0x87` byte 0 changes `85` / `86` |
| Focus point | `2/30`, two little-endian float32 values | `(0.25,0.25)` and `(0.5,0.5)` return at offsets 13 and 17 of `0x87` |
| Photo/video mode | `2/10 00` / `01` | `0x80` byte 4 changes 0 / 1 |
| Photo size code | `2/12 04 01` / `05 01` | `0x81` byte 9 changes 4 / 5; file dimensions remain unverified without a usable card |
| Record format | `2/18 10 03 00` / `10 06 00` | acknowledged; no observed change in format/rate readback |
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

## Storage and remaining evidence

The operator initially reported a card fitted, but the camera consistently
reported `0x80` flags `0x00800400`: card-inserted bit clear, card state 1
(no card), and zero total/free capacity, remaining shots and recording time.
Photo `2/01 01`, record start `2/02 01`, and stop `2/02 00` were acknowledged
without a recording state or timer change. The operator was asked to check
that the card is seated and recognized. **No recording or photo-file success
is claimed.** The camera was returned to video mode, Program exposure and
continuous autofocus, with recording stopped.

Battery request `13/02` to camera type 1 returned `e0`; that does not provide
a battery percentage. Do not reinterpret a changing unknown status byte as
battery. Native video resolution, rotation/flip and zoom retain the earlier
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
