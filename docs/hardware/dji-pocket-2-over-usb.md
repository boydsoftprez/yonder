# A DJI Pocket 2 on the USB port

**2026-09-11 resolution correction (R-CAM-15):** 720p is the USB live feed
observed in our tested modes, not a proven limit for every Pocket 2 mode.
[DJI's own specifications](https://www.dji.com/pocket-2/specs) list live-view
quality as 480p for 4K/60 recording, **1080p for Story Mode**, and 720p otherwise.
The [Mimo livestream guide](https://repair.dji.com/help/content?customId=zh-cn03400006728&spaceId=34)
also lists 1080p streaming for Pocket 2, but does not establish the native
resolution of the USB accessory stream. A transmitted 1080p output alone does
not distinguish native pixels from an app upscale or a different transport.

The earlier H1 SDK getter/setter stub finding is real evidence about those
specific handlers in the inspected library. It does **not** prove that no other
mode-entry path can change the feed. Historical statements below that the
question is closed or that no phone-side lever can exist are superseded by this
qualification. Existing tests still establish 1280×720 at approximately 30 fps.

Community follow-up: [OpenPocketCine's live-view notes](https://openpocketcine.app/docs/protocol/live-view/)
report 720p monitoring on newer cameras over Wi-Fi, independently of recording
resolution; they do not demonstrate Pocket 2 USB 1080p.
[o-gs camera command names](https://github.com/o-gs/dji-firmware-tools/blob/master/comm_dissector/wireshark/dji-dumlv1-camera.lua)
include racing-liveview and LCD/HDMI output controls, but names alone establish
neither Pocket 2 support nor working payloads. Pocket 3/4 UVC implementations
use a different USB interface and cannot establish this camera's capability.

The next discriminating experiment is to observe Pocket 2 Mimo Story Mode entry,
inspect the source H.264 SPS dimensions before any scaling, and compare its
mode-entry messages with normal video mode. A usable Yonder path must sustain
native 1920×1080 with operator-controlled gimbal behavior; an edited story clip,
upscaled output, or temporary mode screen is insufficient. No new camera
commands or mode changes were sent during this literature/source review.

### Community source audit, 2026-09-11 (R-CAM-15)

A deeper GitHub repository/code/issue search found useful protocol leads but no
reproducible native Pocket 2 USB 1080p implementation in the sources inspected.
This is a search result, not proof that the camera cannot do it.

- **Concrete stream configuration:**
  [djictl configuration builder](https://github.com/xaionaro-go/djictl/blob/ddeced5422fe3a27075602d41b49e61ca60c99d8/pkg/djible/interface_app_to_video_transmission_start_live_stream.go)
  constructs DUML `08/78` with resolution, bitrate, FPS, and RTMP URL.
  Its [resolution mapping](https://github.com/xaionaro-go/djictl/blob/ddeced5422fe3a27075602d41b49e61ca60c99d8/pkg/duml/resolution.go)
  encodes 1080p as `0x0a`, 720p as `0x04`, and 480p as `0x47`.
  The builder includes a captured example; its 1080p/6000-kbps payload begins
  `00 32 00 0a 70 17 02 00 03 00 00 00`, followed by the packed URL.
  Starting uses `02/8e` with `01 01 1a 00 01 01`, after preparation and Wi-Fi setup.
  The [author's research](https://github.com/xaionaro/reverse-engineering-dji/tree/5c9278ff0b53bbe0d03ea6c830aab13ac775871e)
  reports success on **Pocket 3**, with a BLE dissector. These are RTMP controls,
  not a verified USB monitor-resolution setter. Do not transplant them into the
  Pocket 2 startup sequence without model-specific evidence.
- **Related implementations are not independent Pocket 2 confirmations:**
  [osmo-live](https://github.com/KevinCowleys/osmo-live/tree/77f4901acb14b76446e341d01f84a8c9c78c1116)
  is a Go port of [node-osmo](https://github.com/datagutt/node-osmo), offers 1080p
  RTMP, and reports personal testing on Action 4. Listed targets are newer Action
  models and Pocket 3. [coolboy's protocol work](https://github.com/coolboy/dji-osmo-ble-protocol)
  also targets Pocket 3 BLE/RTMP.
- **Pocket 2-specific viewer:**
  [OpenJetson/Pocket2-Viewer](https://github.com/OpenJetson/Pocket2-Viewer)
  demonstrates the relevant USB-to-Jetson approach, but its repository exposes
  no implementation or native-resolution evidence. Both
  [issue 1](https://github.com/OpenJetson/Pocket2-Viewer/issues/1) and
  [issue 2](https://github.com/OpenJetson/Pocket2-Viewer/issues/2) report missing
  downloads/source, with no replies returned in this audit.
- **Firmware investigation lead:**
  [original-Pocket extraction script](https://github.com/sharklatan/dji_firm_osmo_pocket_extractor/blob/cd1fe4357238ff2c1635febe55e9fd37ffb1190c/extract_firmware_complete.py)
  outlines LZ4 → SquashFS extraction. The inspected tree contains only a README
  and script, despite the README describing extraction results. No Pocket 2
  compatibility or encoder patch was established. Inspecting matching Pocket 2
  firmware handlers could be a fallback to capturing Mimo's Story Mode transition.
- **Older USB transport work:**
  [samuelsadok's USB mobile protocol](https://github.com/samuelsadok/dji_protocol/blob/master/usb_mobile_protocol.md)
  documents iOS transport on Mavic RC/Goggles, not Pocket 2 resolution control.
  [PocketControl](https://github.com/leandrowicher-lang/PocketControl) currently
  describes Pocket 1 USB enumeration only, with live view still unimplemented.

Priority remains a Pocket 2-specific Story Mode capture and source-SPS check.
Use the community field mappings as comparison clues, then trace the exact
Pocket 2 handler that changes the encoder. No downloaded project code was run,
and no camera command was transmitted during this audit.

**2026-09-08 resume:** the camera is back on the dev Pi. See the
[resumed bench evidence](pocket2-resume-2026-09-08.md) for measured stop timing,
mode trajectories, shutter/focus readbacks, and the unresolved card detection.
The dated evidence there supersedes older untried rows below where stated.

The Pocket 2 is on the compatibility list and it is not a UVC camera. This note records
what the device told us, what the manufacturer's own software told us about how to talk to
it, and what happened when Yonder's board did. **The last section is a decoded frame.**
The sections are ordered from observed to inferred; the final one says what remains
unproven.

Requirement: R-CAM-15. Milestone: M5 — moved there from M9 on the strength of the bench
result below.

## What the board saw as a host

<!-- yonder:hardware-observed -->

Plugged into the Raspberry Pi 4 dev board — the Pi acting as USB host — through the
camera's bottom USB-C port:

| Field | Observed |
|---|---|
| USB id | `070a:4026`, manufacturer string `AmbarellaInc`, product `A9 Platform`, serial `0001` |
| Configurations | **1**, `bMaxPower 100mA` |
| Interfaces | **1**: Mass Storage, SCSI, bulk-only, endpoints 1 OUT / 2 IN |
| SCSI INQUIRY | vendor `DJI`, product `Pocket`, revision `1000`, `version=0x00` — no conformance claimed; every VPD page request answered with the standard INQUIRY |
| Block device | `/dev/sda`, "Media removed" — the microSD slot |
| Video nodes | none |
| Date | 2026-09-03 |

**This is not a camera presenting itself to a host; it is a stub.** One minimal
interface, 100 mA, a SCSI implementation that claims nothing. It is what the device
offers when it sees a host and has nothing to say to one.

## The camera is the host

The Pocket 2 talks to a phone, and on that link **the camera is the USB host and the
phone is the device** — Android Open Accessory (AOA), a published protocol
([source.android.com](https://source.android.com/docs/core/interaction/accessories/aoa)).
Three facts from the manufacturer's Android application (DJI Mimo, the store release
dated 2026-08-20, read statically) said so before anything was tried: its manifest
declares the `android.hardware.usb.accessory` feature; its accessory filter accepts
exactly manufacturer `DJI`, model `HG210` or `HG211`; and its native SDK has a
`dji::core::AoaServicePort` feeding the same session manager that receives video.

### What the camera did when the board became a phone

With the Pi's USB-C port in device mode, presenting as an ordinary Android phone
(`18d1:4ee1`), the camera — on its **bottom** port, with a plain USB-C cable — did this
within 0.8 s of the gadget appearing, every time it was tried:

```
SETUP bmRequestType=0xc0 bRequest=51 wLength=2      GET_PROTOCOL  → answered 2
SETUP bmRequestType=0x40 bRequest=52 wIndex=0       manufacturer = 'DJI'
SETUP bmRequestType=0x40 bRequest=52 wIndex=1       model        = 'HG211'
SETUP bmRequestType=0x40 bRequest=52 wIndex=2       description  = 'DJI Pocket'
SETUP bmRequestType=0x40 bRequest=52 wIndex=3       version      = 'v0.0.0.1'
SETUP bmRequestType=0x40 bRequest=52 wIndex=4       uri          = 'www.dji.com'
SETUP bmRequestType=0x40 bRequest=52 wIndex=5       serial       = '000000000000000'
SETUP bmRequestType=0x40 bRequest=53                START
```

`HG211` is the Pocket 2; `HG210` is the original Osmo Pocket. When the board then
re-presented as an accessory (`18d1:2d00`, one bulk IN and one bulk OUT), the camera
enumerated it and began talking at once.

### What that means for the board

**Yonder's board must be a USB *device* on this link.** On a Raspberry Pi 4 the only
device-capable port is the USB-C, which is also the power input, so **the Pi 4 must be
powered from the GPIO header or a PoE HAT** for this camera. A Pi Zero 2 W or 3A+ has a
separate OTG port. This is an installation constraint no other camera imposes.

Two things about the board that cost time and are worth knowing:

- Raspberry Pi OS ships `config.txt` with `dtoverlay=dwc2` lines under `[cm4]` and
  `[cm5]` section filters. **Editing those does nothing on a Pi 4B.** The overlay must be
  under `[all]`; `scripts/pocket2/enable-gadget-mode.sh` owns its own stanza there.
- When the phone-stage process closes its FunctionFS endpoint, libcomposite unbinds the
  gadget from the controller by itself. An explicit unbind afterwards reports `ENODEV`.
  The driver tolerates it and retries the accessory bind, which then succeeds first time.

On header power the board reported `throttled=0x0` — not one brownout across the whole
session — which is the first clean reading this board has given ([K-41](../known-issues.md#k-41)).

## The link, as observed

Everything on the accessory pipe is wrapped in an 8-byte envelope:

```
55 CC  r1 r2  <length, u32 little-endian>  <length bytes of payload>
```

Two routes were seen, and they are two channels:

| Route | Carries | Observed |
|---|---|---|
| `49 57` | DUML command frames, several back to back | 2,676 envelopes, 14–562 bytes, in a 7 s session |
| `4a 57` | **H.264 and AAC media records** | 313 envelopes, almost all 8,192 bytes; 1.55 MB in 7 s |

Zero bytes fell outside an envelope in 2.2 MB of capture. The board sends on route
`49 57`; the camera answered every frame sent that way.

DUML itself is exactly as the public documentation describes it — `0x55`, a 10-bit length
and 6-bit version, CRC8 (reflected `0x8C`, seed `0x77`), sender and receiver with the
device type in the low five bits, sequence, a type byte with the response bit at the top
and the ack request in bits 5–6, command set, command id, payload, CRC16 (reflected
`0x1021`, seed `0x3692`). Every frame from the camera checked out. Device types seen: 1
camera, 4 gimbal, addressed to 2, the app.

### What the camera says unprompted

Before the board says a word, the camera pushes, per second: gimbal attitude
(`gimbal/0x05`, 45 bytes) ×20, gimbal `0x19` and `0x27` ×20, camera state
(`camera/0x80`, 68 bytes) ×20, camera status blocks `0x81`, `0x87`, `0x88` ×10, `0xdc`
×5, `0x8a` ×2, and a few slower housekeeping messages on sets 0, 5 and 238. None asks for
an acknowledgement.

### What it answered

| Board sent | Camera answered |
|---|---|
| general `0x00` ping | response, status `0x01` |
| general `0x01` get version | response, status `0x01` |
| general `0xff` get device info | response, status `0x01` |
| general `0x0e` heartbeat, once a second | response, status `0xe0`, every time |

Addressed correctly, sequence numbers matched, within 20 ms. Status `0x01` on the three
information requests is not yet understood — it may mean "not on this link", it may mean
the payload was expected to carry something — and it did not matter for the picture.

### The picture arrives on its own

**No live-view subscribe was sent.** The video route began within a second of the
accessory being enabled, and again on every subsequent run. Each video segment is preceded
by a 16-byte record beginning `00 00 01 ff` — a frame header, decoded below — followed by
media payload in 8 KB chunks. H.264 records carry an SPS (`67 64 00 28`:
High profile, level 4.0), PPS, access-unit delimiters, SEI, and an IDR roughly every two
seconds. Average rate about 1.7 Mb/s, with bursts to 8 Mb/s at a keyframe.

Fed to GStreamer on the Pi — `filesrc ! h264parse ! avdec_h264` — the route `4a 57` bytes
decode without complaint to **1280×720** frames. One of them is a room, a wall, and a
lamp: the camera on the desk, pointing at the ceiling.

### Moving the gimbal

The attitude push (`gimbal/0x05`) decodes as three little-endian `int16` in 0.1°: pitch,
roll, yaw. Pointing at the ceiling on the desk it read pitch 89.8°, roll −4.7°, yaw −90.6°.

The first round of gimbal commands was addressed to the **camera** (device type 1). Every
one was answered — `0x4C` with status `0x01`, the angle commands with `0xe0` — and nothing
moved. Addressed to the **gimbal** (device type 4) the same bytes did this:

| Sent to `gim0` | Payload | Attitude after |
|---|---|---|
| `4/0x4C` reset and set mode | `02 01` — YawFollow, reset | roll −4.7° → 0.0°, then **pitch 89.8° → 0.2°**: the camera swung from the ceiling to level |
| `4/0x14` absolute angle | `d4 fe 00 00 00 00 01 14` — first field −30.0° | **yaw −90.4° → −30.8°**. The first field drove yaw, not pitch; the layout is not the dissector's guess |
| `4/0x0A` extended control | −30.0°, speed 10 | no clear effect |
| `4/0x01` control, three mid-range values | `52 03` ×3 | a drift of a degree — mid-range is a centred stick |
| `4/0x4C` again | `02 01` | yaw −31.4° → −90.8°, pitch and roll to 0.0°, within half a second |

Three things follow. **The receiver device type is the whole difference**; the sender
index (`app0` or `app1`) changes nothing. **Status `0x01` is the camera's acceptance**,
not a refusal — every command that moved the gimbal returned it. And **recentre is one
two-byte frame** to the gimbal: `55 0f 04 a2 02 04 <seq> 20 04 4c 02 01 <crc16>` with
`app→gimbal` in the address bytes, which `scripts/pocket2/duml.py` produces as
`encode(4, 0x4C, b"\x02\x01", receiver=DEV_GIMBAL)`.

### Incremental control, as mounted

With the frame understood, the sweep was rerun in **incremental mode** — mode byte `0x00`,
one second per move — with the camera lying as it will be mounted, and the guard judging
faults rather than gravity:

| Steps | Result |
|---|---|
| yaw +10° ×3, −10° ×6, +10° ×3 | −8.5 → 21.4 → −38.3 → −8.2: every step within 0.2° |
| pitch −10° ×2, +10° ×3, −10° | 0.2 → −19.9 → 10.1 → 0.2: every step within 0.2° |
| recentre before and after | clean, no limit flag at any point |

Thirty moves, no refusal, no flag, no surprise. **Incremental angle control is exact and
safe in the mounted orientation**, which is the orientation that matters: an aircraft
mounts the camera however the airframe allows, never handle-up. The bench rule is now
"as mounted", and the range is found by stepping until the camera's own limit flag
lights, never by commanding past it.

### The range, as mounted — found by the flag, never by force

Ten-degree incremental nudges in each direction until the camera raised its limit flag,
then the same nudges back. Centre was yaw −8.8°, pitch 0.0°, with the camera lying as it
will be mounted:

| Direction | Stop | Flag | Steps back |
|---|---|---|---|
| yaw + | **+52.5°** — 61° from centre | bit 1 | 7, landing at −9.1° |
| yaw − | **−68.9°** — 60° from centre | bit 1 | 7, landing at −8.6° |
| pitch down | **−24.8°** | **bit 0** | 3, landing at 0.2° |
| pitch up | **beyond +100°** — no flag; the guard's own window ended the search | — | 11, landing at −9.8° |

Sixty moves, one refusal (the guard's window at +110°), every stop announced by the
camera and every return exact. **Bit 0 of the limit byte is pitch; bit 1 is yaw.** Bit 5,
on at rest, went off above 90° of pitch, so it is a "within normal range" status rather
than a limit.

The asymmetry is the mounting talking, not the gimbal: the manufacturer rates tilt at
−100° to +50°, and here "down" found a stop at −25° because down is into the desk and
the body, while "up" ran past +100° into open air. **The usable envelope is a property of
the installation.** So the daemon does not carry the specification's numbers; it learns
the envelope with exactly this procedure once the camera is mounted, keeps the four
angles it found, and clamps every aim command to them — with the camera's own flag as the
backstop it should never reach.

### Rate mode — the joystick

A joystick is a stream of rate frames, not an angle. Bursts of twenty frames at 10 Hz,
addressed to the gimbal, guard boxing every frame at 20°/s:

| Message | Payload | Two seconds of it | Result |
|---|---|---|---|
| `gimbal/0x0C` custom speed | yaw +10°/s, flags `0x00` | — | nothing, either direction |
| `gimbal/0x0C` custom speed | yaw +10°/s, **flags `0x80`** | −8.8° → +15.2° | **moves at the commanded rate** |
| `gimbal/0x01` motion control | first stick +300 of 1024 | pitch 0 → +17.9° | **moves — but the first field is pitch** |
| `gimbal/0x01` | first stick −300 | pitch back to −0.3° | |
| `gimbal/0x01` | third stick +300, one second | yaw +10.7° | the third field is yaw |
| `gimbal/0x01` | neutral | holds | |

So both rate paths exist, and they differ:

- **`0x0C` is the one to build on.** Yaw, roll, pitch in 0.1°/s — real units — and the
  flags byte must carry `0x80`, which the manufacturer's public source names
  *gimbal control authority*. With it clear the frames are accepted and ignored.
- `0x01` takes three stick values centred on 1024, about 300 counts to 9°/s, in the
  order **pitch, roll, yaw** — not the order the public dissector guessed. Usable, but
  units are a stick, not a rate.

The confirmation run, all under `0x0C` with `0x80`:

| Sent | Result |
|---|---|
| pitch +10°/s for 1 s | pitch 0.0° → **−13.4°**: positive rate is nose-down on this camera |
| pitch −10°/s for 1 s | back to +0.5° |
| yaw −10°/s for 2 s | −9.0° → −33.0°: 24°, twice now |
| **one frame**, yaw +10°/s, then silence | **+5° and stops**; unchanged two seconds later |
| yaw +10°/s and pitch +5°/s together, 1 s | yaw +14°, pitch −7°: both axes at once |

So **a frame is valid for about half a second.** Twenty frames over two seconds plus that
tail is 2.5 s at 10°/s: 25°, and the head moved 24° — the rate is accurate. The daemon
streams at 2 Hz or better to sustain motion, and **a lost link stops the gimbal within
half a second**, which is the property a joystick over a radio needs and here comes free.
The pitch sign is inverted relative to the attitude push; a convention, recorded.

### The gimbal reports its limits

The attitude push carries more than angles. Bytes 6–11 of `gimbal/0x05`, watched
across the run above:

| Moment | byte 6 | byte 10 |
|---|---|---|
| Before any command | `42` | `a0` |
| After `4/0x4C` reset, mode 2 | `82` (`a2` while moving) | `a0` |
| Holding yaw at −30.8° after the angle command | `82` | **`a2`** — bit 1 set, on and off, for six seconds |
| After recentre, and ever since | `82` | `a0` |

Byte 6 bits 6–7 went from 1 to 2 the moment the reset-and-set-mode frame landed — that
is the mode field, and it confirms the command took, independently of the movement.
**Byte 10 bit 1 is a limit flag.** It came on only while the gimbal was being held
against the end of its yaw travel, and went off when it was released. The public
dissector names this byte "limit/status flags for pitch, roll, yaw"; which bit is which
axis needs one more run, one axis at a time.

So a limit is not something to infer from the picture. It arrives twenty times a second
on the same link as the video, and it belongs on the overlay as an annunciator
(R-TEL-15).

### The yaw sweep

Absolute yaw (`4/0x14`, first field) stepped in 30° increments from centre (−90.9° in
the camera's frame), four seconds per step, reading the attitude and the limit byte after
each:

| Commanded | Reached | Limit bit 1 | What the gimbal did |
|---|---|---|---|
| −60° | −60.0° | off | exact |
| −30° | −30.0° | off | exact |
| 0° | **−22.5°** | **on** | stopped 68° from centre: the end of travel that way |
| +30° | −89.8°, pitch 85.9° | off | **went over the top**: unreachable in yaw, so it pitched vertical |
| +60° | +42.9°, pitch −38.3° | on | reached the number by combining pitch and yaw |
| −120° | −120.0° | off | exact |
| −150° | −144.9° | on | slowing into the stop |
| −180° | −155.8° | on | the stop that way, about 65° from centre in this mode |
| −210° … −300° | pitch 88°, 89°, 97° | off / `03` | over the top again, twice, and once to a 0/0/0 pose with both limit bits |

What "over the top" was, from the bench: **a mechanical click and a fast spin.** The yaw
axis reached its stop, and the controller then took the head through the pitch axis at
speed to satisfy the number. That is a way to damage a gimbal, and the sweep script asked
for it four times. `scripts/pocket2/aoa_session.py` now refuses any absolute-angle
command outside a yaw window and any single step over 45°, unless told
`--unsafe-gimbal`; the window defaults to what this sweep found safe.

Three conclusions, and the first is a rule:

- **Clamp before sending.** An absolute angle the gimbal cannot reach in yaw is not
  refused — the controller finds it by pitching over the top, which is a violent movement
  and a lost picture. The daemon must know the reachable range and never command outside
  it; the limit flag is the feedback for the edge, not a substitute for the clamp.
- **Within range the response is exact**: −60, −30, −120 landed to the tenth of a degree
  inside four seconds. Near a stop the gimbal slows.
- **Centre moves when the body moves.** The final recentre came to rest 10° from the
  first, because the camera was lying loose on the desk and the yaw motor turned the body
  under the head. On an aircraft the body is fixed and this goes away; on the bench, hold
  the handle.

The manufacturer's specification gives the controllable pan range as −230° to +70° and
the mechanical range as −250° to +90°, at up to 120°/s. The +68° stop matches the +70°
side. The −65° stop does not match −230°: in YawFollow mode the head is held near the
handle's heading, and the far side of the range is evidently reachable only in another
mode, which is the next experiment.

Byte 10, refined: bit 1 lights at a yaw stop; bit 0 appeared once with it at the 0/0/0
pose, so it is probably the pitch stop; bits 5 and 7 are on at rest and off during the
over-the-top excursions, so they are status, not limits.

### The ping is the live-view keep-alive

Left alone after the handshake, the camera sends about two seconds of video and stops.
Every live-view subscribe payload tried on `camera/0x09` and `camera/0xeb`, and every
message on the app command set, was refused with `0xe0` and changed nothing. The
listen-only run — where the board said nothing at all — got **no video whatsoever**.

The trigger is the plainest message there is. Sent once, and timed:

| Sent once | Video in the next 5 s |
|---|---|
| general `0x00` ping | **1.62 MB** |
| general `0x01` get version | 0 |
| general `0xff` get device info | 0 |

Repeated once a second for twenty seconds, the ping gave **20.2 MB — 8.1 Mb/s, about 200
NAL units a second, continuously**; the other two gave a tail-off and nothing. So the
camera streams for roughly two seconds after each ping it accepts (status `0x01`), and
**a 1 Hz ping is the whole of live view**. The session tool now sends it by default.

Held for three minutes with nothing else sent, the picture never wavered: 8.08 to 8.32
Mb/s in every fifteen-second window, 180 pings, 180 answers. A run that appeared to die
at sixty seconds turned out to be the session tool, not the camera: a bulk write hit
`EAGAIN` under backpressure and the thread that sends the pings died with it. Two
seconds later the picture stopped, as it should; **eight seconds after that the camera
dropped the link** — `Cannot send after transport endpoint shutdown` — which is the
camera's own liveness rule, and a daemon must keep talking to stay connected. The tool
now retries and never lets that thread die.

The sustained rate matters for the product: at 720p this camera delivers about 8 Mb/s
(8.23 Mb/s over 58 s of content, by the frame-record timestamps), not the 1.7 Mb/s the
burst-and-silence average suggested. That is fine on Wi-Fi or Ethernet and is far more
than a field cellular uplink carries.

**The board can bring it down itself.** Unlike the USB camera's JPEG, this stream is
H.264, and the Pi 4's hardware *decoder* (`v4l2h264dec`, the block that failed for JPEG)
handles it: 58 s of the captured stream through hardware decode and hardware encode at a
1.5 Mb/s target ran in 20 s at 114% of one core — **about 40% of one core in real time** —
and the output measured 1.56 Mb/s. So whether or not the camera can be told to send less,
Yonder can re-encode this source to whatever the link will carry, at a cost the board has
room for. That is the cellular answer for this camera; asking the camera is an
optimisation.

A detail for the daemon: the camera emits about 1.3 frame records per frame (some access
units are split), so the record count is not a frame count; the timestamps are.

**Camera-side stream control is unproven, and not for want of trying.** Ten *get*
requests — video-out parameters, video format, recording info, capability info, ISO,
shutter, the I-frame request — every one answered with a single status byte and no data:
on this link **a get returns nothing; the camera's state is what it pushes.** Twenty-two
*set* payloads on `0x4c` video-out parameters, `0xbd` raw video format and `0x18` video
format were each acknowledged with `0x01` and left the stream at 8.0 Mb/s and 720p. As
with the gimbal's authority bit, an acknowledged frame with the wrong payload is a no-op,
and the right payload is not derivable from the library — it has no symbol table, so the
setters the SDK names cannot be traced to their wire structs without a decompiler. The
board's transcode is the plan; this is the optimisation left on the table.

### The media frame record, decoded

Every access unit on the media route is preceded by a 16-byte record. A later capture
confirmed the layout across 284 complete records: 114 H.264 and 170 AAC.

```
00 00 01 ff | u16 length low | ff | u8 length high | u8 | u8 kind | u16 | u32 timestamp
```

- `length` is the 24-bit size of the payload that follows: little-endian bytes 4–5 plus
  byte 7 as the high byte. It reaches 105,081 bytes in the capture; eight keyframes are
  larger than 64 KiB, and records with a zero low word remain non-empty when byte 7 is set.
- Header byte 6 is always `ff`. Byte 9 identifies H.264 as `11` and AAC as `24`; H.264
  begins with an Annex-B start code and AAC with an ADTS header.
- `timestamp` advances 21–34 ms per record — a 30 fps clock in milliseconds.
- The other header bytes change and are retained raw until their meaning is known.

So the daemon's job on this route is: read 16 bytes, read the full 24-bit `length`, emit
only kind `11` to the H.264 path, and consume kind `24` separately. The timestamp comes
with each record.

### The pitch run, and what it cost

The absolute-angle fields were identified cleanly: **field 0 is yaw, field 1 is roll,
field 2 is pitch.** −20° in field 1 rolled the head −19.9°; −20° in field 2 pitched it
−19.7°. Then a command to return to `[current yaw, 0, 0]` — the most innocent frame in the
run — sent the head to pitch 82.9°, yaw −123°, with **all three limit bits set**. The guard
then refused every following angle command, correctly. The run's final **recentre was not
guarded**, and a recentre from that pose folded the head to pitch −175° past the tilt stop
and left the motor stalled and buzzing. The camera was powered off by hand; **on restart
it passed its own gimbal check** and levelled quietly, so the excursion cost nothing
lasting.

What the frame actually is — found afterwards in the manufacturer's public Onboard SDK
source ([`dji_gimbal.hpp`](https://github.com/dji-sdk/Onboard-SDK/blob/master/osdk-core/api/inc/dji_gimbal.hpp)),
whose gimbal angle command is this frame on a UART:

```
int16 yaw, roll, pitch     0.1°
uint8 mode                 bit 0: 1 = absolute, 0 = incremental
                           bit 1: ignore yaw   bit 2: ignore roll   bit 3: ignore pitch
uint8 duration             0.1 s — 0x14 is "arrive in 2 s"
```

So every frame the sweeps sent was **absolute, all three axes commanded, two seconds** —
and the source says of absolute mode that *the angle reference depends on the gimbal
mode*, Follow, FPV or Free. That is the excursion: an "absolute" yaw is measured from a
reference the attitude push does not report, so a command equal to the current reading is
not a no-op once the body has turned under the head. **Incremental mode — bit 0 clear —
has no reference to get wrong**, and a joystick does not use angles at all: the same
source defines a speed command, yaw/roll/pitch in 0.1°/s, which the SDK carries as
`GimbalSpeedRotation`. That is what R-CAM-11's aim control should be built on.

Two failures of understanding, both now in the tools:

- **A gimbal already in trouble must not be commanded at all** — not even recentred. Any
  limit bit, or a head more than 60° from level, and the session tool refuses everything
  on command set 4 until the operator has put it right by hand.
- **`4/0x14` is not understood well enough to use.** A return-to-zero from a normal pose
  produced an excursion; either the yaw field is not what it appears (absolute versus
  relative to the handle), or the flags byte changes the meaning. Until a capture of the
  manufacturer's own app shows how it drives this frame, the only gimbal commands with a
  clean record are recentre from a sane pose and small yaw moves within the window.

A bench rule, corrected once by the operator: the camera lay on its side on the desk for
every gimbal run, and the first instinct was to demand it upright. **But an aircraft
mounts it however the airframe allows, never handle-up.** So the gimbal is verified as
it lies — the mounted orientation — with the incremental frames that have no reference to
get wrong, one small step at a time, and *recentre* is understood for what it is:
handle-relative, which on an airframe means "back to the mount's forward", not "level".

### Across the camera's own power cycle

With the accessory session up, the camera was switched off and on and ran its start-up
gimbal check. From the board's side **nothing happened**: no disable, no re-enumeration,
no second handshake; the attitude pushes and the sequence numbers ran on unbroken. Either
the camera keeps its host port alive through its own restart or it re-attached quickly
enough that the gadget saw no break. Either way a daemon that is up stays up through the
camera restarting, which is the property an airframe needs.

### The camera re-probes on its own

Tearing the accessory down and staying off the bus for 45 s, then reappearing as the
phone, produced the handshake again with **no replug**. Reappearing within a second or
two did not. So a daemon that restarts must wait before it returns, and a camera that
loses its phone finds it again by itself — which is the property an airframe needs.

## Parity, by message

Everything the manufacturer's own app can do with this camera is a message on this link,
and the app's command table names them all. The honest status of each, as of this note:

| Ability | Message | Status |
|---|---|---|
| Live picture | `general/0x00` ping at 1 Hz | **proven** — 8 Mb/s, 720p, continuous |
| Gimbal recentre | `gimbal/0x4C` `[02 01]` | **proven** |
| Gimbal aim, incremental | `gimbal/0x14` mode `0x00` | **proven** — 0.2° repeatability, as mounted |
| Gimbal aim, joystick (rate) | `gimbal/0x0C` custom speed (flags `0x80`); `gimbal/0x01` motion | **proven** — moves at the commanded rate, holds when frames stop |
| Gimbal mode: follow / FPV / lock | `gimbal/0x44` work mode; `0x4C` mode byte | mode byte proven as part of recentre; standalone untried |
| Selfie (turn to face the handle) | `gimbal/0x4C` with a different command byte, or `0x14` incremental ±180° | untried |
| Gimbal attitude readout | `gimbal/0x05` push | **proven** — pitch, roll, yaw at 20 Hz |
| Gimbal limit annunciator | `gimbal/0x05` byte 10, bits 0–2 | **proven** — yaw stop confirmed at both ends |
| Video / photo mode | `camera/0x10` working mode | **proven** — state push toggles |
| Record start / stop | `camera/0x02` record video | acknowledged; unconfirmable with no card |
| Take a photo | `camera/0x01` take photo | id known, untried |
| Exposure mode, ISO, EV | `camera/0x1e` (2B), `0x2a` ISO, `0x2e` EV | **proven** — each changes the picture; shutter `0x28` untried |
| White balance | `camera/0x2c` (2 bytes) | **proven** — push field changes per setting |
| Zoom | `camera/0x34` `09 00 00 <u16=(factor−1)/0.01>` | **digital only** (SDK: the Pocket 2 has no optical-zoom module), 1.0–10.0×; accepted but does not reshape the USB feed → crop client-side |
| Focus: AFC / AFS / spot | `camera/0x24` focus mode, `0x30` area, `0x32` spot | ids known, untried |
| Recording resolution and rate | `camera/0x18` video format | id known, untried |
| Sensor 16 / 64 MP | `camera/0x12` photo size | id known, untried |
| Stream bitrate for cellular | — | **solved by the board's hardware transcode, ~40% of one core** |
| Live-view resolution | — | **not controllable from the phone side**: the SDK's four H1 live-view handlers (resolution get/set, HD-live-view get/set) are stubs that never send; the camera chooses 720p and the app gets what we get |
| Digital zoom | `camera/0x34` `09 00 00 <u16=(factor−1)/0.01>` | **payload recovered & confirmed digital-only**; accepted, but the 720p USB feed does not change → Yonder crops client-side |
| Live-view quality / output format | `camera/0x1a`, `0x4c` | accepted, but the USB feed stays 720p ~8 Mb/s — the live-view is a fixed pipe |
| Focus | `camera/0x24` | not tested — fixed lens, largely automatic |
| Colour, filters | `camera/0x3e` colour tone, `0x42` digital filter | ids known, untried |
| Camera state readout: mode, rec time, battery | `camera/0x80`, `0x81`, `0x87`, `0x88` pushes | received at 10–20 Hz; **not yet decoded** |
| Battery detail | `battery/0x02` dynamic info (set 13) | id known, untried |
| Reset the camera | `general/0x0b` reboot | id known, untried |

Three columns of "untried" is the true state of parity: the map is complete, the
territory is one evening old. The order to prove them in is the order a pilot needs them:
rate-mode aim, then stream bitrate, then record, then exposure and white balance, then
the readouts — each a camera-side message with no gimbal risk except the first.

### Camera controls — proven, once the payload size was right

The first exposure pass changed nothing: one-byte payloads, all acknowledged, all ignored.
The manufacturer's public Onboard SDK gave the real struct sizes, and with those the
controls work, the effect visible in the decoded frame and mirrored in the status push:

| Control | Message | Payload | Confirmed by |
|---|---|---|---|
| Work mode photo/video | `camera/0x10` | 1 byte, 0 / 1 | state push mode byte toggles 0↔1 |
| Exposure mode | `camera/0x1e` | **2 bytes** `{mode, 0}`, 1 Program … 4 Manual | Manual drops mean luminance 122 → 14; Program restores it |
| ISO (manual only) | `camera/0x2a` | 1 byte, 3 = ISO 100 … 8 = ISO 3200 | luminance 16 / 42 / 123 for ISO 100 / 400 / 3200, monotonic; push ISO field tracks |
| White balance | `camera/0x2c` | **2 bytes** `{mode, temp}` | a push field changes per setting; luminance flat, as a colour change should be |

Exposure compensation (`camera/0x2e`, one byte, index 16 = 0.0 EV) proved the same way:
EV −2.0 dropped the frame from luminance 122 to 55 and moved the push's EV field 16 → 10;
EV −4.0 gave the same, the camera clamping to −2.0 and reporting it honestly rather than
overriding. Positive EV had no visible effect because the scene was already near full
brightness — no exposure headroom to show. So the confirmed controls are now work mode,
exposure mode, ISO, white balance and EV, each with a measured effect on the picture and a
matching change in the state push. Record (`camera/0x02`) is acknowledged but
unconfirmable with no card in the camera.

The lesson is the one from the gimbal authority bit, several times over: on this link an
acknowledgement (`status 0x01`) means the frame was well-formed, not that it did anything,
and the difference between inert and working was a payload width read from the
manufacturer's own source.

Live-view **resolution** resisted. `camera/0xbd` — the message the SDK key
`H1LiveViewResolutionFrameRate` seemed to name — was tried at one, two and four bytes
across fifteen values; every one was acknowledged and the decoded frame stayed 1280×720.
That message is not the live-view resolution control, or its payload is a structure no
guess will hit. This is the row that sends us to the decompiler.

## Where the remaining knowledge lives

Every row of the parity table above is one of three kinds of fact, and each kind has a
different source:

| Kind of fact | Source | State |
|---|---|---|
| Which message does what — the ids | the manufacturer's app, native library, by name | complete |
| Frame format, CRCs, addressing, gimbal payloads, exposure/ISO/EV/record payloads | **public** — the dji-firmware-tools dissector and the manufacturer's Onboard SDK source | in hand; gimbal proven, camera-side under test |
| Zoom, live-view quality and output-format payloads | **compiled code** in the native library — read with a locally built decompiler (`scripts/pocket2/ghidra/`) by decompiling the named senders and their callers | recovered; live-view resolution turned out to have no sender at all |
| Ground truth for anything | a capture of the manufacturer's app talking to the camera | needs an Android device; none on the bench |

**Update — the decompiler was built and the dive continued.** Ghidra's decompiler
source ships in the public release; it built for arm64 with clang in one pass
(`scripts/pocket2/ghidra/`, ~7 min), and the "no references" wall was the wrong target,
not a dead end. Decompiling the *named* functions directly — the symbols survive in the
dynamic table — gave the wire structures:

- **Live-view resolution** is a single `H1LiveViewResolutionFrameRate` enum value serialised
  as one `u32`, not a byte struct — which is exactly why the byte-shaped `0xbd` guesses were
  inert. The enum-to-code mapping turned out to be moot: the setter that would carry
  it is a stub (see below).
- **Digital zoom** is `camera/0x34` (`set_focus_zoom_para`), payload `09 00 00` then a
  little-endian `u16` = `(factor − 1.0) / 0.01` for a factor of 1.0–10.0 (so 2× = 100,
  4× = 300, 10× = 900) — **not** the `0xb8` the id table's name suggested, and the step
  `0.01` was read from the decompiled constant. Correctly addressed to the camera (device
  type 1, not the gimbal's type 4 that first sank the test) it is accepted (`status 0x01`),
  but **the 720p USB live-view does not change** across the whole range.

  Two facts settle what this means. First, **there is no optical zoom**: the Pocket 2
  (`HG211`) overrides only `SetDigitalZoomFactor` and `SetDigitalZoomFactorByStride` in the
  SDK and is wired to no optical-zoom module — those classes exist in the library only for
  DJI's optical/hybrid-zoom cameras. The Pocket 2's advertised zoom (4× at 1080p, 3× at
  2.7K, 2× at 4K) is a sensor crop, marketed as zoom. Second, **the USB live-view is a
  fixed 720p ~8 Mb/s pipe**: live-view quality (`0x1a`), output format (`0x4c`), the two
  zoom forms and the stride zoom are all accepted and none reshapes it. So zoom in the
  manufacturer's app preview is a client-side crop, and for Yonder the same holds — **zoom
  is a crop-and-scale of the decoded H.264, done on the board or in the browser**, which
  needs no camera command and composes with the transcode.

  The last candidate closed by construction. The H1 clip module's
  `SetH1LiveViewResolutionFrameRate` and `SetH1HDLiveViewEnabled` decompile to stubs — each
  invokes its completion callback with "success" and returns, sending nothing — and the
  matching getters return "unknown" and "false" without asking the camera. No other class
  implements them. So the manufacturer's app never sets the USB live-view resolution; **the
  camera chooses 720p and the app's preview is that same stream.** That is a stronger
  finding than "untried": there is no lever, and none needs building.

So the decompiler earned its build immediately: it corrected two ids that string-and-guess
had wrong. What remains below is narrowed, not abandoned.

The rest was carried as far as it goes without yet more machinery. The library was
imported into Ghidra and fully analysed (`scripts/pocket2/ghidra/`), but two walls stand
between that and the payloads:

- **The prebuilt Ghidra ships a decompiler for Linux and Windows only.** The Apple-Silicon
  decompiler must be built from source that the public release does not bundle. (The
  Python drivers hit a third wall first: Ghidra 12 dropped Jython, and JPype — PyGhidra's
  bridge — crashes the JVM on the Java 26 that is installed. The Java `GhidraScript` runs,
  which is why the analysis completed; only the decompile step has no native binary.)
- **The key-name strings have no code references.** They are the SDK's value-name and JSON
  strings, referenced through data tables the auto-analysis did not resolve to the
  command-builder functions. So even a working decompiler would not reach the builders
  from the strings; the reference to follow is the DUML command id as an immediate
  (`0xbd`, `0x4c`), which is a hand pass, not a script.

**This was stopped deliberately, on value.** The payloads still hidden are live-view
resolution, stream bitrate, digital zoom and focus. Bitrate — the only one that gates
cellular — is already solved by the board's hardware transcode. Resolution matters little
when the board re-encodes anyway, and this camera's lens is fixed, so zoom is digital and
focus is largely automatic. Weighed against building a decompiler and a manual
cross-reference pass, or capturing the real app with an Android device, none of the four
earns the cost right now. The scripts and the analysed project are kept so the pass can be
finished when a decompiler or a phone is to hand.

One correction to an earlier draft of this note: the live-view stream has only ever been
observed at 1280×720, and that was written up as "the other resolutions are recording
modes". **That is inference, and probably wrong**: the SDK key named above says the
live view's resolution and rate are a setting on this family. Untested, not impossible.

## What Yonder would build

A small daemon, `pocket2d`: present the phone identity, complete the AOA handshake, run
the DUML session with a heartbeat, split the envelopes by route, and write route `4a 57`
minus its frame headers to a local UDP port. From there the M4 pipeline is unchanged —
mediamtx serves it, the tee sends it to the ground station. To the rest of Yonder it is
one more camera source. The controls — gimbal `4/0x01` motion, `4/0x0a` angle, `4/0x4c`
recentre, `4/0x44` work mode; camera `2/0x02` record, `2/0x1e` exposure, `2/0x2c` white
balance, `2/0xb8` zoom — are frames on the same link, which is R-CAM-11 arriving from an
unexpected direction.

It is its own package, so a firmware change on the camera's side breaks one package and
not the video path.

## The bench procedure

The tools are in [`scripts/pocket2/`](../../scripts/pocket2/). Everything runs on the dev
board; the operator plugs one cable.

1. **Power the Pi from the GPIO header** — 5 V on pin 2 or 4, ground on pin 6, from a
   supply that holds 5.1 V at 3 A. The header has no protection; check polarity twice.
2. `sudo scripts/pocket2/enable-gadget-mode.sh peripheral && sudo reboot`
3. `sudo scripts/pocket2/aoa-gadget.sh run` — two gadgets are prepared; the phone one is
   bound. `SESSION_ARGS='--listen-only'` in front makes the accessory stage only record;
   `--quiet` hides the periodic pushes.
4. Connect the camera's **bottom** port to the Pi's USB-C, camera powered on. If it is
   already connected and silent, unplug and replug: the camera probes when a device
   appears.
5. `/var/tmp/aoa/phone.log` shows the handshake; `session.log` shows every command frame
   decoded and the video rate per second; `route-4a57.bin` is the video.
6. `gst-launch-1.0 filesrc location=/var/tmp/aoa/route-4a57.bin ! h264parse !
   avdec_h264 ! videoconvert ! pngenc ! multifilesink location=frame-%03d.png` gives
   frames.
7. `sudo scripts/pocket2/enable-gadget-mode.sh host` and reboot to restore the port.

## What is not yet known

- **The third field of the frame record**, which changes irregularly.
- **Resolution and bitrate control.** The stream arrived at 720p; `camera/0x4c` set
  video-out parameters is the candidate, untried.
- **Roll under rate control**, and the remaining bits of the `0x0C` flags byte.
- **Bit 2 of the limit byte** is presumably roll; roll has not been driven to a stop.
- **The range in other gimbal modes.** YawFollow gives about ±60° of yaw; the far side of
  the manufacturer's −230° pan is presumably another mode's.
- **Camera controls** — record, exposure, white balance, zoom — untried; addressed to the
  camera, they should answer `0x01` the same way.
- **What the general-set answers carry.** Ping, version and device info return status
  `0x01` and nothing else; the version is presumably elsewhere.
- **The payload of `camera/0x4c`.** Acknowledged and ignored with every small payload tried;
  the real struct needs a decompiler pass or a capture. Not needed while the board transcodes.
- **Power draw** on the link. Not measured.
- **The side port**, the phone adapter, and the original Osmo Pocket (`HG210`).

---

## The bench queue — everything one mounted session should close

The camera has been off the bench more often than on it, and every question
below has waited for it separately. They are gathered here so that the next
time it is mounted, one session closes the lot rather than five sessions each
closing one. Ordered so that an early answer cannot invalidate a later one.

**Ask this one first, because it is the only one that can be answered in a
minute and it decides whether a live defect is reachable.** Does this camera
offer `horizontal_flip`, `vertical_flip` or `rotate`?

```sh
v4l2-ctl -d /dev/videoN --list-ctrls-menus | grep -E 'horizontal_flip|vertical_flip|rotate'
```

The bench ELP offers none of the three, which is why the board learned to turn
the picture itself (R-CTL-05, `video/orientation.ts`). If the Pocket 2 offers
one of them **and an operator sets it**, it reaches a known defect recorded in
`video/renderer.ts` and pinned by `pipeline.test.ts`: the apply renderer
composes with `noCapabilities()` while the start route composes with what it
probed, so the two disagree. The pipeline is restarted once for a configuration
that did not change, and comes back turning the picture **twice** — once at the
sensor and once on the board.

Nothing on the bench can reach it today. If this camera can, it stops being a
latent defect and the fix — a capability answer both composers share, without
putting a `v4l2` sweep inside the confirmation window — needs doing before the
Pocket 2 work goes further. If it cannot, say so here and the defect stays
latent with one more camera's worth of evidence behind that claim.

**Bring:** the camera mounted as it will fly, not handle-up; a card in it; the
board on header power with `dr_mode=peripheral` (see [The bench
procedure](#the-bench-procedure)); and a way to see the picture, because half
of these are confirmed by watching rather than by a reply.

| # | Question | Why it is blocking | Closes |
|---|---|---|---|
| 1 | **Which limit bit is which axis.** `gimbal/0x05` byte 10, one axis at a time to its stop | The whole guard turns on it. Byte 10 bit 1 is confirmed as *a* limit flag; the public dissector calls the byte "limit/status flags for pitch, roll, yaw" and which is which was never separated | The guard's shape, Task 38 |
| 2 | **The stop bound after the last frame.** Browser intent to observed rest, five runs, browser disconnected with USB intact | Sets the command lease. The device timeout alone is not the end-to-end bound, and an over-long lease is travel nobody asked for | Task 2, sizes Task 36 |
| 3 | **Recentre from a limit pose** | The one recorded stall. Whether it is safe with the flag watched, or must be refused | The guard's refusal rule |
| 4 | **Standalone work mode** `gimbal/0x44`, and selfie `0x4C`/`0x14 ±180°` | Both untried; both are motion commands the guard must cover | Task 37 |
| 5 | **Shutter `camera/0x28`** | Exposure mode, ISO and EV are proven and shutter is not, so the console cannot yet offer a manual shutter on this camera | Task 39, the Pocket 2's gates |
| 6 | **Photo `camera/0x01`**, and **record `camera/0x02` confirmed with a card in** | Record was acknowledged but unconfirmable with no card. R-CAM-17 and R-CAM-18 both turn on it | Task 39, the captures panel |
| 7 | **Focus AFC/AFS/spot** `0x24`, `0x30`, `0x32`; **record format** `0x18`; **sensor size** `0x12`; **colour and filter** `0x3e`, `0x42` | Ids known, none driven. Each is drawn in the blueprint and none may ship live until it has been | Task 39 |
| 8 | **Decode the camera state pushes** `0x80`, `0x81`, `0x87`, `0x88` | Arriving at 10–20 Hz and never decoded. They carry mode, recording time, battery and card — everything the deck's placard claims to show | Task 39 |
| 9 | **Whether flip, mirror and rotation exist at all on this camera** | Newly asked (R-CTL-05). Nothing in the recovered SDK surface suggests a command, so the working answer is that the board does it — but ask the camera before assuming | Phase 8, Task 45's labelling |

**Nothing marked untried above may ship as a live control** until it has been
driven here and the effect recorded, which is this plan's own rule. The
console draws them; whether they are offered is decided by what this session
answers.
