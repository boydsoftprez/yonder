# From a board and SD card to Yonder

[Project overview](../README.md) · [Tested hardware](hardware.md) · [User guide](user-guide.md)

This guide installs Yonder **<!-- yonder:version -->2026.9.0<!-- /yonder:version -->** from source onto a base Linux OS.
There is currently no published Yonder disk image. The primary path is a
**Raspberry Pi 4 with 64-bit Raspberry Pi OS Lite**. Radxa Zero 3W notes are
included where its setup differs.

## When a ready-to-flash image is published

A published release may include `rpi`, `radxa-zero3w`, and `radxa-rock5c`
ARM64 images. Download the `.img.xz` whose target matches the board and its
adjacent `.sha256` file. Verify the compressed download before flashing; for
example on Linux or macOS:

```sh
shasum -a 256 -c yonder-VERSION-TARGET-arm64.sha256
```

Use Raspberry Pi Imager, Armbian Imager, or another verified raw-image writer
to write the `.img.xz` to the intended card. On first boot, join the **yonder**
Wi-Fi network with the published initial passphrase **yonder1234**, open
`http://yonder.local:3000`, and create the console password. The setup console
then lets you join the board to the normal Wi-Fi network and create the Linux
owner account, including password and SSH-key access. Change the access-point
passphrase after setup.

GitHub draft releases are build candidates and are deliberately withheld from
ordinary downloads. A candidate's static verification does not claim that its
board, camera, encoder, UART, or power-cut behavior has passed physical
qualification. Until a matching image is published for the target, continue
with the base-OS installation below.

You will use two terminals: one on your **build computer**, and one connected
to the **board over SSH**. Commands below identify which machine runs them.
Start on the bench, with propellers removed and the aircraft disarmed.

## 1. Gather the hardware and flash the OS

You need:

- A tested board, a microSD card and reader, and a board-rated power supply.
  A 32 GB or larger card is a practical starting point, with more space for recordings.
- A computer with internet access and a browser. Ethernet makes the initial Pi
  installation easier to follow while Wi-Fi is configured.
- For later steps, a compatible flight controller and camera. You can bring up
  the console before attaching either.

### Raspberry Pi 4

