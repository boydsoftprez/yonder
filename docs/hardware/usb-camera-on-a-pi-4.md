# A USB camera on a Raspberry Pi 4

What a real camera on a real board printed, before any of M4 was written. M4's plan rests
on the numbers here, and three of them contradict what the documentation led us to expect.

The purpose of this note is narrow: **establish what the video pipeline must be, and what
it costs, on hardware rather than on reasoning.** Nothing below could have been learned
from a datasheet, and two of the findings would each have cost a day if met during
implementation instead.

## What was in front of us

<!-- yonder:hardware-observed -->

| Field | Observed |
|---|---|
| Board | Raspberry Pi 4 Model B Rev 1.5, aarch64 |
| OS | Raspberry Pi OS, Debian 13 (trixie) |
| Kernel | `6.18.34+rpt-rpi-v8` |
| GStreamer | 1.26.2 (`-plugins-base/good/bad`), 1.26.3 (`-ugly`) |
| Camera | ELP `USBGS1200P01-H120`, USB id `32e4:0234`, "Global Shutter Camera" |
| Camera link | `uvcvideo`, **480M — USB 2.0 High Speed**, through a VIA Labs hub |
| Camera nodes | `/dev/video0`, `/dev/video1` |
| Also attached | Quectel EC25 LTE modem (`2c7c:0125`), `cdc_mbim` |
| Date | 2026-09-02 |

`gstreamer1.0-tools`, `-plugins-base`, `-plugins-good`, `-plugins-bad`, `-plugins-ugly`,
`gstreamer1.0-libav` and `v4l-utils` were all absent from the image and had to be
installed. **M4's installer role owns all of them.** `-plugins-ugly` carries `x264enc`,
which R-HW-02 needs for the Pi 5, and which is GPL-2.0-or-later — compatible with Yonder's
GPL-3.0-or-later, and in any case invoked as a separate process rather than linked.

## The camera offers compressed frames or nothing usable

```
/dev/video0:  [0] 'MJPG' (Motion-JPEG, compressed)
              [1] 'YUYV' (YUYV 4:2:2)
```

Two formats, and the second is a trap. What each one is actually offered at:

| Format | 1920×1200 | 1920×1080 | 1280×720 | 640×480 | 320×240 |
|---|---|---|---|---|---|
| **MJPG** | 90 fps | 90 fps | 90 fps | 90 fps | 90 fps |
| **YUYV** | **5 fps** | **5 fps** | 10 fps | 30 fps | 90 fps |

The camera is negotiating USB 2.0. An uncompressed 1920×1080 YUYV frame is 4,147,200
bytes; thirty a second is 124 MB/s against a bus that carries perhaps 40. The camera has
done that arithmetic itself and declines to offer raw above VGA at any useful rate.

**So JPEG decoding is not a design choice.** Any USB camera at a resolution worth flying
with will hand us compressed frames, and something has to decompress them. This is the
fact that M4's roadmap entry did not anticipate: it assumed "many USB cameras emit H.264
already, so the first stream can be captured and repackaged without touching the per-board
encoder matrix at all." This camera emits no H.264, and neither does the other camera on
the compatibility list. R-CAM-02 already required MJPEG sources; what changes is that
MJPEG is the *common* case rather than a variant, and M4 therefore cannot avoid encoding.

## Which hardware blocks exist, and which of them work

The Pi 4 registers several V4L2 memory-to-memory devices. What each accepts and emits, and
which GStreamer element binds to it:

| Device | Driver name | In | Out | Element | Verdict |
|---|---|---|---|---|---|
| `/dev/video10` | `bcm2835-codec-decode` | H264, **MJPG** | YU12, NV12, … | `v4l2jpegdec` | **Advertises MJPEG. Does not work — see Defect 1** |
| `/dev/video11` | `bcm2835-codec-encode` | YU12, NV12, YUYV, … | **H264**, MJPG | `v4l2h264enc` | Works. Essentially free |
| `/dev/video12` | `bcm2835-codec-isp` | Bayer, YUV, RGB | YUV, RGB | `v4l2convert` | Works, and **should not be used — see Defect 2** |
| `/dev/video18` | `bcm2835-codec-image_fx` | YU12, NC12 | YU12, NC12 | — | Not needed |
| `/dev/video31` | `bcm2835-codec-encode_image` | RGB, YUV | JPEG | — | A JPEG *encoder*, not a decoder |
| `/dev/video19` | `rpi-hevc-dec` | — | — | — | HEVC decode. Not an encoder; irrelevant to R-CAM-08 |

The last row is worth stating explicitly because the name invites the wrong conclusion:
the Pi 4 has HEVC **decode** hardware and no HEVC encoder. R-CAM-08 remains a Rockchip
capability.

### Defect 1 — the hardware JPEG decoder advertises MJPEG and fails to start

`/dev/video10` lists `MJPG` on its output side. Asking it to decode stalls the pipeline
completely — not slowly, but forever; every attempt ran until killed at its timeout. The
kernel says why:

```
bcm2835-codec bcm2835-codec: bcm2835_codec_start_streaming: Failed enabling i/p port, ret -3
Modules linked in: … bcm2835_codec(C) …
```

followed by a warning trace. The timestamp (`24034` against an uptime of `24492`) places it
inside the test run, so this is our attempt provoking it rather than a pre-existing message.

Characterised, so nobody re-investigates:

- **Not a resolution limit.** 640×480 fails identically to 1920×1080.
- **Not a missing parser.** `jpegparse ! v4l2jpegdec` fails faster, with `Internal data
  stream error`, rather than better.
- **Not a GStreamer fault.** The element negotiates and issues the ioctls; the driver
  cannot enable the input port.

The consequence is that the software decoder is the only decoder, and roughly 50% of one
core is the unavoidable floor for 1080p30 on this board. That is the whole cost of the
pipeline — see the measurements below.

### Defect 2 — the ISP converter is pure overhead, and looks like the opposite

The obvious pipeline puts the hardware colour converter between the decoder and the
encoder. It measures badly, and the reason is not the conversion:

| Pipeline | CPU, one core |
|---|---|
| `jpegdec` alone | 48% |
| `jpegdec ! v4l2convert` | 45% — the hardware convert is genuinely free |
| `jpegdec ! v4l2convert ! v4l2h264enc` | **68%** |
| `jpegdec ! v4l2h264enc` — no converter | **54%** |
| `jpegdec ! v4l2convert ! v4l2h264enc`, both `dmabuf` | 48% |

The 20-point penalty is a **buffer copy into the encoder**, not conversion work. It
disappears two ways: by importing DMA buffers, or — simpler and with one less element — by
deleting the converter entirely. `jpegdec` emits `I420`, and `/dev/video11` accepts `YU12`,
which is the same thing. **The converter was translating a format into itself.**

This one is worth flagging loudly because the first measurement pointed the wrong way. A
run comparing hardware `v4l2convert` against software `videoconvert` shows the hardware one
winning by a wide margin (10.4 s versus 14.7 s for the same 300 frames) and invites the
conclusion that the ISP is load-bearing. It is not. Both were paying the copy; the software
one was additionally paying for a conversion neither needed.

`architecture.md` currently sketches the pipeline as "capture → convert → encode". **There
is no convert step on this path.**

### Defect 3 — H.264 level 4 cannot carry the camera's native frame

The sensor's full frame is 1920×1200. Encoding it fails immediately with
`level=(string)4` — the value that every Raspberry Pi example pins, because 1080p works
with it.

1920×1200 is 120 × 75 = **9,000 macroblocks**. H.264 level 4 permits 8,192. Level 5 permits
22,080, and at level 5 the same pipeline runs at full rate.

So the level must be **derived from the resolution**, not pinned. Pinned at 4, the camera's
own best mode is silently unavailable; and the capsfilter cannot simply be dropped, because
`v4l2h264enc` errors out without an explicit level downstream.

## What it costs

Direct path — `v4l2src ! image/jpeg ! jpegdec ! v4l2h264enc ! h264parse` — at a 2 Mb/s
target. Each figure is the mean of three runs of 300 frames; run-to-run spread was under
two points. The Pi 4 has four cores, so the last column is the share of the whole board.

| Resolution | Keeps 30 fps | One core | The board |
|---|---|---|---|
| 1920×1200 (full sensor, level 5) | yes | 65% | 16% |
| 1920×1080 | yes | 55% | 14% |
| 1280×720 | yes | 27% | 7% |
| 640×480 | yes | 11% | 3% |

Verified as real work, not dropped frames: `fpsdisplaysink` reported **rendered 294,
dropped 0** across 300 buffers, and the encoded file was 2,498,545 bytes over ten seconds —
2.00 Mb/s against a 2 Mb/s target.

Where the 1080p cost goes:

| Stage | CPU, one core |
|---|---|
| Capture only | 1% |
| + software JPEG decode | ~50% |
| + hardware H.264 encode | +4% |

**The encoder is free; the JPEG decode is the entire cost**, and Defect 1 means it cannot be
moved to hardware.

`avdec_mjpeg` from `gstreamer1.0-libav` was tried as a faster decoder, with and without
`jpegparse`, and fails to negotiate on this board. `max-threads=4` on it saturates a core
without producing output. Adding `queue` elements around the working pipeline makes it
worse (61% against 54%) — more thread handoffs, more copies. **`jpegdec` stands.**

### Splitting the stream is free

R-VID-05 requires every configured output to run at once, and `architecture.md` argues a
`tee` costs almost nothing. On the device, that is correct:

| | CPU, one core |
|---|---|
| One output | 68% |
| `tee` to RTP/UDP **and** a second branch | 70% |

(Both measured before Defect 2 was understood, so both carry the buffer copy; the two
points between them are the number that matters.)

