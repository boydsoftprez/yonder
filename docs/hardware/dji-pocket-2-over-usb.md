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

### The camera re-probes on its own

Tearing the accessory down and staying off the bus for 45 s, then reappearing as the
phone, produced the handshake again with **no replug**. Reappearing within a second or
two did not. So a daemon that restarts must wait before it returns, and a camera that
loses its phone finds it again by itself — which is the property an airframe needs.

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

- **The 16-byte video frame header.** `00 00 01 ff` then twelve bytes that change per
  frame — timestamps or a frame counter, most likely. The decoder ignores them; a
  clean stream should strip them.
- **Resolution and bitrate control.** The stream arrived at 720p; `camera/0x4c` set
  video-out parameters is the candidate, untried.
- **The `0x14` absolute-angle field order.** The first field moved yaw; which fields are
  pitch and roll, and what the two trailing bytes mean, needs one more round.
- **Which limit bit is which axis** in byte 10 of the attitude push. Bit 1 is yaw; bit 0
  is probably pitch; roll has not been driven to its stop.
- **The reachable yaw range as the camera itself defines it**, so the clamp has a number.
  The sweep found about +68° and −65° from centre in YawFollow mode; the mechanical
  range is wider and mode-dependent.
- **Camera controls** — record, exposure, white balance, zoom — untried; addressed to the
  camera, they should answer `0x01` the same way.
- **What the general-set answers carry.** Ping, version and device info return status
  `0x01` and nothing else; the version is presumably elsewhere.
- **How long the stream runs** through a recording or a mode change.
- **Behaviour across the camera's own power cycle.** It re-probes when a device
  reappears after a gap; it has not been watched through its own restart.
- **Power draw** on the link. Not measured.
- **The side port**, the phone adapter, and the original Osmo Pocket (`HG210`).
