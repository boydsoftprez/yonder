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

| pipeline | 300 frames | effective | load avg |
|---|---|---|---|
| capture → `jpegdec` → `videoconvert` → `x264enc` → `fakesink` | 10.68 s | ~28 fps | — |
| the two-branch shape, full-rate + 640×360 preview | 10.43 s | ~29 fps | **~2.2** |

Real-time at 720p30, on about half of a four-core board. Viable, and thin: Node-RED,
mediamtx and MAVLink share those cores.

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

| pipeline | 300 frames | speed | load avg |
|---|---|---|---|
| capture → `h264_rkmpp` (software MJPEG decode) | 10.59 s | 1.01× | 0.95 |
| `mjpeg_rkmpp` → `drm_prime` → `h264_rkmpp`, zero copy | 10.46 s | 1.01× | 1.00 |
| the two-branch shape, `scale_rkrga` for the preview | — | — | **~1.2** |

Steady 30 fps throughout, never below, on every run. Against the software two-branch
figure of ~2.2, hardware costs roughly **half the CPU** for the same work, and holds the
frame rate the software path was already missing.

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
- Hardware encode holds 30 fps at roughly half the CPU of the software path, in both
  H.264 and H.265, producing bitstreams that decode.
- Three claims already in this repository are wrong: that the encoder is
  "resolved at install time and recorded in config" (`architecture.md`, contradicting
  R-CAM-06's own withdrawal), that Radxa is "image-only in practice" because it needs the
  vendor BSP kernel and the MPP libraries (`architecture.md`, `roadmap.md` — Armbian ships
  the kernel, and the libraries arrive in that one package), and that this board offers no
  hardware encoder (`probe/encoder.ts`, printed to the operator).
