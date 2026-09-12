# ZERO 3W bench first-boot investigation

The first private ZERO 3W image reached Linux on the physical board, but the user
reported no `yonder` SSID after about ten minutes with a slowly blinking green
LED. AP operation, console access and bench SSH remain unverified.

Candidate: `yonder-zero3w-2026.9.0-bench.img.xz`, SHA-256
`b13e4c3e426a879524d287143a5a32c5470e10a5911a7ecc15f7b252dfc6feaf`.
This is an ordinary writable bench image, not the final protected-storage design.

## Evidence recovered from the card

After the user returned the SD card to its reader, macOS Disk Utility successfully
created a read-only image. Investigation used that captured file; the physical
card was not repaired, reformatted or rewritten. ext4 journal recovery was run
only on a separate working copy of its root partition.

- The expected 8 GiB image partition and root UUID are present.
- The journal identifies the ZERO 3 board and vendor 6.1.115 kernel. Linux mounted
  root with ordered data mode and reached systemd's basic target.
- Kernel randomness initialization completed. The AIC Wi-Fi driver loaded its
  firmware and registered a wireless PHY.
- The machine identity was created. The bench first-boot unit started at about
  12.6 seconds, but its completion marker and completed SSH host keys are absent
  from the recovered filesystem. A temporary RSA-key file exists.
- Yonder secrets and NetworkManager persistent state are absent. The saved
  journal contains no completed NetworkManager or Yonder startup.
- The journal stops at about 13.4 seconds. Wall-clock dates are stale because the
  board had not synchronized its clock; use monotonic boot offsets for this trace.

## Confirmed logging defect

The helper masked `armbian-ramlog.service` but left
`/etc/default/armbian-ramlog` with `ENABLED=true` and left
`/etc/cron.d/armbian-truncate-logs` active. The journal records the latter's
`@reboot` invocation just before logging stops. Its script calls
`journalctl --relinquish-var`, switching the journal into volatile storage even
with the bench's `Storage=persistent` drop-in. Those later logs are unavailable
after power removal.

The bench preparation must disable Armbian's RAM-log setting and retire its log
truncation cron job while retaining RAM swap. This is a diagnostic persistence
fix; it is not evidence that the missing AP is fixed. Another physical boot with
retained logs, or a live local console, is needed to establish the AP failure.

Requirements: R-NET-02, R-HW-04 and the logging/storage work in the
[board-image plan](../superpowers/plans/2026-09-10-board-images-and-recovery.md).

The helper now sets `ENABLED=false`, retires known Armbian log-truncation cron
jobs, and rejects remaining active invocations. A disposable ARM64 fixture
reproduced the missing configuration before the fix and passed afterward,
including checks that zram swap settings are preserved. Shellcheck and the three
builder target tests pass. This source fix has not yet been rebuilt or flashed;
the card and candidate named above still contain the original behavior.

## Corrected bench candidate

On 11 September, `zero3w-bench-02` was rebuilt with the logging correction.
The finished filesystem was inspected directly: RAM logging is disabled, the
truncation cron job is retired, zram remains enabled and machine identity is
empty. Mounted installer/SSH-policy checks, GPT and offline ext4 checks passed.
The compressed checksum and full XZ expansion independently match the 8 GiB raw
image supplied to Armbian Imager.

- Compressed SHA-256: `0ad65a4fb5846ec7bfe0e441a73bf26982ba0d777b9dfe48126007549602b6e6`
- Raw SHA-256: `a12d899b62f90bd69d3aa418b4db5ff3ec20dc9f193413dfce629bc6706c2f5b`

Physical AP behavior remains pending another boot.

## Second physical attempt

The user reported no SSID after testing bench02 and confirmed a complete power
disconnection/reconnection around card insertion. A second read-only Disk Utility
capture found no journal, an empty machine ID, unchanged build-time mount metadata,
and no first-boot marker. Comparing every sector of the root partition against the
raw bench02 image found no difference: this attempt left no Linux-root writes.

