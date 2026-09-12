# Image provisioning audit — 11 September 2026

R-CAM-01, R-CAM-14, R-CAM-15, R-CFG-08, R-HW-03, R-HW-04, R-NET-02.

A successful application build is not proof that a fresh image includes its
hardware prerequisites. This audit compares the installer with the recorded
hardware setup, following a ZERO 3W boot whose console had no CSI camera.

## Why SeekerHD was missing

The camera application and bring-up sources reached main through PR #8
(`141dd3a`), with subsequent camera controls in `b9e13a9`. The sensor driver,
overlay, ISP service and tuning remained a manual procedure under
`scripts/spikes/seekerhd`. The installer explicitly documented that omission.
Image assembly ran the installer and therefore reproduced it. The missing
acceptance check was fresh-image camera provisioning, rather than whether the
camera application sources had merged.

On the bench02 ZERO 3W, the only user overlay was UART2, the IMX462 module and
SeekerHD services were absent, and Linux exposed no video or media nodes. This
establishes a software provisioning gap; it does not assess the connected cable.

## Findings and acceptance boundaries

| Feature | Provisioning evidence | Remaining boundary |
| --- | --- | --- |
| SeekerHD on ZERO 3W | Role 53 installs the driver/overlay/ISP/profiles; the image builder verifies the assembled stack | Live retrofit detection and 90-frame 1080p H.265 capture passed; fresh-card candidate boot and physical camera-absent startup remain untested |
| UART2 on ZERO 3W | Image target enables UART2 and removes serial console; ttyS2 exists on bench02 | Electrical pin/loopback or telemetry test |
| Rockchip H.265 | Plugin/library payload installed; 150 generated 1080p frames encoded successfully on bench02 | CSI-to-encoder delivery and sustained performance |
| USB camera power | Role 15 installs the UVC runtime-power rule | Attached-camera test |
| Pocket 2 on Raspberry Pi | Role 18 installs FunctionFS prerequisites; peripheral-mode setup remains an explicit manual procedure | A supported hardware setup choice, independent power verification and Pi cold-boot test; do not claim plug-and-play image support |
| Modem | ModemManager installed and enabled by roles 10/40 | Attached-modem connection test |
| Core, console and Wi-Fi | Enabled in image; ZERO 3W AP onboarding and LAN connection observed | AP fallback and restart persistence tests |
| Local hostname resolution | Minimal base lacked libnss-myhostname; role 10 now installs it; live resolution verified | This does not resolve collisions between multiple boards advertising the same hostname |
| MediaMTX, router and mesh | Installed; activation deliberately follows operator configuration | No requirement to enable unconfigured network services at image build time |
| Protected storage and owner recovery | Approved design; bench image explicitly writable with temporary SSH | Implementation and power-cut qualification remain outstanding |

Keep camera runtime failure independent from console reachability. A board with
no attached camera must still finish setup and provide its AP. The ZERO 3W camera
stack is not transferable evidence for ROCK 5C: its connector and ISP differ.

Future image checks must validate provisioned artifacts inside the assembled
root filesystem, not merely source-file presence or an existing development
board. Physical test records must identify the image candidate actually tested.

## Pocket 2 on ZERO 3W: initial prerequisite observation

The current ZERO 3W exposes USB device controller `fcc00000.usb` under
`/sys/class/udc`, and role 18 has installed the FunctionFS module configuration.
The Pocket 2 transport uses the selected Linux controller and generic configfs /
FunctionFS interfaces; it is not restricted to a Raspberry Pi controller name.
This supports investigating the combination, not advertising tested compatibility.

Radxa documents separate USB 2.0 OTG/power and USB 3 host Type-C ports in its
[ZERO 3 hardware interface reference](https://docs.radxa.com/en/zero/zero3/hardware-design/hardware-interface).
The Pocket 2 accessory protocol needs the board's device-capable port. Power and
cabling must be established before trying that port; no Pocket 2 connection,
video decode or control test was performed during this audit.

Subsequent hardware testing did enumerate HG211 and show a preview. It also
found the accessory software-decoder omission; see the [Pocket 2 follow-up](zero3w-bench-first-boot.md#pocket-2-hardware-decode-follow-up)
for the source fix, live retrofit and image-version limits.

## Regression and review checks

The camera provisioning suite covers target selection, target-root kernel/header
selection, module input versioning, overlay composition, installed artifacts and
DKMS retry transitions. Independent review found that an interrupted installation
could leave DKMS in the `built` state; retry now resumes at install instead of
trying to build again. All nine focused checks pass, together with thirteen
SeekerHD Python tests and the sensor arithmetic checks. The existing image
installer suite (34 checks), installer library suite (16 checks) and installer
Vitest suite (127 tests) also pass. GitHub CI now builds the SeekerHD ARM64
payload and checks its hashes and architecture; remote CI execution remains
pending publication of these source changes.
