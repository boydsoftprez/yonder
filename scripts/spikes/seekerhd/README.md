# SeekerHD on Radxa Zero 3 — bring-up sources

R-CAM-01, R-CAM-05, R-CAM-14, R-HW-03. These are bench sources for the
Divimath SeekerHD (Sony IMX462), not a general camera installer.

`imx462_yonder.c` retains the GPL-2.0 notice from the IMX290 driver. It is
adapted from [kinchims/Radxa-Zero3-IMX462](https://github.com/kinchims/Radxa-Zero3-IMX462)
at `0b896b19cb43132ea5cd862a5a7f7870c292f07e`. Changes:

- Use the 6.1 kernel's `probe_new` callback and a distinct `imx462` driver name
  with only `sony,imx462lqr` matching, leaving the installed IMX290 driver alone.
- Correct the invalid I2C-client-to-subdevice conversion in frame interval queries.
- Report frame interval from active blanking controls and pixel rate.
- Use IMX462 register 0x3011 = 0x02 and analogue gain limit 98, as in
  [Raspberry Pi's IMX462 support](https://github.com/raspberrypi/linux/blob/rpi-6.12.y/drivers/media/i2c/imx290.c).
- Remove repeated module-info logging.

Build on the target with matching kernel headers:

```sh
make -C /lib/modules/$(uname -r)/build M="$PWD" modules
dtc -@ -I dts -O dtb -o seekerhd-imx462.dtbo seekerhd-imx462.dts
```

The overlay describes the Zero 3's I2C2 M1 pins, GPIO3_C6 camera enable,
37.125 MHz camera oscillator and two CSI lanes feeding ISP0. Validate with
`fdtoverlay` against the installed base tree and other active overlays before use.
Never substitute a Raspberry Pi overlay for this board's device tree.

The vendor ISP removes unready sensor links during a kernel late-init call.
Loading this module after boot therefore requires rebuilding the ISP/DPHY
bindings before its sensor appears in the media graph. Initializing the
sensor alone is not proof of a complete capture path.

## Observed on 2026-09-09

Armbian 26.8.1 trixie, `6.1.115-vendor-rk35xx`, Radxa Zero 3W:

- Camera answers register reads on I2C2 address 0x1a.
- Sensor links through `rockchip-csi2-dphy0` to `rkisp_mainpath`.
- NV12 capture at 1280×720, with sensor blanking set for 30 fps, produces images.
- Yonder main H.264 1280×720 at 30 fps and preview H.264 640×360 at 15 fps
  decode through local RTSP. Five-second samples decoded 132 and 75 frames,
  respectively, with no decoder stderr. This is not a latency measurement.
- CSI discovery exposes only the prepared NV12 mode and observed sensor rate.
  It does not claim all stepwise ISP sizes as tested camera modes.

The later native-resolution pass supersedes that initial discovery restriction:
full-field 1080p, 720p and 360p output candidates are now verified with TRY_FMT.
The main H.265 stream was verified at 1080p30 using a Mac decoder while the
independent H.265 preview remained at 720p30. See the final
[hardware record](../../../docs/hardware/seekerhd-on-radxa-zero-3w.md) for measurements.

The reference IQ file is not a calibrated SeekerHD profile: its sensor section
describes another resolution and gain conversion. Do not install it unchanged. Divimath's
[tuning guide](https://github.com/rquellet/SeekerHD-RaspberryPi-Helper/blob/main/docs/imx462-tuning.md)
uses Raspberry Pi's ISP format; its gain and shadow-lift intentions must be
translated to Rockchip's ISP rather than copying the JSON directly.

## ISP service and tuning

The image-processing sources are
[roju/rkaiq_3A_server-rk356x](https://github.com/roju/rkaiq_3A_server-rk356x)
at `622bdfa1ee61d2279cfc273b1a53b546e0ec71be`. Apply the three `aiq-*.patch`
files in this directory to that tree. Build with CMake on the board; `xxd`
is also a build dependency. The patches:

- Select the 1920×1080 sensor mode and the private SeekerHD IQ directory;
  notify systemd only after preparation and stream-event subscription.
- Fall back from denied realtime scheduling to a normal-priority statistics
  thread. On this Armbian kernel, root cannot enter SCHED_RR in the service's
  cgroup. The original library silently lost the statistics thread, leaving
  exposure and white balance fixed despite reporting successful startup.
- Derive pixel clock from **current blanking and current frame interval**.
  Combining minimum blanking with the current slower interval halved the
  inferred clock and made the automatic exposure engine double the frame rate.

`tune.py` takes the Rockchip reference IQ JSON and the manufacturer's Raspberry
Pi SeekerHD JSON as inputs. It writes a separate Rockchip profile with logarithmic
0.3 dB sensor gain, a 29.512× analogue ceiling plus ISP gain, fixed 30 fps,
the manufacturer's gamma curve resampled onto the ISP21's 45 12-bit knots,
and a black-level offset matching the sensor driver. Unsupported lens shading
is disabled, and duplicated colour-matrix ISO entries are made monotonic.
The reference's colour calibration is provisional; it is not a SeekerHD
factory lens/illuminant calibration. Temporal noise reduction starts disabled.

Input SHA-256 values recorded on 2026-09-09:

| Input | SHA-256 |
|---|---|
| `kinchims` `etc/iqfiles/imx290_IMX462_default.json` at the pinned commit above | `6f596c69c62f9d46be45328d921c52c231426a4f7bbd0a4556bd5111d858052f` |
| Divimath `installer/Divimath-SeekerHD/tuning/imx462-seekerhd.json` | `d51bfea346bd1932ce76cab5cbf064e103af144e0e389178f81bf37e7cae2ac0` |

The board stores the built library and 3A executable under
`/usr/local/lib/yonder-seekerhd`, and the generated profile at
`/usr/local/share/yonder-seekerhd/iqfiles/imx462_IMX462_default.json`.
Its systemd units are included here. `prepare.py` rebuilds the media bindings
when necessary, then sets and reads back the sensor controls and prepares the
ISP's NV12 output. The AIQ unit repeats mode preparation **after** AIQ signals
readiness because AIQ's own initialization resets sensor timing.

The module is built for `6.1.115-vendor-rk35xx`; a kernel update requires a
matching rebuild. These bench sources do not claim portable support for other
kernels, camera connectors or Rockchip boards.
