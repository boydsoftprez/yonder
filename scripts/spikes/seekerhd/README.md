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

The vendor ISP removes unready sensor links during a kernel late-init call,
before this sensor module loads. The ZERO 3W installer preserves those links
with `initcall_blacklist=rkisp_clr_unready_dev` in the boot arguments. The sensor
can then join the original media graph when its module loads. Preparation must
never unbind/rebind the vendor ISP or DPHY: their remove paths retain references
and can crash the kernel. If the graph is missing, preparation fails without
touching those bindings. See the [startup recovery evidence](../../../docs/hardware/seekerhd-startup-recovery-2026-09-13.md).

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
at `622bdfa1ee61d2279cfc273b1a53b546e0ec71be`. Apply `aiq-server.patch`,
`aiq-thread-fallback.patch`, and `aiq-sensor-timing.patch`, followed by
`aiq-live-controls.patch`. Build with CMake on the board; `xxd`
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
- Expose a local native ISP control socket for live preset and color changes;
  see [the protocol and build notes](aiq-live-controls.md). Experimental HDR
  patches are separate and are not part of this normal camera service build.

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
Its systemd units are included here. `prepare.py` checks the existing media
graph, then sets and reads back the sensor controls and prepares the
ISP's NV12 output. The AIQ unit repeats mode preparation **after** AIQ signals
readiness because AIQ's own initialization resets sensor timing.

The module is built for `6.1.115-vendor-rk35xx`; a kernel update requires a
matching rebuild. These bench sources do not claim portable support for other
kernels, camera connectors or Rockchip boards.

## Named image profiles (R-CTL-16)

`profiles.py` generates two first-pass ISP21 treatments from the **original
`tune.py` output**, plus a byte-identical `legacy-low-light` rollback copy:

| Profile | Gamma | Denoise | ISP gain policy | Sharpening ratio |
|---|---|---|---|---|
| `normal-light` | 65% helper curve + 35% linear input | Bayer, luma, chroma and temporal NR off | Up to 16× analogue, no extra ISP gain | 0.6 |
| `low-light` | Full helper shadow lift | Half-strength reference chroma NR; Bayer, luma and temporal NR off | Up to 29.512× analogue and ~3.388× ISP gain | 0.35 |
| `legacy-low-light` | Original bring-up profile | Original settings | Original settings | Original settings |

Both preserve the fixed 30 fps exposure/frame-timing setup, black level,
white-balance/colour matrices and the disabled uncalibrated lens-shading grid.
These are image treatments, not measured factory colour/noise calibrations.
The gain limits are tuning choices; the 100× night combination is a permitted
AE limit, not a claim that every frame uses it. Normal Light deliberately
accepts visible grain rather than smoothing fine detail away.

Generate from a preserved baseline, not from an already modified named profile:

```sh
python3 profiles.py original-tuned-iq.json generated-profiles
```

Install the generated JSONs and `manifest.json`, owned by root with mode 0644,
under `/usr/local/share/yonder-seekerhd/profiles`, and install `select-profile.py` as
`/usr/local/bin/yonder-camera-profile` with mode 0755. The camera page offers
these presets under **Camera image and capture → Camera image → Preset**.
The same presets are available from the command line:

```sh
sudo yonder-camera-profile normal-light
sudo yonder-camera-profile low-light
sudo yonder-camera-profile legacy-low-light
yonder-camera-profile status
```

With the live ISP bridge installed, preset selection and the four native color
controls update the running ISP without restarting the core, encoder or sensor.
Brightness, contrast, saturation and hue use native 0–255 levels; 128 is neutral.
Values shown by the page come from RKAIQ readback. Presets persist in the active
IQ file across reboot. Individual color adjustments are runtime controls and
reset on preset reload or ISP service restart. Start video before adjusting.

On legacy installs without the bridge, the command-line selector checks the
generated profile's checksum and the attached IMX462,
stops its video through the core API, replaces the active IQ JSON atomically,
restarts the ISP service, and restarts video only if it was previously running.
Failure restores the exact preceding IQ bytes. The console and network services
are not restarted. The active IQ file persists across reboot; status identifies
it by hash rather than maintaining a second copy of the selection. A failed live
command never silently falls back to this interrupting legacy procedure.