What is *not* free is the uplink. The split is one encode copied twice inside the board,
but each consumer that leaves over cellular costs its own bitrate: a browser watching, a
ground station pulling RTSP and a configured RTP push are three copies of the same picture
up the same link. At 2 Mb/s that is 6 Mb/s of uplink for one camera, against a field LTE
uplink that is often 1–5 Mb/s. **The `tee` removes the encoding trade-off. It does not
remove the bandwidth trade-off, and `architecture.md` currently implies it does.**

### The Pi 5 path, measured on slower hardware

R-HW-02 wants software H.264 on boards without an encoder. No Pi 5 was available, but
x264 was measured **on the Pi 4**, which is the harder case — a Pi 5 is faster per core:

| Resolution | Keeps 30 fps | One core | The board |
|---|---|---|---|
| 1920×1080 | yes | 169% | 42% |
| 1280×720 | yes | 86% | 21% |

`speed-preset=ultrafast tune=zerolatency`. This does not verify R-HW-02 — only a Pi 5 can
do that — but it establishes that the software path is viable at 1080p30 on hardware slower
than the one it targets.

## Thermals

62°C at the start of the session, 70.1°C at the end, `get_throttled=0x0` throughout. Never
throttled. This was bench testing in open air over roughly an hour of intermittent load;
**sustained encode in a closed airframe is untested** and is a different question.

## What this means for the pipeline

```
v4l2src device=<by-path>
  ! image/jpeg,width=W,height=H,framerate=F/1
  ! jpegdec                          # software: the hardware decoder is broken (Defect 1)
  ! v4l2h264enc extra-controls=…     # hardware, and free
  ! video/x-h264,level=(string)L     # L derived from W×H, not pinned (Defect 3)
  ! h264parse
  ! tee name=t
      t. ! queue ! rtph264pay ! udpsink host=… port=…     # ground station, R-VID-01
      t. ! queue ! rtspclientsink location=…              # mediamtx, R-VID-03/04
```

No `v4l2convert`. No `videoconvert`. The decoder's output format is already the encoder's
input format.

Three things this settles for M4's design:

- **The encoder cannot be deferred.** R-CAM-06 and R-CAM-07 belong in M4, because there is
  no camera in hand that lets M4 skip them.
- **The encoder must be chosen by probing, not by a board table.** Every finding above is a
  property of *this kernel on this board with this camera*, discovered by asking rather
  than by looking up. A table of board names would have said the Pi 4 has a hardware JPEG
  decoder, and it does, and it does not work.
- **1080p30 is comfortable.** At 14% of the board, M5's telemetry has room, and there is no
  need to design around 720p.

## Reproducing this

`v4l-utils` and the GStreamer packages above must be installed. Then:

```bash
# what the camera offers
v4l2-ctl -d /dev/video0 --list-formats-ext

# what each hardware block accepts and emits
for d in /dev/video1{0,1,2,8} /dev/video31; do
  v4l2-ctl -d $d --info | grep 'Card type'
  v4l2-ctl -d $d --list-formats-out; v4l2-ctl -d $d --list-formats
done

# the working pipeline, timed over 300 frames — 10.0 s means it is keeping up
time gst-launch-1.0 -q v4l2src device=/dev/video0 num-buffers=300 \
  ! image/jpeg,width=1920,height=1080,framerate=30/1 \
  ! jpegdec \
  ! v4l2h264enc extra-controls=controls,video_bitrate=2000000 \
  ! 'video/x-h264,level=(string)4' ! h264parse ! fakesink

# Defect 1, reproduced — stalls until killed, and writes to the kernel log
timeout 30 gst-launch-1.0 -q v4l2src device=/dev/video0 num-buffers=150 \
  ! image/jpeg,width=1920,height=1080,framerate=30/1 ! v4l2jpegdec ! fakesink
dmesg | grep 'Failed enabling i/p port'
```

## What has not been tested

- **Any board other than this Pi 4.** Pi Zero 2 W, Pi 3, CM3 and CM4 share R-HW-01's claim
  of a hardware encoder and none has run this. The Pi 5 and CM5 software path has been
  measured only by proxy, above.
- **Any camera other than this ELP.** The DJI Osmo is on the compatibility list and has
  never been plugged in. It will enumerate differently, which is the argument for probing.
- **Camera identity across reboots and plug order (R-CAM-05).** `/dev/v4l/by-id/` exists
  and resolves, but this camera reports the serial `01.00.00` — a generic string. Two
  identical modules would collide, so identity needs the USB topology path
  (`usb-0000:01:00.0-1.3`) as the tiebreak. Not yet tried with two cameras.
- **mediamtx.** Not installed on this board; nothing has been published to it, and no
  browser has played anything. Every measurement above ends at a `fakesink` or a file.
- **Anything over the modem.** The EC25 is attached and unconfigured. No video has crossed
  a cellular link.
- **Sustained thermal load in an enclosure.**
