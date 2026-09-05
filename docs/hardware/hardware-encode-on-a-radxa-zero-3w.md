# Hardware encoding on a Radxa Zero 3W

What a real board printed, before any of the Rockchip encoder work was written. The design
in [`2026-09-05-rockchip-hardware-encode-design.md`](../superpowers/specs/2026-09-05-rockchip-hardware-encode-design.md)
rests on the numbers here, and two of them contradict what this repository already claimed.

The purpose of this note is narrow: **establish whether this board can encode in hardware,
by what route, and what it costs — on hardware rather than on reasoning.** Three of the
findings below could not have been learned from a datasheet, and one of them was a wrong
answer this session produced and then had to correct.

## What was in front of us

| | |
|---|---|
| Board | Radxa ZERO 3 (`radxa,zero3`), RK3566, 4 × Cortex-A55, 1.9 GB RAM |
| OS | Armbian 26.8.1 trixie (Debian 13), kernel `6.1.115-vendor-rk35xx` |
| Camera | Global Shutter Camera `32e4:0234`, UVC, **MJPEG only** — no H.264 source |
| Also attached | Quectel EC25 LTE modem, on the second USB port |

The camera offers MJPG at 1920×1200 down to 320×240, every size up to 90 fps. It offers no
compressed H.264. So every measurement below includes a decode as well as an encode, which
is the honest shape of this camera on this board.

## The first answer was wrong, and the reason matters

`gst-inspect-1.0` is not installed by any role in this installer. Asking it whether an
encoder exists therefore returns "not found" for the tool, not for the encoder — and a
first pass over this board reported `x264enc`, `mpph264enc`, `v4l2h264enc`, `openh264enc`
and `avenc_h264` all absent. **All five were false negatives.**

This is not only a note about one session's mistake. `50-mediamtx.sh` asserts that
GStreamer resolves `rtspclientsink`, and guards that assertion with
`command -v gst-inspect-1.0`. On a board where the tool is missing the role takes its
weaker branch and reports "no gst-inspect-1.0 here to resolve rtspclientsink with". So the
strong check this installer believes it performs has never run on a real board.

## The hardware is there, and V4L2 cannot see it

Both encoders probe successfully at boot:

```
mpp_service mpp-srv: probe success
mpp_rkvenc fdf40000.rkvenc: probing finish     # rockchip,rkv-encoder-v1
mpp_vepu2  fdee0000.vepu:  probing finish      # rockchip,vpu-encoder-v2
rga2 fdeb0000.rk_rga: probe successfully, hw_version:3.2.63318
```

`/dev/mpp_service` and `/dev/rga` both exist. And yet:

```
$ ls /sys/class/video4linux/
video0  video1        # the UVC camera's own two nodes, and nothing else
```

**There are no V4L2 M2M nodes at all** — no `/dev/video10`–`/dev/video17`. `probe/encoder.ts`
walks exactly that range looking for a node that takes raw in and gives H.264 out, so on
this board it finds nothing and returns its software fallback. The probe is not broken; it
is asking a question this SoC does not answer.

Rockchip exposes these encoders through MPP, not through V4L2, and there is no mainline
V4L2 driver for the VEPU54x core in RK3566. A newer kernel does not change this.

**So the string `probe/encoder.ts` prints — "this board offers no hardware encoder" — is
false here, and will be false on every Rockchip vendor-kernel board.** The probe only ever
establishes that it found none.

## The software baseline

`gstreamer1.0-plugins-ugly` is not installed by any role either, so `x264enc` — the
element `probeEncoder`'s fallback names — was not present until it was installed by hand.
With it:

| pipeline | 300 frames | effective |
|---|---|---|
| capture → `jpegdec` → `videoconvert` → `x264enc` → `fakesink` | 10.68 s | ~28 fps |
| the two-branch shape, full-rate + 640×360 preview | 10.43 s | ~29 fps |

Real-time at 720p30, and only just — the target is 30. What it costs is in the comparison
table below: **64% of four cores**, against an idle board's 23%.

### `v4l2convert` is hard-coded, and it stops every camera

`pipeline.ts` names `v4l2convert` in the preview branch. That element is the V4L2 M2M
converter — `/dev/video12` on a Raspberry Pi — and this board has no M2M node to bind it
to. Starting a camera gives:

```
WARNING: erroneous pipeline: no element "v4l2convert"
run: {"state":"starting","restarts":4,"reason":"the pipeline exited with code 1"}
```