On your computer, install [Raspberry Pi Imager](https://www.raspberrypi.com/software/).
Select Pi 4 and **Raspberry Pi OS Lite (64-bit)**, then choose your SD card.
The tested system is based on Debian 13 (trixie); an older or different image is
not the same tested combination.

In Imager’s OS customization, set:

1. A hostname you can recognize, such as `yonder-setup`.
2. Your own OS username and password; do not assume a default `pi` account.
3. SSH access, preferably with your public key.
4. Your Wi-Fi country. If Ethernet is unavailable, also configure an initial
   Wi-Fi connection to your router.

Check that the selected storage device is the SD card you intend to erase,
write the image, let verification finish, then eject it. These are the standard
[Imager and headless setup steps](https://www.raspberrypi.com/documentation/computers/getting-started.html#install-using-imager).

### Radxa Zero 3W

Use the [Armbian image for Radxa ZERO 3](https://armbian.com/boards/radxa-zero3),
following its first-boot/account instructions. The recorded Yonder combination
is **Armbian 26.8.1 trixie with `6.1.115-vendor-rk35xx`**, not any image carrying
the same board name. The SeekerHD integration depends on the vendor kernel.
An archive of the matching image may be needed as current downloads change.

Keep a local console or another recovery method available. The tested image
used one ext4 partition, which macOS cannot read natively in an SD reader.
Prepare NetworkManager as described in step 3 before installing Yonder.

## 2. Boot the board and find it

Insert the card, connect Ethernet if available, and power the board. Find its
address in your router’s DHCP/client list. Its configured `.local` hostname may
also resolve on your computer.

**On your computer**, replace the placeholders with your OS account and address:

```sh
ssh YOUR_USER@BOARD_ADDRESS
```

**On the board**, check the image and CPU architecture:

```sh
uname -m
cat /etc/os-release
uname -r
```

Expect `aarch64` for the supported ARM64 payload. A 32-bit OS needs reflashing
with the 64-bit image; changing the download filename is not a conversion.
Then install the transfer utility and refresh package metadata:

```sh
sudo apt-get update
sudo apt-get install -y rsync
```

The initial OS/SSH account is separate from the Yonder administrator account
that you will create in the browser.

## 3. Check who manages networking

Yonder configures **NetworkManager**. It cannot provide its network rollback or
access-point fallback if another service exclusively owns the interfaces.

**On the board:**

```sh
command -v nmcli
nmcli device status
systemctl is-active NetworkManager
```

If `nmcli` is absent, install NetworkManager before continuing:

```sh
sudo apt-get install -y network-manager
```

The interfaces you will use must be managed by it. A disconnected interface is
not necessarily a problem; **unmanaged** means ownership needs attention.

Raspberry Pi OS Lite on the tested image already used NetworkManager. The
recorded Armbian image used netplan/systemd-networkd and generated a
NetworkManager deny-list. Installing NetworkManager alone did not change that.

For that Armbian case, follow the
[recorded network handover](hardware/installing-on-a-radxa-zero-3w.md#handing-the-interfaces-over)
from a local console or with a verified recovery path. Preserve the old network
configuration, prepare the replacement connection, and reboot into the new
manager. Do not remove the only working remote connection as an unobserved
“cleanup” step. Re-run the checks above before proceeding.

Keep internet access available during installation: the payload includes the
application and selected external binaries, but missing Debian system packages
still come from the board’s configured repositories.

## 4. Build Yonder on your computer

Use a Linux or macOS build environment with:

- Git and **Node.js 24** with npm. The payload currently pins Node **24.20.0**;
  use a matching 24.x build runtime. [Node downloads](https://nodejs.org/en/download).
- npm **10.4 or newer**, so target-OS/CPU/libc options are understood.
- Docker or Podman able to run **Linux ARM64** containers. This builds the pinned
  MAVLink router, and the Rockchip stack when selected. Docker Desktop supplies
  emulation; other hosts need equivalent ARM64 support.
- `curl`, `tar`, `rsync`, and a SHA-256 utility. ZeroTier verification also needs
  GnuPG (`gpg`/`gpgv`). The payload script names missing tools.

The commands in this guide use a POSIX shell. Native Windows PowerShell has not
been validated for this build; use an appropriate Linux environment there.
GitHub may require authentication while the repository is private.

**On your computer:**

```sh
git clone https://github.com/boydsoftprez/yonder.git
cd yonder
node --version
npm --version
npm ci
npm run version:check
npm run build
```

For a **Pi 4**, prepare the ARM64 payload:

```sh
./installer/make-payload.sh --arch linux-arm64 --only node,zerotier,mavlink-router,console
```

For a **Radxa Zero 3W**, include the Rockchip hardware-encoding stack:

```sh
./installer/make-payload.sh --arch linux-arm64
```

Both commands also stage MediaMTX. The full Radxa build additionally compiles
MPP, librga, and the GStreamer Rockchip plugin. Downloads and builds are verified
against the script’s recorded checksums/source pins. Do not bypass a failed
checksum or replace a failed ARM64 build with an x86 binary.

If no container engine is available, a successful repository CI run provides
`mavlink-routerd-arm64` and, when built, `gst-rockchip-arm64` artifacts. Use
artifacts from the **same source revision** and the locations in
[the payload reference](../installer/README.md); do not assume such an artifact
is a complete installer or SD image.

### Make the core self-contained

A normal workspace install places shared dependencies at the repository root.
The installed core needs its own production dependency directory. After the
build above, run:

```sh
(cd packages/yonder-core && npm ci --omit=dev --workspaces=false --os=linux --cpu=arm64 --libc=glibc)
```

Keep the full prepared source tree. In particular it must contain:

| Path | Needed for |
| --- | --- |
| `packages/yonder-core/dist/` and `packages/yonder-core/node_modules/` | Built core and its production dependencies |
| Every active package’s `dist/` | Console adapters and instruments |
| Dashboard `resources/` and its copied assets | Browser widget bundles |
| `vendor/node/`, `vendor/console/`, `vendor/mediamtx/` | Target runtime, dashboard, media server |
| `vendor/zerotier/`, `vendor/mavlink-router/` | Mesh client and telemetry router |
| `vendor/gst-rockchip/` on Radxa | Hardware encoder libraries/plugin |
| `installer/`, `systemd/`, `flows/`, `config/` | Install roles, services, wiring, defaults |

For development, `npm run lint` and `npm test` check the source. They do not
replace installation or hardware checks. The full payload is **not a complete
offline OS package repository**: a fresh board still needs missing apt packages
installed or cached beforehand.

## 5. Copy the prepared tree to the board

**On your computer**, still inside the cloned `yonder` directory:

```sh
rsync -a --exclude='/.git' --exclude='/node_modules' --exclude='/vendor/capture' \
  ./ YOUR_USER@BOARD_ADDRESS:~/yonder/
```

Replace the two placeholders. The trailing `./` copies the contents into
`~/yonder/`. Do not exclude every directory named `node_modules`: that would
also remove the core and console dependencies you just prepared.

This transfers source and build artifacts, not another device’s `/etc/yonder`.
Device configuration, passwords and mesh identity belong to the destination board.

## 6. Install and reconnect

**On the board:**

```sh
cd ~/yonder
./installer/install.sh --dry-run
```

Read the result. It should identify the bundled runtime, prebuilt core, and
vendored console. A missing build, payload, or required tool needs fixing first.
A dry run prints the plan; it does not prove that the actual installation works.

Run the installation as a systemd job so it can finish if the SSH connection
changes while networking is configured:

```sh
sudo systemd-run --unit=yonder-install --remain-after-exit --working-directory="$PWD" \
  /bin/sh -c 'umask 077; exec ./installer/install.sh > /var/log/yonder-install.log 2>&1'
sudo tail -f /var/log/yonder-install.log
```

`systemd-run` returning successfully means the job was **started**, not that the
installation succeeded. When the log reaches `== done`, press Ctrl-C to stop
following the log, then check the actual result:

```sh
sudo systemctl show yonder-install -p Result -p ExecMainStatus
sudo systemctl status yonder-core yonder-console --no-pager
```

Expect `Result=success`, `ExecMainStatus=0`, and working core/console services.
If something failed, read the final error and
`sudo journalctl -u yonder-install -b --no-pager`. Fix the cause and clear the
finished install job before retrying: `sudo systemctl stop yonder-install`.

The installer changes supported UART boot settings, which need a reboot:

```sh
sudo systemctl stop yonder-install
sudo reboot
```

The board’s hostname becomes **`yonder`** by default. Find its new LAN address in
your router, or try `yonder.local`. SSH still uses the OS user from step 1.
Check `systemctl status yonder-core yonder-console --no-pager` again after reboot.

Open one of these **in your computer’s browser**:

- `http://BOARD_ADDRESS:3000` over the LAN.
- `http://yonder.local:3000` where mDNS works.
- Join Wi-Fi **`yonder`**, passphrase **`yonder1234`**, then open
  `http://192.168.77.1:3000` for the local access point.

That access point comes from Yonder after installation, not from a newly flashed
base OS. A functioning fallback also depends on NetworkManager, the Wi-Fi radio,
and valid country/radio settings in the operating system.

## 7. Your first session

1. **Create the console administrator password.** The setup page is the first
   screen; there is no default administrator password. It also protects the
   installed flow editor where that editor is enabled.
2. **Open Status.** Check the version, board, interface addresses, and current
   reachability. Blank or stale measurements are not healthy readings.
3. **Set up your connection.** Network contains Wi-Fi, Cellular, and ZeroTier
   controls. Confirm actual reachability before relying on the route.
4. **Connect telemetry.** Configure the flight controller’s MAVLink port,
   connect the appropriate UART/USB link, and use Telemetry to inspect detection
   and configure ground-station endpoints. [Wiring and procedure](hardware.md#flight-controller-and-ground-stations).
5. **Add a camera.** Use Cameras to discover and configure it, then open Camera.
   Start video explicitly, check the browser picture, and configure the
   independent ground-station output. Pocket 2 and SeekerHD need their
   [additional preparation](hardware.md#cameras).
6. **Open Flight.** Read the displayed aircraft identity and source freshness,
   then follow the [Flight guide](cockpit-user-guide.md#how-to-use-it).
   A missing instrument can mean its source has not been configured or received.
7. **Choose appearance and credentials.** Settings contains Day/Night and the
   console password change. These do not change the OS/SSH password or the AP key.

Use **Keep** only after a pending change has produced the connection or picture
you intended. **Revert** restores the previous configuration; leaving a risky
change unconfirmed lets its timer restore it automatically.

## 8. Verify your own installation

Check the configured services after a reboot. `yonder-core` and `yonder-console`
should be active; the media server, mesh client, router, and camera services
follow their configuration and may intentionally be inactive.

```sh
systemctl status yonder-core yonder-console --no-pager
nmcli device status
ip -br address
sudo journalctl -u yonder-core -u yonder-console -b --no-pager -n 100
```

On the bench, verify both software reboot and a full power-off/power-on cycle.
Confirm that selected camera autostart and telemetry autocast recover, and that
an unplugged device becomes absent/stale rather than remaining displayed as live.
Exercise the chosen ground-station video and telemetry path from that receiver.
A browser picture on the LAN does not establish remote cellular delivery.

Check cooling, supply voltage, recording storage, and loss/recovery behavior
under your intended workload. Record the board, OS, peripherals, Yonder version,
and results. This guide has been checked against source, build artifacts, installer
dry runs, and earlier bench records; this PR does not claim a new cold-flash test.

## If something does not work

| Symptom | First checks |
| --- | --- |
| SSH never connects | OS username, Imager SSH settings, DHCP address, cable/power, local console |
| No `yonder` Wi-Fi | Was Yonder installed? Is NetworkManager active and managing the radio? Is the radio blocked? Inspect `rfkill list` and the core journal |
| Port 3000 does not answer | Current LAN/AP address, core/console service status, installer result; hostname changes after install |
| Page is empty or reports unknown nodes | Transfer all prebuilt packages and dashboard assets; re-run the installer from the complete matching build |
| Core cannot import a dependency | Recreate its nested production `node_modules` using `--workspaces=false`, then transfer/install again |
| A board reports no encoder | OS/kernel and device driver first; on Radxa, check the matching MPP payload and its registry checks |
| Telemetry is silent | Correct controller protocol/rate, TX↔RX and ground, UART reboot, exclusive serial ownership, then Look again now |
| Camera present, no picture | Camera state, codec support, preview mode, power/cooling and logs; use H.264 to check browser compatibility |
| Remote access fails | Test LAN access first; check cellular internet and ZeroTier membership/authorization on both ends |

For more, see the [user guide](user-guide.md), [known issues](known-issues.md), and
[configuration reference](configuration.md). Redact credentials before sharing logs;
never attach `secrets.yaml` or a complete device configuration backup to an issue.