The whole-device comparison is not a valid bootloader readback check: Disk Utility
represents the unpartitioned pre-root area as Apple_Free and the converted capture
contains zeros there, including the Rockchip bootloader region. Preserve that
limitation; do not diagnose damaged bootloader bytes from this capture. A micro-HDMI
console or suitable serial capture is the next diagnostic boundary. No second-card
repair or reflash was performed during inspection.

## Raw readback access recovered

The earlier 6 September card-repair session documented the same failure of
administrator-launched direct opens. It successfully used macOS `authopen
-stdoutpipe -o 0` to obtain an authorization-approved read-only descriptor, then
read through that descriptor instead of reopening the device pathname.

Reusing that documented method on 11 September succeeded without changing privacy
settings. The physical card's first 16 MiB, including the Rockchip bootloader gap,
matches the bench02 source image byte-for-byte. Together with the root-partition
comparison above, this verifies the bootloader and Linux payload were written
correctly. It does not establish why the reported second cold boot left no
filesystem writes. Disk Utility's capture limitation no longer blocks this check.

## Successful bench02 boot and LAN onboarding

On 11 September, after another cold boot, the operator reported connecting through
the Yonder AP/console and configuring the home Wi-Fi network. Live SSH using the
bench02 key confirmed a Radxa ZERO 3 and the private `radxa-zero3w` image marker.
The first-boot completion marker exists. Yonder core, console, NetworkManager and
SSH are active, no systemd units are failed, and the console returns HTTP 200.
The Wi-Fi interface is connected; Ethernet is disconnected.

Persistent journal files contain current-boot entries more than eight minutes
after startup, past the earlier 13-second cutoff. Journal usage is 16.7 MB; the
active configuration specifies persistent storage, a 64 MB limit and a 10-second
sync interval. Armbian RAM logging is disabled and its truncation cron job is
retired. SSH effective policy permits password and public-key authentication and
disables root login; key login and password-required sudo were exercised.

The root filesystem remains writable ext4: 7.8 GiB total, 3.3 GiB used and
4.5 GiB available. UART device nodes ttyS1 and ttyS2 exist; pin-level operation
is not tested. This successful boot/onboarding does not establish power-cut
resilience, camera functionality or why the preceding attempt left no writes.

A remaining hostname issue was observed: `/etc/hostname` is `yonder`, but the
loopback aliases in `/etc/hosts` still name `radxa-zero3`. Sudo succeeds with a
host-resolution warning. Separately, `yonder.local` resolves to another board on
the test LAN; direct-IP access was used to avoid confusing the devices. Hostname
consistency and multi-board discovery require follow-up.

## SeekerHD provisioning correction and reboot

The camera stack was installed onto the running bench02 board using the new
installer role 53 and the freshly built, pinned ARM64 ISP payload. Installation
verified the DKMS module for `6.1.115-vendor-rk35xx`, composed camera/UART/base
DTBs, profile checksums, runtime dependencies and enabled services. It staged
activation for reboot and did not replace a running sensor driver. Existing
Yonder configuration was left in place.

After reboot, the IMX462 bound at I2C2 address 0x1a, the media graph and video
nodes appeared, both SeekerHD services were active and no systemd units failed.
Yonder's own `GET /cameras` returned the stable CSI path
`platform-rkisp-vir0-video-index0`, with NV12 candidates at 1920×1080, 1280×720
and 640×360, all at 30 fps. The camera was discovered but not automatically added
to the operator's configuration.

A bounded pipeline captured 90 frames from the actual CSI camera at 1920×1080,
encoded them with `mpph265enc`, parsed the H.265 and discarded the output. It
reached EOS successfully and all four camera/core/console services remained
active. This proves capture-to-encoder operation; it is not an off-board decoder,
latency, sustained-rate or image-quality measurement. No images were saved.

This is a live retrofit of bench02, not a fresh-card boot of bench03. The next
image build separately verifies the camera stack inside its assembled rootfs.

## Final-source camera candidate: bench04

`zero3w-bench-04` was assembled after the independent review corrections,
including explicit ISP runtime dependencies and DKMS interrupted-install retry
handling. The builder completed successfully and cleaned its private container.
The assembled-root camera verifier, GPT checks and offline ext4 check passed.
Independent host verification matched both the manifest and SHA256SUMS, then
fully decompressed the XZ stream to exactly 8589934592 bytes.