A pipeline description naming an unresolvable element does not *parse*, so this takes the
full-rate branch down with it, not just the preview. `GET /cameras/cam0` returned
`refusal: null` immediately before — so R-CAM-10 did not refuse it, and the operator gets
exactly the opaque failure that requirement exists to prevent.

**The obvious substitution is wrong.** `v4l2convert` converts *and scales*; `videoconvert`
does not scale:

```
ERROR: from element GstV4l2Src:v4l2src0: Internal data stream error.
streaming stopped, reason not-negotiated (-4)
```

The working software substitution is `videoconvert ! videoscale`, which is what the
two-branch row above measures.

## The hardware path

Nothing in Debian reaches these encoders, and the GStreamer Rockchip plugin's upstream
(`rockchip-linux/gstreamer-rockchip`) is a 404; the surviving forks were last touched
between 2019 and 2023 and need carried patches to build against GStreamer 1.26.

`jellyfin-ffmpeg7` is built `--enable-rkmpp --enable-rkrga`, is published for trixie
arm64, and **bundles the Rockchip libraries** (`librockchip_mpp.so`, `librga.so`,
`librockchip_vpu.so`) while depending on nothing outside stock trixie. One 16 MB package,
nothing to compile.

```
jellyfin-ffmpeg7  7.1.4-3-trixie  arm64
sha256  a8fa3ec7cf8fbaf06bb4fdb768d4dd7798277fe4c4b66884c777dc7d575877fb
```

It offers `h264_rkmpp`, `hevc_rkmpp` and `mjpeg_rkmpp` as encoders, the same three plus
AV1 and H.263 as decoders, and `scale_rkrga` / `vpp_rkrga` / `overlay_rkrga` as filters.
The MJPEG *decoder* matters here: this camera is MJPEG, so the whole chain can stay on the
SoC.

| pipeline | 300 frames | speed |
|---|---|---|
| capture → `h264_rkmpp` (software MJPEG decode) | 10.59 s | 1.01× |
| `mjpeg_rkmpp` → `drm_prime` → `h264_rkmpp`, zero copy | 10.46 s | 1.01× |

Steady 30 fps throughout, never below, on every run.

### What it costs, measured the right way

**Load average is meaningless on this board, and the first pass at this note used it.**
MPP's encoder threads wait on the hardware in a state Linux counts toward load without
consuming CPU: at 1920×1200 on two streams the load average read **7.65** while `top`
reported the CPU **86.7% idle** and nothing sat in `D` state. A figure that says a
four-core board is oversubscribed sevenfold while five sixths of it is idle is not
measuring what it appears to.

What follows is busy time from `/proc/stat` over a ten-second window, which is.

| | CPU busy, 4 cores | above idle |
|---|---|---|
| board idle — Node-RED, `yonder-core`, mediamtx | 23% | — |
| **software** `x264enc`, two branches, 720p | **64%** | **+41** |
| **hardware** `h264_rkmpp` + `scale_rkrga`, two branches, 720p | **22%** | **~0** |
| **hardware** at the camera's native 1920×1200, two branches | **26%** | **+3** |

The hardware row is below the idle baseline, which is measurement noise rather than a
board that got faster. Read it as what it is: **the encode costs nothing this method can
distinguish from zero**, and full native resolution on two simultaneous streams costs about
three points of one core in four.

Against the software path's 41 points for a smaller picture, this is not an optimisation.
It is the difference between video being most of what the board does and video being
something it barely notices.

Both codecs produce bitstreams that decode — checked, rather than trusted to an exit code:

| encoder | 150 frames | output | `ffprobe` |
|---|---|---|---|
| `h264_rkmpp` | 5.47 s | 1,221,952 B | `h264, 1280×720, 150` |
| `hevc_rkmpp` | 5.52 s | 1,213,206 B | `hevc, 1280×720, 150` |

### `scale_rkrga` needs frames the SoC already holds

The two-branch pipeline fails if the split happens in software:

```
Impossible to convert between the formats supported by the filter 'Parsed_split_0'
and the filter 'auto_scale_0'
```

RGA takes DRM-prime frames. Decoding with `-hwaccel rkmpp -hwaccel_output_format drm_prime`
puts them there, and the split then feeds RGA directly. This is why the hardware path wants
the hardware *decoder* too, on a camera nobody would otherwise think needed one.

## H.265 against H.264, on identical frames

Twenty seconds of 1920×1200 was captured once and every encode below ran against that
same clip, so the comparison is of codecs and not of two different moments in a room.
SSIM is measured against the MJPEG source, which is itself lossy — the ~0.944 ceiling is
the source's, not the encoder's — so read these as relative, never absolute.

