# Installer and payload reference

**Installing your first board? Follow [Getting started](../docs/getting-started.md).**
That guide covers the SD card, base OS, SSH, build computer, transfer, first login
and verification. This page explains the installer and payload behind that procedure.

`install.sh` is the shared definition of the installed system. It can run on a
prepared board or inside an appropriately prepared image-building environment.
There is no published ready-to-flash Yonder image yet.

```sh
./installer/install.sh --dry-run
sudo ./installer/install.sh
sudo ./installer/install.sh --only 20-yonder-core
```

An image builder invokes the same installer from inside the already-mounted
target root:

```sh
./installer/install.sh --image --target rpi
./installer/install.sh --image --target radxa-zero3w
```

Image mode requires one of `rpi`, `radxa-zero3w`, or `radxa-rock5c` and a
complete ARM64 application and payload. It fails before mutation when required
compiled packages, the recursive required dependency closure, the safe core
module import, external payload components, boot files, or architectures do not
match. Radxa payloads must provide the exact `librockchip_mpp.so.1` and
`librga.so` sonames the plugin loads, resolved to staged ARM64 files. `--only`
remains available for controlled repair/testing, but it does not relax the
complete image-payload preflight.

Package maintainer scripts are held behind a temporary `policy-rc.d` while an
image is installed. Any prior policy file is moved aside and restored on normal
exit, failure, or a handled termination signal. Intended boot enablement is
written offline: core, console, Avahi, NetworkManager and ModemManager are
enabled; mavlink-router, ZeroTier and MediaMTX stay disabled until configuration
owns them. No service is started/restarted, and no udev, module, configfs or
hardware-device operation runs in image mode.

The Raspberry Pi candidate prepares the existing `config.txt`/`cmdline.txt`
layout. The ZERO 3W candidate applies only the Armbian network handoff and
`uart2-m0` preparation observed on the previous board. These are prepared image
candidates; cold-flash/first-boot qualification and Raspberry Pi model coverage
remain pending. ROCK 5C image installation currently refuses before
mutation because its header UART/boot assets have not been qualified; it never
receives the ZERO 3W overlay. Rockchip libraries and the GStreamer plugin are
installed for declared Radxa images without manufacturing `/dev/mpp_service`;
encoder discovery remains a runtime check on the board.

An existing device configuration is preserved. Source files and runtime artifacts
are replaced by the selected build. Configuration rollback does not roll back a
software install. Use a bench maintenance session and keep a private backup.

## What the installer needs

- A supported 64-bit Debian-family target with systemd and apt.
- NetworkManager ownership of the interfaces, including the Wi-Fi radio used
  for fallback. The installer does not automatically retire an Armbian
  netplan/systemd-networkd configuration.
- A complete source tree with all active console packages built.
- The target-architecture payload and the core’s standalone production dependencies.
- Internet access for missing OS packages, or those packages already installed/cached.

The payload reduces network work on the board. It does **not** contain the whole
Debian package repository: GStreamer, NetworkManager, ModemManager, Python GI,
diagnostic utilities and other system dependencies may still be installed by apt.
The earlier fully offline Radxa install also pre-cached its apt dependencies.

## Build the application

On a build computer with Node 24 and npm:

```sh
npm ci
npm run version:check
npm run build
(cd packages/yonder-core && npm ci --omit=dev --workspaces=false --os=linux --cpu=arm64 --libc=glibc)
```

The root build orders the core before the adapters and Vue widgets. The asset
copier carries HTML, scripts and other runtime assets that TypeScript alone does
not emit. Every active package’s `dist/` and the dashboard’s resources must reach
the board.

`--workspaces=false` creates a real `packages/yonder-core/node_modules/`. A
workspace-root dependency tree, or a `.vite` cache, is not that standalone tree.
The installer checks dependency completeness and loads the installed core entry
point before enabling it. The core has a build-on-board fallback, but the console
packages require prebuilt artifacts; the complete prebuilt path is the recommended
first-install procedure.

## Build the target payload

```sh
# Pi 4: skip the Rockchip plugin build.
./installer/make-payload.sh --arch linux-arm64 --only node,zerotier,mavlink-router,console

# Radxa: all components, including the Rockchip stack.
./installer/make-payload.sh --arch linux-arm64

# PC test environment, where those components support it.
./installer/make-payload.sh --arch linux-x64
```

The selector accepts `node`, `zerotier`, `mavlink-router`, `gst-rockchip`, and
`console`. **MediaMTX is currently staged on every run**, including a `--only`
run. Components omitted from the selector remain as previously staged; selecting
one component does not clean the others. `--out DIR` changes the destination.