For an ISP-only comparison, set the Yonder Stream Color controls to neutral
through Apply (brightness 0, contrast 100, saturation 100, hue 0). Otherwise
those additional CPU adjustments are applied on top of either profile.

### HDR availability

[Sony's IMX462LQR product information](https://www.sony-semicon.com/files/62/pdf/p-12_IMX462LQR_LQR1_LLR_Flyer.pdf)
lists multiple-exposure and digital-overlap HDR. This establishes a sensor
capability, not by itself a working SeekerHD/Radxa camera mode.

The driver now contains an **experimental**, opt-in two-exposure DOL path
(R-CTL-06). Its IMX462 register sequence comes from Rockchip's GPL-2.0
[IMX462 driver at f39b590](https://github.com/rockchip-linux/kernel/blob/f39b590ea11da2d897644e42119ba5099b2eefc8/drivers/media/i2c/imx462.c),
which publishes a **four-lane** HDR2 mode. The bench adaptation uses the
already working two-lane 891 Mbit/s PHY configuration, preserving the same
aggregate serial rate. This conversion is an engineering hypothesis requiring
hardware validation; no published two-lane IMX462 DOL table was found.

The mode is 1952×1089 RAW10 with ID-code framing, HMAX 2028, VMAX 1220,
FSC 2440 and RHS1 225. The ISP produces the configured video output size.
The intended output remains tone-mapped NV12 through the existing H.265
streams; sensor HDR capture does not imply HDR10 video or display signalling.
The mode's calculated rate is about 30.01 fps; odd frame-length requests round
up to an even FSC because sensor VMAX represents half the HDR frame. The
vendor exposure callback's hardcoded RHS1=9 does not match its MIPI table;
this implementation uses the table's RHS1=225 and checks both shutters before
writing either. Separate gains and shutters use register hold. Linear control
writes cannot overwrite the HDR exposure pair.

`experimental_hdr2=1` must be supplied **when loading** the module. It defaults
off and is read-only after load. HDR3, unsupported lane/clock combinations and
live mode changes are rejected. Stopping video and returning to linear resets
the DOL registers. The opt-in is a bench mechanism, not a supported-camera
capability claim or a dashboard HDR toggle.

Do not replace this sensor driver through runtime unbind/unload on the vendor
kernel. A sensor-only replacement faulted in the V4L2 asynchronous notifier;
a subsequent full-graph teardown lost board access before its failure phase
could be recorded. The vendor ISP/DPHY remove paths leave persistent references
behind. A cold-boot, one-use candidate load succeeded instead: the original
module remained installed, and the test marker was consumed and synchronized
to disk before inserting the candidate. The following boot uses the original
module. A userspace rollback cannot guarantee recovery from a kernel fault.

#### Hardware result: RK3566 merge feature gate

The 2026-09-10 bench reached actual sensor DOL programming, but **did not
produce HDR video**. Sensor readback during a bounded capture-to-null test was:

| Field | Readback |
| --- | --- |
| HDR mode / packing | HDR_X2 (5) / HDR_ID_CODE (2) |
| WDMODE / lane count | 0x11 / 2 |
| HMAX / VMAX / RHS1 | 2028 / 1221 / 225 |
| SHS1 / SHS2 | 151 / 1855 |
| Short / long integration | about 0.997 ms / 8.003 ms |
| Short / long analogue gain register | 20 / 20 (about 2×) |

The kernel explicitly logged `hdrmge is not supported`, followed by MIPI
frame drops. No ISP output frames arrived within 20 seconds. The live
`rockchip,iq-feature` value was `0x1bfbf7fe67ff`, with HDRMGE bit 27 clear.
This matches the vendor [RK3566 override](https://github.com/rockchip-linux/kernel/blob/77168c8d5ab82399f65a80e9f807b50ba37cf483/arch/arm64/boot/dts/rockchip/rk3566.dtsi).
The [ISP21 CSI setup](https://github.com/rockchip-linux/kernel/blob/77168c8d5ab82399f65a80e9f807b50ba37cf483/drivers/media/platform/rockchip/isp/csi.c)
rejects HDR merge when that bit is absent; its caller nevertheless starts the
sensor, which explains mode readback without delivered frames. This proves
the current vendor configuration excludes the needed merge path, not that
changing lane timing or bypassing the mask would provide working HDR.

The AIQ patch now checks that feature bit before requesting HDR. It fails
closed on a missing/malformed feature property or a mask without HDRMGE.
This vendor profile does not establish whether the block is physically absent
or fused off; no feature-mask override was attempted.
No dashboard HDR capability is advertised for this board. The sensor path
and manual calibration remain experimental building blocks for a supported
ISP or a separately validated merge implementation.

Returning the already loaded candidate to linear reset WDMODE, SHS2 and RHS1
to zero and restored H.265 playback. A 20-second off-board decode measured
29.73 fps on both 1920×1080 main and 1280×720 preview, with five single-frame
gaps; this verifies recovery, not stutter-free performance. All test capture
frames were discarded. No camera images or videos are part of this change.

Apply `aiq-hdr-mode.patch` after the existing three AIQ patches, and apply
`aiq-vendor-hdr-abi.patch` to the RKAIQ library before rebuilding it. Both pin
the vendor frame-interval ABI to 64 bytes with the HDR mode at byte 32.
Newer Debian headers reuse that word as `stream`, moving their `reserved[0]`
to byte 36; using those headers directly hides the sensor's HDR modes. The 3A service
uses linear capture unless `YONDER_SEEKERHD_MODE=hdr2` is explicitly set. HDR
activation requires an enabled ISP merge feature and an advertised matching sensor mode and checks
`RKMODULE_GET_HDR_CFG` again after ISP preparation; this compensates for the
library otherwise ignoring a failed sensor mode change. Updated `prepare.py`
preserves HDR timing instead of writing linear shutters after ISP readiness.

`hdr-profile.py` derives a separate experimental IQ file from a normal-light
profile. It preserves the linear scene and creates an HDR scene with fixed
1 ms / 8 ms exposures and matched 2× gain by default. Manual exposures make
initial sensor/merge verification reproducible; this is not a tuned automatic
HDR profile. Merge curves and colour calibration remain provisional. The
existing named image-profile selector continues to select linear profiles.
Do not activate an HDR IQ file independently of the driver and ISP mode.

`hdr-status.c` is a read-only bench diagnostic for this board's I2C2/0x1a
sensor. It reports the HDR ioctl, sensor timing/shutter/gain registers, lane
count and frame interval as JSON. Build it using the installed vendor
`rk-camera-module.h` and `rk-video-format.h` with the normal userspace Linux
headers. It does not read or save images. Verify actual sensor DOL mode,
different exposure registers, ISP `HDRMGE` enabled, advancing output frames,
delivered frame spacing and return to linear before calling HDR usable.

Run the sensor arithmetic regression cases in addition to the Python tests:

```sh
cc -Wall -Wextra -Werror scripts/spikes/seekerhd/test_imx462_hdr2.c -o /tmp/test-imx462-hdr2
/tmp/test-imx462-hdr2
python3 -m unittest discover -s scripts/spikes/seekerhd -p 'test_*.py' -v
```

### First hardware comparison

On 2026-09-10 UTC, all three profiles produced independently decoded 1920×1080
JPEG photographs, with neutral Stream Color settings. Normal Light visibly
reduced the lifted appearance modestly; Low Light retained more shadow lift.
Noise and clipping around bright lamps remain. The room was illuminated and
exposure was automatic, so this was not a laboratory sharpness test or a dark
scene sensitivity test. No lens-focus adjustment was made. Normal Light was
left active with the established 1080p main / 720p preview H.265 streams.

Run the generator and rollback regression tests with:

```sh
python3 -m unittest discover -s scripts/spikes/seekerhd -p test_profiles.py -v
```

The normal-profile playback check decoded both H.265 outputs for 20 seconds:
29.945 fps on each, with one gap over 50 ms after acquisition. Initial HEVC
join diagnostics remain, as in the earlier pipeline tests. Profile switching
and full-resolution still capture were verified for Normal Light and Low
Light; the rollback path and generation invariants have three unit tests.
The preserved baseline SHA-256 is
`d56804d766804397d3dc5a6947e5480146912e3d82909f9bf27a390d41b58fc2`.
