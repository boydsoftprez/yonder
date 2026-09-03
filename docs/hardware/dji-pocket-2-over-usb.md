# A DJI Pocket 2 on the USB port

The Pocket 2 is on the compatibility list and it is not a UVC camera. This note records
what the device told us, what the manufacturer's own software told us about how to talk to
it, and the procedure that will settle whether Yonder can. **Nothing below has produced a
picture yet.** The sections are ordered from observed to inferred, and the last one says
what remains unproven.

Requirement: R-CAM-15. Milestone: M9, unless the bench moves it.

## What the board saw

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

Enumeration was untidy: four failed descriptor reads at full speed and two port power
cycles before it came up at high speed on the eleventh attempt. The board was browning out
at the time ([K-34](../known-issues.md#k-34)), so that is not evidence about the camera.

The important reading is the first three rows. **This is not a camera presenting itself
to a host; it is a stub.** One minimal interface, 100 mA, a SCSI implementation that claims
nothing. It is what a device offers when it sees a host and has nothing to say to one.

## The camera is the host

The Pocket 2 has two connectors: the bottom USB-C, and a side port that takes the
manufacturer's phone adapter. The phone is what the camera is designed to talk to, and on
that link **the camera is the USB host and the phone is the device.** That is Android Open
Accessory (AOA), a published protocol ([source.android.com](https://source.android.com/docs/core/interaction/accessories/aoa)):

1. The camera enumerates the attached device and sends vendor control request **51**
   (`GET_PROTOCOL`); a phone answers with the AOA version it supports.
2. The camera sends request **52** (`SEND_STRING`) six times — manufacturer, model,
   description, version, URI, serial — naming the accessory it is.
3. The camera sends request **53** (`START`). The phone drops off the bus and returns as
   `18d1:2d00`, one interface with a bulk IN and a bulk OUT endpoint.
4. The two now talk over those bulk pipes.

Three facts from the manufacturer's Android application (DJI Mimo, the store release
dated 2026-08-20, read statically) confirm this is the path the Pocket 2 uses:

- Its manifest declares the `android.hardware.usb.accessory` feature and listens for
  `USB_ACCESSORY_ATTACHED`.
- Its accessory filter accepts exactly two accessories: manufacturer `DJI`, model
  **`HG210`** or **`HG211`**. No other product in the application uses accessory mode.
  The native library carries an `HG211CameraAbstraction` with lens-accessory and
  microphone-accessory capability calls, which are Pocket 2 features; `HG210` is the
  original Osmo Pocket.
- Its native SDK has a `dji::core::AoaServicePort` — one of several link types — feeding
  the same session manager whose methods include `OnRecvVideoData`. **Video arrives on
  the accessory link**, in the same session as commands.

So the stub above is the camera answering the wrong question. Yonder has been asking "what
device are you?" and the camera only knows how to ask that itself.

### What that means for the board

**Yonder's board must be a USB *device* on this link.** On a Raspberry Pi 4 the only
peripheral-capable port is the USB-C — which is also the power input. So this camera
imposes an installation constraint no other source does: **the Pi 4 must be powered from
the GPIO header or a PoE HAT**, leaving USB-C for the camera. A Pi Zero 2 W or 3A+ has a
separate OTG port and needs no such arrangement. This belongs in the hardware
documentation the day the camera is supported, because a Pi 4 wired the ordinary way
cannot do it at all.

The kernel side is already present on Raspberry Pi OS: `dwc2` is built in, and
`libcomposite` with FunctionFS lets a userspace program answer control requests and own
bulk endpoints. No out-of-tree module is needed for the accessory role.

## The protocol on the pipe

DJI's device protocol is DUML, documented publicly by the
[dji-firmware-tools](https://github.com/o-gs/dji-firmware-tools) project. The v1 frame:

| Offset | Field |
|---|---|
| 0 | `0x55` |
| 1–2 | length (10 bits, low) and version (6 bits, high), little-endian |
| 3 | CRC8 of bytes 0–2 — reflected polynomial `0x8C`, seed `0x77` |
| 4 | sender: device type in bits 0–4, index in bits 5–7 |
| 5 | receiver, same packing |
| 6–7 | sequence number |
| 8 | bit 7 response, bits 5–6 ack requested, bits 0–2 encryption |
| 9 | command set |
| 10 | command id |
| 11… | payload — a response carries the status byte first |
| last 2 | CRC16 of everything before it — reflected `0x1021`, seed `0x3692` |

Device types: 1 camera, 2 app, 4 gimbal. Command sets: 0 general, 2 camera, 4 gimbal.

The messages Yonder will need, by set and id, from the names the SDK gives them:

| | Set / id | Message |
|---|---|---|
| Handshake | 0 / `0x00` | ping |
| | 0 / `0x01` | get version |
| | 0 / `0xff` | get device info |
| | 0 / `0x0e` | heartbeat |
| **Picture** | **2 / `0x09`** | **live-view subscribe** — payload not yet known |
| | 2 / `0xeb` | camera status subscribe |
| | 2 / `0x4c` | set video-out parameters |
| Controls | 2 / `0x02` | record |
| | 2 / `0x1e` | exposure mode |
| | 2 / `0x2c` | white balance |
| | 2 / `0xb8` | zoom |
| Gimbal | 4 / `0x01` | motion control |
| | 4 / `0x0a` | set angle |
| | 4 / `0x44` | work mode |
| | 4 / `0x4c` | work mode and return to centre |

The controls and gimbal rows are R-CAM-11 — aim, recentre, zoom, exposure, white balance
— arriving on the same link as the picture.

## What Yonder would build

A small daemon, `pocket2d`, that presents the phone identity, completes the AOA handshake,
runs the DUML session, and writes the H.264 it receives to a local UDP port. From there the
M4 pipeline is unchanged: mediamtx serves it, the tee sends it to the ground station. To
the rest of Yonder it is one more camera source, with a source type of its own and a
control set that reaches the gimbal.

It is its own package, so a firmware change on the camera's side breaks one package and
not the video path.

## The bench procedure

The tools are in [`scripts/pocket2/`](../../scripts/pocket2/). Everything runs on the dev
board; the operator plugs one cable.

1. **Power the Pi from the GPIO header** — 5 V on pin 2 or 4, ground on pin 6, from a
   supply that holds 5.1 V at 3 A. The header has no protection; check polarity twice.
2. Put the USB-C port in device mode and reboot:
   `sudo scripts/pocket2/enable-gadget-mode.sh peripheral && sudo reboot`
3. Start the emulator: `sudo scripts/pocket2/aoa-gadget.sh run`. It presents the Pi as an
   Android phone and waits.
4. Connect the camera's **bottom** port to the Pi's USB-C with a USB-C data cable, camera
   powered on.
5. Read `/var/tmp/aoa/phone.log`. The decisive line is a `SETUP` with `bRequest=51`. If
   it arrives, the strings follow, then `START`, and the script re-presents the Pi as
   `18d1:2d00` and hands over to `aoa_session.py`, which logs every frame decoded and
   opens with ping, version, device info and a live-view subscribe.
6. `sudo scripts/pocket2/enable-gadget-mode.sh host` and reboot to restore the port.

`SESSION_ARGS='--listen-only'` in front of step 3 makes the accessory stage say nothing
and only record, which is the right first run.

The self-check for the codec is `python3 scripts/pocket2/duml.py`; its CRC tables were
compared byte-for-byte against the reference implementation.

## What is not yet known

- **Whether the camera issues AOA requests on the bottom port at all**, or only on the
  side port. The bottom port is tried first because it needs one plain cable; the side
  port needs the phone adapter plus a C-female/A-male and A-female/C-male pair.
- **The live-view subscribe payload.** The first run sends it empty and reads the status
  byte in the response. A non-zero status is information: the command was understood.
- **How video is framed on the pipe** — as DUML frames on a video command id, or raw
  after the subscribe. The session tool logs bytes that are not DUML separately so
  neither case is lost.
- **Power draw.** A phone is charged by this port; the Pi in device mode will draw from
  the camera's battery unless told otherwise. Not measured.
- **The original Osmo Pocket** (`HG210`). Same path, same filter, never tried.
- Whether the camera **restarts a session on its own after a power cycle**, which is what
  decides if this is a camera that comes up with the aircraft or one that needs a hand.
