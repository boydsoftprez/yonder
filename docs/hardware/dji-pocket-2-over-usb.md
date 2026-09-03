# A DJI Pocket 2 on the USB port

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
session — which is the first clean reading this board has given ([K-34](../known-issues.md#k-34)).

## The link, as observed

Everything on the accessory pipe is wrapped in an 8-byte envelope:

```
55 CC  r1 r2  <length, u32 little-endian>  <length bytes of payload>
```

Two routes were seen, and they are two channels:

| Route | Carries | Observed |
|---|---|---|
| `49 57` | DUML command frames, several back to back | 2,676 envelopes, 14–562 bytes, in a 7 s session |
| `4a 57` | **H.264 video** | 313 envelopes, almost all 8,192 bytes; 1.55 MB in 7 s |

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
by a 16-byte record beginning `00 00 01 ff` — a frame header, contents not yet decoded —
followed by Annex-B H.264 in 8 KB chunks. The stream carries an SPS (`67 64 00 28`:
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

### The video frame record, decoded

Every access unit on the video route is preceded by a 16-byte record. From 104 of them:

```
00 00 01 ff | u16 length | u16 0x00ff | u32 varies | u32 timestamp
```

- `length` is the size of the H.264 that follows, to the byte (63,291 for the first
  record, which held SPS, PPS and the IDR; 512–630 for ordinary P-frames).
- `timestamp` advances 21–34 ms per record — a 30 fps clock in milliseconds.
- the third field changes irregularly and is not yet understood; `0x00ff` never changes.

So the daemon's job on this route is: read 16 bytes, read `length` bytes of Annex-B,
repeat — and it has the presentation time for free.

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
| Video / photo mode | `camera/0x10` working mode | id known, untried |
| Record start / stop | `camera/0x02` record video | id known, untried |
| Take a photo | `camera/0x01` take photo | id known, untried |
| Exposure: EV, ISO, shutter, mode | `camera/0x1e` mode, `0x2a` ISO, `0x28` shutter, `0x26` aperture | ids known, untried |
| White balance | `camera/0x2c` | id known, untried |
| Zoom | `camera/0xb8` control zoom, `0x34` focus/zoom | ids known, untried |
| Focus: AFC / AFS / spot | `camera/0x24` focus mode, `0x30` area, `0x32` spot | ids known, untried |
| Recording resolution and rate | `camera/0x18` video format | id known, untried |
| Sensor 16 / 64 MP | `camera/0x12` photo size | id known, untried |
| Stream resolution and bitrate | `camera/0x4c` video-out parameters | id known, untried — the one that matters for cellular |
| Colour, filters | `camera/0x3e` colour tone, `0x42` digital filter | ids known, untried |
| Camera state readout: mode, rec time, battery | `camera/0x80`, `0x81`, `0x87`, `0x88` pushes | received at 10–20 Hz; **not yet decoded** |
| Battery detail | `battery/0x02` dynamic info (set 13) | id known, untried |
| Reset the camera | `general/0x0b` reboot | id known, untried |

Three columns of "untried" is the true state of parity: the map is complete, the
territory is one evening old. The order to prove them in is the order a pilot needs them:
rate-mode aim, then stream bitrate, then record, then exposure and white balance, then
the readouts — each a camera-side message with no gimbal risk except the first.

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
- **Bitrate control.** The sustained stream is about 8 Mb/s at 720p; nothing yet sets it
  lower. `camera/0x4c` set video-out parameters remains the candidate.
- **Power draw** on the link. Not measured.
- **The side port**, the phone adapter, and the original Osmo Pocket (`HG210`).