| codec | target | actual | SSIM | CPU busy |
|---|---|---|---|---|
| `h264_rkmpp` | 6000k | 5939 | 0.9404 | 22% |
| `h264_rkmpp` | 3000k | 2961 | 0.9383 | 22% |
| `h264_rkmpp` | 2000k | 1977 | 0.9360 | 22% |
| `hevc_rkmpp` | 6000k | 5945 | 0.9437 | 26% |
| `hevc_rkmpp` | 3000k | 2982 | 0.9438 | 25% |
| `hevc_rkmpp` | 2000k | 2002 | 0.9431 | 25% |
| `hevc_rkmpp` | 1500k | 1506 | 0.9424 | 25% |
| `hevc_rkmpp` | 1000k | 1013 | 0.9411 | 25% |
| `hevc_rkmpp` | 750k | 741 | 0.9400 | 25% |
| `hevc_rkmpp` | 500k | 484 | 0.9380 | 25% |

**H.265 at 741 kbps scores what H.264 needs 5939 kbps to reach** — eight times less uplink
for the same measured quality, at three or four points more CPU. H.265's quality is flat
across the range while H.264's degrades, which says H.265 is already at the source's
ceiling by 2000k.

Rate control is accurate to about 1.5% at every point. That matters beyond this table:
R-VID-11 reports what an output costs, and on this encoder the number configured is the
number that leaves.

**The scene was a near-static desk.** Compression this good is a best case; moving ground,
vibration and changing exposure will need substantially more, and that measurement has not
been taken. **No uplink budget should be planned on 741 kbps.**

## What this board will not do: three encodes

Two simultaneous 1920×1200 encodes are fine. Three are not, and the failure is not graceful:

```
ioctl(VIDIOC_QBUF): Bad file descriptor
```

Isolated stepwise — camera alone 30 fps, plus hardware decode 30 fps, plus one encode
30 fps, three encodes dead. Before it dies outright it degrades silently: a three-encode
run delivered 237 frames of which **18 were unique**, the rest duplicated to hold the frame
rate, while ffmpeg logged only `More than 1000 frames duplicated`. A later attempt at a
third encoder took the board off the network entirely and it needed a power cycle.

**The existing pipeline design already avoids this.** `pipeline.ts` composes `tee name=main`
and feeds every output from one encode; encoding once per output is what fails. Rebuilt
that way — one encode teed to RTSP and RTP — the same test delivered 299 frames of which
299 were unique.

This is the concrete per-board limit R-HW-05 asks to be documented and enforced, and the
class of configuration R-CAM-10 should refuse rather than let an operator meet
`VIDIOC_QBUF` on an aircraft.

## `by-path` is not stable on this SoC, and R-CAM-05 depends on it

The same camera, in the same physical port, across one reboot:

| | |
|---|---|
| before | `platform-xhci-hcd.**6**.auto-usb-0:1:1.0-video-index0` |
| after | `platform-xhci-hcd.**4**.auto-usb-0:1:1.0-video-index0` |

The `.N.auto` suffix is the platform device instantiation counter, and it moved because
OTG host mode came from a device-tree overlay at boot rather than a runtime write after
it — the controller registers earlier and takes a lower number.

**R-CAM-05 requires a camera to keep its identity across reboots.** On a Raspberry Pi the
by-path name is stable and this holds; here the name embeds something that is not a
property of the port. Whether it varies boot to boot on an unchanged configuration is
**not yet established** — this session changed how host mode is set, which is sufficient
to explain this instance. It needs two clean reboots to answer, and until it is answered
R-CAM-05 cannot be claimed on Rockchip.

The daemon behaved correctly throughout: it refused with a message naming both the missing
path and the one it could see, which is R-CAM-10 and R-UI-20 working as intended.

## The USB-C port that looked disabled

Powering the board from the GPIO 5V pins makes its OTG USB-C port appear dead. It is not
disabled; it is in peripheral mode, because that port's VBUS *is* the board's power input,
so feeding 5V through the header back-feeds its VBUS sense line and the phy concludes a
charger is attached:

```
extcon0 (fe8a0000.usb2-phy):  USB=1  USB-HOST=0  USB_VBUS_EN=0  DCP=1
```

