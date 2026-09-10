# SeekerHD MIPI capture on Radxa Zero 3W

R-CAM-01, R-CAM-05, R-CAM-14, R-HW-03. Board work on 2026-09-09.

## Hardware and capture path

The camera is the [Divimath SeekerHD](https://www.divimath.com/products/divimath-seekerhd-camera),
using Sony IMX462. The board runs Armbian 26.8.1 trixie with
`6.1.115-vendor-rk35xx`. Its actual device-tree compatible includes
`radxa,zero3-aic8800ds2`.

Enabling I2C2 M1 and the camera-enable GPIO established successful register
reads at address 0x1a. A sensor-specific module and overlay then connected
the camera through `rockchip-csi2-dphy0` to `rkisp_mainpath`. The capture name is
`platform-rkisp-vir0-video-index0`, resolved through udev rather than depending
on a particular `/dev/videoN` number.

The sensor supplies full-field 1920×1080 Bayer data. The hardware ISP scales
that to NV12 1280×720, which goes directly into Yonder's MPP encoders. Main
output is H.264 720p30; the independent browser preview is H.264 640×360 at
15 fps. The prepared mode is the only CSI mode exposed by this initial
integration; no other frame rates or ISP sizes are claimed as validated.

## Image processing and startup defects

The initial capture was dark and yellow because there was no active ISP
control service. A temporary manual exposure/gain adjustment made the picture
visible while the RKAIQ service was built from pinned source.

The [bring-up source directory](../../scripts/spikes/seekerhd/README.md) records
all pins, source revisions, patches, profile conversion and service units.
Three issues required actual hardware diagnosis:

1. The built-in vendor ISP removes missing sensor links before a loadable
   sensor module can bind. Camera preparation rebuilds the camera-only
   ISP/DPHY bindings when the graph has no sensor.
2. Realtime thread creation is denied by this Armbian kernel's scheduling
   configuration. RKAIQ silently continued without its statistics thread,
   so exposure and white balance never updated. Its patched thread creation
   falls back to normal priority after EPERM. The statistics thread then
   appeared and sensor exposure/gain changed automatically.
3. RKAIQ mixed minimum blanking with the current frame interval when deriving
   sensor clock. At the prepared 30 fps it inferred half the actual clock,
   then drove the sensor at 60 fps. Reading current blanking fixes that
   mismatch: VBLANK remained 1170 and captured frame spacing returned to 33 ms.

The IQ conversion uses the manufacturer's SeekerHD gamma curve and high-gain
low-light intent. It corrects sensor gain conversion, black level, fixed-rate
timing and invalid reference calibration entries. Uncalibrated lens shading
is bypassed. Captured images showed a substantially brighter image and neutral
white balance after automatic control began. This is a visual bench check,
not factory colour calibration or a measured low-light sensitivity claim.

Yonder waits for the ISP service's readiness notification and final mode
preparation. Camera failure does not prevent the console from starting.

## Integrated application upgrade

The Radxa application was upgraded from the earlier Rockchip build to the
combined Yonder cockpit/camera/network/branding/Adaptive runtime at `0b6afd3`,
merged with CSI support in `7f8a668`. The later `02f24b6` Adaptive acceptance
record changes documentation only and is also included in this branch.

All workspace packages built. All 4,948 workspace tests passed, including
3,666 core tests and 927 dashboard tests. Installer roles `55-pipeline-host`,
`20-yonder-core` and `30-console` completed on the Radxa. MediaMTX is 1.20.1;
its observer API remains on 127.0.0.1:9997, using credentials generated on
this board. The Pi's configuration and secrets were not copied.

The camera configuration was changed through Apply/Confirm, keeping its
existing `cam0` outputs. Name is `SeekerHD`, source is `csi`, main target is
2000 kb/s and preview target is 400 kb/s. Autostart is enabled through the
same configuration transaction.

## Acceptance observations

After the statistics-thread and timing fixes, concurrent five-second local
RTSP decoder samples produced:

| Stream | Decoded frames | Rate from decoded-frame timestamps | Dimensions |
|---|---:|---:|---|
| Main | 147 | 30.000 fps | 1280×720 |
| Preview | 65 | 15.000 fps | 640×360 |

Both exited zero with empty decoder stderr. Frame counts include the receiver
joining at a keyframe; timestamp spacing is the rate measurement. ISP
interrupt error count was zero.

The final reboot brought the camera preparation, ISP service, core and console
back without a manual Start. The supervisor reported running, zero restarts,
and no refusal. The statistics thread used the normal-priority fallback, and
the ISP retained 33 ms frame spacing with zero interrupt errors.

A 2000→2500 kb/s manual Apply reported a continuous retune with no interruption.
Explicit Revert restored 2000 kb/s while the supervisor's running `since`
timestamp remained unchanged. Subsequent concurrent decoder samples delivered
145 main frames at 30.001 fps and 65 preview frames at 15.000 fps, both with
empty stderr and zero exit status. This verifies the retune lifecycle, not
exact transmitted bitrate or Adaptive backoff under congestion.

The upgraded login page was reached in the browser. A final browser video
check requires signing in again after the application upgrade and reboot;
the decoder evidence above is independent of that session.

The sensor module currently targets the installed vendor kernel; a kernel
upgrade needs a matching module rebuild. Camera manual-control routing,
other resolutions/rates, laboratory colour calibration, MPP-specific Adaptive
backoff under a constrained link, and latency measurement are not certified
by this bring-up.

## H.265 main and browser preview

The operator requested H.265 controls and questioned the fixed H.264 browser
rule. The actual Codex browser (Chromium 152 on this Mac) advertised H.265 in
`RTCRtpReceiver.getCapabilities('video')`. A live WHEP receiver then decoded
the camera as `video/H265`, establishing playback separately from capability
advertisement. This is new evidence for the R-VID-20 revision.

Commit `fddc816` adds independent main and preview selectors. The browser's
preview choice is gated by both board and browser capabilities, retains H.264
for compatibility, and stages changes through Apply with a restart warning.
Omitted `preview.codec` remains H.264. Changing the main codec alone preserves
the preview codec. Full workspace build and 4,955 tests passed.

Both outputs were applied as H.265 and confirmed. Initial browser evidence
was 640×360 at 15 fps, with 384 decoded frames and zero reported packet loss.
The preview settings were subsequently changed to 1280×720 at 30 fps; these
settings were retained. At that size the browser reported 3,773 decoded HEVC
frames, 30 fps and zero packet loss. The diagnostic receiver used a temporary
loopback SSH forward to the existing private MediaMTX WHEP listener; no media
authentication or listener exposure was changed.

Concurrent RTSP samples decoded 219 main and 239 preview frames, both
1280×720 at 30.000 fps. FFmpeg reported missing HEVC references while joining
midstream, then decoded frames; this is not a claim of a diagnostic-free RTSP
join. The browser playback samples above did not show loss or stalled decoding.

Selecting H.265 changes compression, not the bitrate budget. The main target
remains 2000 kb/s, while the preview retains its configured Adaptive envelope.
Shared preview codec selection affects every viewer of that camera; a browser
without HEVC WebRTC support can use the H.264 compatibility selection.

## Native 1080p30 and measured hardware use

The initial 720p-only discovery restriction was removed. CSI detection now
queries the native sensor size and reduced full-field candidates through
non-mutating `VIDIOC_TRY_FMT`, retaining only exact NV12 sizes returned by the
driver. The SeekerHD offers 1920×1080, 1280×720 and 640×360 at its current 30 fps.
Tests also verify that clamped sizes are omitted and reduced sizes remain
available after switching the current output to native 1080p.

The main stream was applied at H.265 1920×1080/30 fps. The existing preview
setting, H.265 1280×720/30 fps, was retained. On the Mac, concurrent ten-second
RTSP decoder samples produced 299 main and 298 preview frames, both at 30.000
fps from decoded-frame timestamps. Initial HEVC join diagnostics remain as
described above. An earlier simultaneous software-decoder test on the Radxa
itself measured only 26.86 fps main; receiver decoding adds substantial load,
so acceptance uses the Mac as the receiver rather than burdening the sender.

Ten-second steady measurements, without on-board receiver decoding:

| Configuration | Total CPU busy, all 4 cores | I/O wait | RGA | RKVENC |
|---|---:|---:|---:|---:|
| 720p30 main + 720p30 preview | 36.7% | 0.0% | 11% observed separately | Not sampled |
| 1080p30 main + 720p30 preview | 43.5% | 0.0% | 24% | 49.61% load / 48.53% utilization |

At 1080p, the SoC was 74.44°C with the CPU at 1.8 GHz. Kernel ISP data showed
1920×1080 Bayer input, NM12 1920×1080 output, 33 ms frame spacing and no ISP
interrupt errors. The two kernel RKVENC sessions identified H.265 at 1920×1080
and 1280×720. RGA's load counter confirmed activity. The running graph uses
DMA-buffer capture, the hardware ISP, RGA within the preview encoder, and MPP
for both HEVC encodes. It contains no software decoder, software scaler or
software colour-conversion element. CPU is still used by GStreamer/control
callbacks, packetization, network services, the console and ISP control logic.
The MPP diagnostic sampling interval was restored to zero after measurement.

The shared exact-content configuration cache from `dd05ff1` was incorporated
in `c3dddea`. It still reads current file bytes and returns independent copies.
Twelve sequential Radxa `/config` requests improved from 64.85 ms median /
290.41 ms maximum to 6.53 ms median / 26.64 ms maximum. The combined core passed
3,673 tests after that integration; the subsequent CSI probe/pipeline subset
passed 100 tests. These improvements do not imply zero CPU cost for video or
that Linux load average is a CPU-utilization percentage.