- Compressed size: 1191361272 bytes.
- Compressed SHA-256: `473e1667938c448b1fef34d8ac3cca37f4e820785ccacd0258bb3a304563387e`.
- Raw SHA-256: `8480e322f202867c5b309f361508e619e75161be5b2092c5ed91f96a90fc3975`.
- Source archive SHA-256: `76243865b6dce134aa3c0c619e0bcdb5296c79a66cf17018133c4142ca2af227`.

Bench04 supersedes bench03 for the next flash. The current board remains the
successful bench02 camera retrofit; bench04 has not been flashed and cold-boot
qualified. These installer and CI changes remain local pending commit/merge;
no GitHub image release has been published.

## Pocket 2 hardware decode follow-up

The same bench02 retrofit subsequently enumerated the Pocket 2 through
`fcc00000.usb` at USB high speed and identified DJI model HG211. The operator
confirmed a visible preview but reported roughly four seconds of movement-to-
display delay. This is operator-observed latency, not an instrumented measurement.

Investigation found the accessory pipeline hardcoded `avdec_h264` even when the
board offered hardware decoding (R-HW-07, R-CAM-13). Native framed input delivered
364 access units in roughly twelve seconds. Bounded live decoder-to-fakesink
checks measured approximately 27.85 fps with software decoding and 30.09 fps
with `mppvideodec`; these are throughput checks, not exposure-to-display timing.
The original preview repeatedly exited with accessory stream EOF. Its media
server disconnects consumers whose queued data exceeds its bounded backlog.

The source now independently probes `mppvideodec` and selects it for accessory
H.264 input when present, preserving software fallback and the existing CSI and
USB-camera paths. Both main and preview outputs retain hardware H.265 encoding.
A twenty-second hardware decode/two-encoder discard test stayed running. The
focused probe/composition suite passed 84 tests and the core build passed.

The decoder update was installed on the running bench02 retrofit. It is **not
contained in the already-built bench04 archive**; the next image must be rebuilt
from the updated source. End-to-end latency after the change still requires
operator observation or a clock-in-frame measurement. GPIO/USB simultaneous
power is not electrically qualified by successful USB/video operation.

After the live update, the operator reported the delay was **much shorter**.
The actual preview pipeline remained on the same process for 99 seconds with
zero supervisor restarts, using `mppvideodec` and H.265 for both outputs. Core,
console and both SeekerHD services remained active. An additional 38 media,
feeder and supervisor regression tests passed. This confirms an observed
improvement and bounded stability, without assigning an unmeasured latency.

## Stable adaptive-preview status layout

The operator observed the video moving vertically whenever the transient
adaptive-bitrate reason appeared or cleared. `YonderPicture` now opts into a
persistent two-line status slot in `YonderStateOverlay` (R-VID-18). Long reasons
remain scrollable, including by keyboard, and clearing the reason removes its
text and tab stop while retaining the slot. Other overlay placements preserve
their existing layout.

The picture component suite passed 116 tests. The production-component browser
fixture in `scripts/camera-message-layout-check.mjs` measured unchanged video
position and height through empty, short, wrapped and cleared messages at 1440,
768 and 390 pixels in both generated palettes. These fixture checks exercise
layout, not the real radio. The widget build passed. The updated picture and
cockpit bundles were installed on the live ZERO 3W with matching SHA-256 hashes;
core and console were active after the console restart. A browser refresh is
needed to replace already-loaded bundles. The existing bench04 image archive
still predates these follow-up changes.

The full page suite completed with 214 passes and four expected camera-pair
geometry changes. All four captures and their JSON deltas were reviewed: the
fixed status slot changes the settled toolbar height without hiding controls.
Only those four macOS reference files were updated. The supported focused pair
rerun then passed 99 checks with zero failures; no runtime code changed between
these runs. The shared overlay's five existing tests also passed. Linux geometry
references have not been regenerated on this macOS host.