| Staged path | Contents / validation |
| --- | --- |
| `vendor/node/bin/node` | Node 24.20.0 by default; archive checked against published checksums |
| `vendor/zerotier/` | ZeroTier package; recorded hash plus signed apt-index verification |
| `vendor/mavlink-router/mavlink-routerd` | Built from pinned source in a target-architecture container; version and ELF architecture checked |
| `vendor/gst-rockchip/lib/` and `vendor/gst-rockchip/gstreamer-1.0/` | MPP, librga and Rockchip GStreamer plugin from pinned sources |
| `vendor/mediamtx/mediamtx` | MediaMTX 1.20.1 by default; recorded release checksum verified |
| `vendor/console/` | Node-RED and FlowFuse Dashboard, installed from the console lockfile for the target OS/CPU/libc |

Exact pins and checksums live in `make-payload.sh`. Docker or Podman with the
appropriate ARM64 execution support is required for the source-built payload
components. Building those C++ dependencies on a low-memory aircraft board is
not the recommended route.

CI’s `payload-mavlink-router` and `payload-gst-rockchip` jobs upload their ARM64
outputs. To use a verified artifact from the same source revision, place the
router at `vendor/mavlink-router/mavlink-routerd` or the Rockchip artifact’s
`lib/` and `gstreamer-1.0/` under `vendor/gst-rockchip/`. Preserve executable bits
where applicable, then stage the other components with `--only`. These artifacts
are not complete installations and are not SD images.

`vendor/` is ignored by Git. Transfer it with the source/build tree; do not commit
it. The console and standalone core lockfiles are committed. First-party versions
move together using [CalVer tooling](../docs/versioning.md).

## Install roles

Roles are POSIX shell files in `roles/`, sourced in numeric order. A `--only`
argument is an exact role basename, such as `30-console`. Running only a role
assumes its prerequisites are already installed.

| Role | Responsibility |
| --- | --- |
| `10-base` | System dependencies, service accounts, owned directories, mDNS |
| `15-mavlink-router` | Verified telemetry router and service; starts only when configured by the core |
| `20-yonder-core` | Core runtime, seeded defaults, assets and service validation |
| `30-console` | Dashboard runtime, all Yonder adapters/widgets, generated settings and authenticated editor |
| `40-modem` | Modem integration |
| `40-uart` | Supported boot-layout UART preparation; requires reboot |
| `40-zerotier` | Mesh client; disabled until a network is configured |
| `50-mediamtx` | Media server, authentication/configuration path and required GStreamer elements |
| `52-gst-rockchip` | Matching Rockchip plugin/libraries and registry checks on the applicable hardware |
| `53-seekerhd` | ZERO 3W IMX462 driver, camera overlay, ISP21 runtime and tuning; verifies installed prerequisites |
| `55-pipeline-host` | Python/GStreamer pipeline host and accessory support prerequisites |

ZERO 3W installation includes the SeekerHD sensor/ISP stack using
`installer/make-payload.sh --arch linux-arm64 --only seekerhd` to assemble its
required offline runtime. Role 53 installs the sensor through DKMS, validates
the camera overlay with the base tree and UART overlay, and installs the ISP
service and normal-light tuning. The installer checks the assembled files;
camera activation after a live installation requires a reboot. Camera absence
must not prevent the console from starting. See the
[bring-up sources](../scripts/spikes/seekerhd/README.md) for the hardware scope
and the [provisioning audit](../docs/hardware/image-provisioning-audit.md) for
remaining hardware-specific setup. This ZERO 3W stack is not a ROCK 5C camera
driver and does not enable experimental HDR.

## Verify the result

A dry run checks the planned inputs but cannot prove service startup, radio
ownership, a camera picture or a full power cycle. For the actual install,
inspect its exit status and service journals, then check the console and hardware
as described in [installation verification](../docs/getting-started.md#8-verify-your-own-installation).

The local automated checks are:

```sh
npm run lint
npm test
npm run build
./installer/install.sh --dry-run
./scripts/verify-installer-lib.sh
./scripts/verify-installer-image.sh
```

`verify-pages.sh` additionally starts an isolated fixture console and browser;
see [Verifying the console](../docs/verifying-the-console.md). It does not touch
an aircraft. Node 20 remains the tested core-only runtime floor; the complete
console needs at least Node 22.12 and the payload ships Node 24.

The image verifier covers flag/payload rejection, service and hardware-call
guards, policy restoration and declared-target Rockchip installation with
filesystem fixtures and command shims. An ARM64 Debian Trixie container has
also exercised the actual offline `systemctl --root=/` links and apt policy
boundary. This is not a complete base-image build, first-boot/AP result, encoder
result, or physical-board qualification.

The private ROCK 5C bench exception uses
`--image --target radxa-rock5c --hardware-test`; the flag is rejected for live
installation and other targets. It preserves the UART2 recovery console and
only stages UART4 when the applied device tree matches the expected M2 pins.
See the [bench builder and first-flash procedure](../image/bench/README.md).
This exception does not qualify a release, protected storage, or camera support.
