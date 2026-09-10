# Tested hardware

[Start here](getting-started.md) · [User guide](user-guide.md) · [Flight guide](cockpit-user-guide.md)

This page describes combinations actually exercised during Yonder development.
“Tested” means the particular functions and conditions in the linked record. It
is not certification, a guarantee for every peripheral, or physical flight acceptance.

## Boards and operating systems

| Board | Recorded system | Observed use | Qualification limits |
| --- | --- | --- | --- |
| **Raspberry Pi 4 Model B Rev 1.5** | 64-bit Raspberry Pi OS / Debian 13 (trixie), kernel `6.18.34+rpt-rpi-v8`; the original board had about 905 MB usable RAM | Console, network fallback, Ethernet/Wi-Fi/LTE, ZeroTier, MAVLink UART, USB camera encoding, Pocket 2, combined Flight/camera/network application | Fresh-image end-to-end acceptance remains recorded separately; adequate power and cooling matter under video load |
| **Radxa Zero 3W / RK3566** | Armbian 26.8.1 trixie, vendor kernel `6.1.115-vendor-rk35xx`; approximately 2 GB RAM | Installation, networking, header UART, Rockchip MPP video, SeekerHD CSI/ISP operation and reboot recovery | NetworkManager must own the interfaces; CSI preparation is specific to this vendor kernel and sensor |

For a first installation, follow the **Pi 4** path. The Radxa is a working
advanced target, with more OS and camera preparation. Other Pi and Radxa models
remain candidates until they have their own installation and hardware records.
A shared SoC family or connector does not qualify another board automatically.

Evidence: [Pi first boot](hardware/verifying-m1a.md),
[Pi camera](hardware/usb-camera-on-a-pi-4.md),
[combined Pi integration](hardware/2026-09-09-cockpit-camera-integration.md),
[Radxa installation](hardware/installing-on-a-radxa-zero-3w.md),
[Rockchip video](hardware/rockchip-video-shipped.md).

## Cameras

| Camera | Tested connection | What works / what to account for |
| --- | --- | --- |
| **ELP USBGS1200P01-H120**, USB ID `32e4:0234` | USB UVC on Pi 4; recorded as “Global Shutter Camera” | Discovery, MJPEG input, hardware H.264 output, camera controls, recording/stills. The source MJPEG decode has a CPU cost; hardware encoding does not make the whole path free |
| **DJI Pocket 2** | Pi 4 USB-C in peripheral/gadget mode, with independent board power | Accessory video, native image/capture controls and card recording/photo, guarded pan/tilt and measured native travel/presets. This is not a UVC camera plugged into an ordinary USB host port |
| **Divimath SeekerHD / Sony IMX462** | Prepared MIPI CSI/ISP graph on Radxa Zero 3W | Main and preview H.265 decoding demonstrated at 1080p30 with adequate cooling; H.264 remains available. Requires sensor module, device-tree overlay and RKAIQ preparation; HDR is not implemented |

Camera menus follow the formats and controls the attached device reports.
Advertised-but-unavailable controls and stale feedback are stated rather than
assumed to work. H.265 preview also needs a browser that can receive it; use
H.264 for broader compatibility. A requested bitrate or frame rate is not itself
a measurement of delivery.

Read the measured limits before choosing a profile:
[ELP pipeline](hardware/usb-camera-on-a-pi-4.md),
[Pocket 2 setup and controls](hardware/pocket2-resume-2026-09-08.md),
[Pocket 2 range and presets](hardware/pocket2-gimbal-range-2026-09-09.md),
[SeekerHD setup and thermal results](hardware/seekerhd-on-radxa-zero-3w.md).

## Flight controller and ground stations

A physical **ArduPlane** controller was detected over 3.3 V UART on the Pi 4 at
115200 baud, using MAVLink v2. The record identifies the protocol and connection,
not a universally qualified autopilot board model.

For the Pi 4’s tested header connection:

| Pi physical pin | Signal | Flight-controller connection |
| --- | --- | --- |
| 6 | Ground | Ground |
| 8 | GPIO14 / UART TX | Telemetry RX |
| 10 | GPIO15 / UART RX | Telemetry TX |

Both ends must use compatible **3.3 V logic**. The tested connection has no power
wire between them; each device has its own appropriate supply. Check the flight
controller’s pinout. Do not apply this Pi pin table to a Radxa header.

The installer frees the supported header UART from the serial console; a reboot
applies boot-overlay changes. Controller port protocol and rate still have to be
configured correctly in ArduPilot. USB serial is a supported discovery path, but
the header-UART evidence does not validate every USB adapter.

[UART evidence and wiring](hardware/an-autopilot-on-the-uart.md) ·
[Telemetry setup](user-guide.md#telemetry-and-ground-stations)

Mission Planner and QGroundControl have been used during development. Specific
video and telemetry results are in the hardware records; a decoded RTSP sample,
an active connection, a completed parameter download, and an operator viewing
the picture are different checks. The Flight command workflows also have
separate **ArduPlane 4.7.1 QuadPlane SITL** evidence in the
[Flight guide](cockpit-user-guide.md#native-arduplane-sitl-walkthrough).

## Cellular

**Quectel EC25 / EC25-AF** LTE hardware has been exercised with ModemManager and
MBIM, including SIM/APN configuration, signal readback, boot retries, and
network diagnostics. Supply a compatible SIM/data plan and antennas. Carrier
support and the right APN come from the SIM provider.

Other 4G/5G modems and modem-as-router devices need their own validation. The
presence of a configuration mode is not a tested-modem list.
[Network observations and evidence](hardware/network-diagnostics.md).

## Power, cooling, and storage

Use a reliable board-rated supply, appropriate cables, and cooling for sustained
camera operation. The Pi Pocket 2 path requires independent Pi power while USB-C
is used as a device port; follow its wiring notes before enabling gadget mode.
Radxa tests showed a strong dependence on cooling, including reduced performance
when a cooling connection was lost.

A 32 GB or larger microSD card is a practical starting point for the OS and
application, with additional space according to recording needs; it is not a
measured minimum. Board recordings use board storage, while Pocket 2 native
recordings use the camera’s card. Preview thumbnails are transient RAM data.
Check free space, the recording reserve, and behavior after a full power cycle.

## Report another combination

Include the exact board revision, RAM, OS image, kernel, power supply, camera
USB identity or CSI module, modem, firmware, and Yonder version. Say which
functions you exercised, for how long, and whether the observation was from the
browser, a decoder, or the aircraft. Add that evidence before expanding the table.
