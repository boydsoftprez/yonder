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

Automatic exposure/colour tuning, persistent startup and final integration
acceptance are still in progress. The reference IQ file is not a calibrated
SeekerHD profile: its sensor section describes another resolution and gain
conversion. Do not install it unchanged. Divimath's
[tuning guide](https://github.com/rquellet/SeekerHD-RaspberryPi-Helper/blob/main/docs/imx462-tuning.md)
uses Raspberry Pi's ISP format; its gain and shadow-lift intentions must be
translated to Rockchip's ISP rather than copying the JSON directly.
