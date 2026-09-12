# Private board bench images

This is a hardware-discovery exception for R-HW-04, R-NET-02 and the board-image
plan. It builds writable Armbian or Raspberry Pi OS images; Radxa targets also
offer the explicit protected-storage prototype described below. It does not implement
or qualify the final owner/recovery design. Do not publish this image or its
access files as a release.

Build the application and complete Linux ARM64 payload using the installer
instructions, then run from the repository root:

```sh
./installer/make-payload.sh --arch linux-arm64 --only seekerhd
node image/bench/build.mjs --target radxa-zero3w --output image/out/zero3w-bench-01
node image/bench/build.mjs --target radxa-rock5c --output image/out/rock5c-bench-01
node image/bench/build.mjs --target rpi --output image/out/rpi-bench-01
```

The Pi backend preserves its FAT boot partition and MBR identifiers and excludes
Rockchip payloads. Its writable private-test mode is documented in [image/pi](../pi/README.md).
For the separate Radxa storage experiment:

```sh
node image/bench/build.mjs --target radxa-zero3w --storage-prototype --output image/out/zero3w-storage-candidate
node image/bench/build.mjs --target radxa-rock5c --storage-prototype --output image/out/rock5c-storage-candidate
```

That mode fixes system/state/log sizes and grows the final media filesystem to
the SD card on first boot. Read the [prototype limits](../prototype/README.md);
hardware evidence for one target does not qualify another.

For compatibility with the original ROCK 5C builder, omitting `--target` still
selects `radxa-rock5c`.

The output directory must be new. Linux Docker with ARM64 execution and loop/mount
support is required. The builder copies the pinned base into a private container;
it does not accept a physical disk target. It preserves the bootloader region and
root partition identity and filesystem UUID, grows the image to 8 GiB, and checks
the target partition table and filesystems before compression. ZERO 3W uses the normal explicit image target;
ROCK 5C additionally uses its private `--hardware-test` installer gate.
Package versions are recorded, but Debian package repositories are not snapshot
pinned: this bench build is not a claim of bit-for-bit reproducibility.

The output contains an image, SHA256SUMS, manifest, package inventory and private
access instructions. The temporary Linux password and SSH private key belong to
this image only. The account is `yonder-bench`; password and key login are enabled,
sudo requires its password, and remote root login is disabled. The console still
uses its normal first-administrator-password setup. New SSH host keys and machine
identity are created on the board at first boot.

## First physical test

1. Verify SHA256SUMS, then flash the image to an SD card of at least 16 GB.
2. Leave the camera and flight controller disconnected. Power the selected board.
3. Join Wi-Fi `yonder`, password `yonder1234`, then open
   `http://192.168.77.1:3000` and set the console administrator password.
4. Use PRIVATE-ACCESS.txt for SSH access over that same Wi-Fi network. Ethernet
   is not a prerequisite. Confirm the console and SSH both work before changing
   network settings.
5. Collect initial facts with the commands below. Physical boot, AP operation,
   UART and hardware encoding remain pending until measured on the board.

```sh
uname -a
nmcli device status
systemctl --no-pager --full status yonder-core yonder-console ssh
ls -l /dev/ttyS* /dev/ttyFIQ* /dev/mpp_service /dev/dri 2>/dev/null
sudo gst-inspect-1.0 mpph265enc
```

After confirming the encoder element exists, the following bounded test encodes
150 generated frames in memory. It does not open a camera or send any aircraft
commands. Successful completion proves this encoder path accepts a generated
1080p stream; it does not prove camera capture, latency or sustained performance.

```sh
sudo gst-launch-1.0 -e videotestsrc num-buffers=150 ! \
  video/x-raw,format=NV12,width=1920,height=1080,framerate=30/1 ! \
  mpph265enc ! h265parse ! fakesink sync=false
```

On ZERO 3W, the existing target preparation frees UART2 as `/dev/ttyS2`; see
`docs/hardware/an-autopilot-on-the-uart.md` for its tested pinout. The helper does
not itself provision camera drivers: installer role 53 installs the SeekerHD
IMX462/ISP21 stack, and the builder verifies it in the assembled filesystem.
The ZERO 3W build requires `vendor/seekerhd`; omission fails assembly. Camera
capture still needs physical validation against the produced candidate.
On ROCK 5C, UART2 remains the recovery console
at 1,500,000 baud, 8N1, while UART4_M2 remains the separate telemetry candidate
pending board validation. These are 3.3 V UART signals.

## ROCK 5C camera dependency

The SeekerHD's existing cable is not a direct fit: ROCK 5C has a 31-contact,
0.3 mm CSI connector; SeekerHD uses 22 contacts at 0.5 mm. Radxa AC020 is a
physically relevant adapter candidate, but its complete pin mapping and camera
control-voltage compatibility must be checked before connecting power. Do not
connect the existing cable by improvising its alignment.

The existing ZERO 3W IMX462 and ISP21 work is reference material. ROCK 5C needs a
board-specific camera graph and ISP3-compatible processing. This bench image
does not activate an IMX462 overlay or camera service.

Sources: [ROCK 5C interfaces](https://docs.radxa.com/en/rock5/rock5c/hardware-design/hardware-interface),
[Radxa AC020](https://radxa.com/products/accessories/fpc-adapter-cable-ac020/),
[SeekerHD](https://www.divimath.com/products/divimath-seekerhd-camera).

## ZERO 3W storage boot checkpoint

After rebuilding all first-party packages, standalone ARM64 core dependencies
and the complete ARM64 payload, use a new output directory:

```sh
node image/bench/build.mjs --target radxa-zero3w --storage-prototype \
  --output image/out/zero3w-storage-NEXT
```

This explicit option is rejected for other boards. Read the
[prototype contract and remaining gates](../prototype/README.md) before testing.
It retains a private `source-snapshot.tar`, installed application file hashes,
layout/UUID report and image checksum. The snapshot includes build inputs and
compiled packages; the lead must refresh them before assembly. Source matching
alone does not prove an old compiled file was rebuilt. Full package-input
locking and the release workflow remain unfinished.
