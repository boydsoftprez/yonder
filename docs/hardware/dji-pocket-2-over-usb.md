# A DJI Pocket 2 on the USB port

The Pocket 2 is on the compatibility list and it is not a UVC camera. This note records
what the device told us, what the manufacturer's own software told us about how to talk to
it, and what happened when Yonder's board did. **The last section is a decoded frame.**
The sections are ordered from observed to inferred; the final one says what remains
unproven.

Requirement: R-CAM-15. Milestone: M9 as written; the bench result below is the argument
for moving it.

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
- **Every control.** Nothing but ping, version, device info and heartbeat has been sent.
- **The meaning of status `0x01`** on the information requests.
- **How long the stream runs**, and whether the camera keeps it up through a gimbal
  movement, a recording, or a mode change.
- **Behaviour across a camera power cycle** — whether the session resumes without a
  replug. It re-probes when a device appears; it has not been watched across its own
  restart.
- **Power draw** on the link. Not measured.
- **The side port** and the phone adapter. The bottom port worked and the side port was
  not needed.
- **The original Osmo Pocket** (`HG210`). Same path, same filter, never tried.
