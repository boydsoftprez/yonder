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