`DCP` is Dedicated Charging Port. Writing `host` to
`/sys/devices/platform/fe8a0000.usb2-phy/otg_mode` clears it immediately and the attached
device enumerates. Persisting it needs the overlay Radxa ships for exactly this —
`rk3568-dwc3-host.dtbo`, which declares `rockchip,rk3566` — installed via `user_overlays`,
because Armbian's `overlay_prefix=rk35xx` matches no file on this image and plain
`overlays=` therefore resolves nothing. **Confirmed across a cold boot:** `otg_mode = host`
with both the camera and the modem enumerating on their own.

The cost is that the port can then never act as a USB *gadget*, which R-CAM-15 needs.

## Publishing into mediamtx, which is the shape Yonder needs

The measurements above encode to `/dev/null`. The pipeline this project actually runs
publishes two RTSP streams into mediamtx, on the paths `yonder-core` already generates
(`cam0` and `cam0-preview`, `source: publisher`), and mediamtx accepts an anonymous
publisher from `127.0.0.1`. Run that way, both paths came up — *"stream is available and
online, 1 track (H264)"* — and pulled back at the resolutions and rates asked for.

Two things surfaced only once real packets moved:

- **mediamtx repacketises ffmpeg's RTSP output by default.** `RTP packets are too big
  (1460 > 1440), remuxing them into smaller ones`, logged once per path. `-pkt_size 1200`
  on each RTSP output removes it. Nothing fails without it; it is CPU spent on every packet
  of every stream, on a device whose uplink is the scarce thing.
- **This SoC cannot encode frames in parallel.** MPP says so itself: *"Only rk3588's
  h264/265/jpeg and rk3576's h264/265 encoder can use frame parallel"*. It is the ceiling
  on an RK3566 and it is not a fault; recorded so the next person measuring a higher
  resolution knows what they are up against.

## The permission trap

`/dev/mpp_service` arrives `0600 root:root`. An MPP plugin registers its decoders
unconditionally but probes MPP before registering its encoders, so with the node unreadable
the encoders are omitted silently — no error, no log line. **A plugin listing only decoders
is evidence about the device node, not about the plugin.**

This did not bite us, because `yonder-core.service` declares no `User=` and therefore runs
as root, and the supervisor spawns the encoder as its child. It is recorded because it
would bite immediately if that privilege were ever dropped, and because any check run as
another user reports the encoders missing and is believed.

This trap is documented by `pollen-robotics/microduck-gst-plugins`, which reports it having
produced four separate misleading results — including `mpi_enc_test` writing an empty file
and exiting 0.

## What this note settles

- The board has two hardware encoders and an RGA block, all with drivers loaded.
- V4L2 cannot reach them, and no kernel change fixes that.
- One published, self-contained `.deb` reaches all of them, with no compilation.
- Hardware encode holds 30 fps at a CPU cost this method cannot distinguish from zero, in
  both H.264 and H.265, producing bitstreams that decode — against 41 points of four cores
  for the software path on a smaller picture.
- Load average is the wrong instrument on this board, and reading it costs you a wrong
  answer by a factor of about twenty.
- H.265 reaches H.264's quality at roughly an eighth of the bitrate, for three or four
  points more CPU — on a static scene, which is a best case and not a budget.
- Two simultaneous 1920×1200 encodes are the ceiling. Three fail, and degrade silently
  before they do.

## Not settled, and stated so

- **End-to-end latency.** Roughly two seconds was seen in QGroundControl over UDP H.265.
  QGC's own configuration was read directly and is correct — UDP h.265 source, port 5600,
  Low Latency Mode on — so `rtspsrc`'s 2000 ms default, which matches the figure
  suspiciously well, is **not** the cause here: that path is not in use. The pipeline's own
  contribution was never measured; two attempts at a burned-in-clock rig failed, and the
  third was abandoned because it would have put a second video copy on a bandwidth-limited
  link. The evidence points at the receiver, but **this is an inference, not a result.**
  It matters: the design's case for composing with ffmpeg everywhere is weaker if ffmpeg
  costs latency that GStreamer's `latency=0` sinks do not.
- **Whether `by-path` varies boot to boot** on an unchanged configuration, per above.
- **Flight-representative bitrates.** Every figure here is a static indoor scene.
- Three claims already in this repository are wrong: that the encoder is
  "resolved at install time and recorded in config" (`architecture.md`, contradicting
  R-CAM-06's own withdrawal), that Radxa is "image-only in practice" because it needs the
  vendor BSP kernel and the MPP libraries (`architecture.md`, `roadmap.md` — Armbian ships
  the kernel, and the libraries arrive in that one package), and that this board offers no
  hardware encoder (`probe/encoder.ts`, printed to the operator).
