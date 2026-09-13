# Mule USB cleanup and warm reboot repair

Requirements: R-DIA-08, R-CAM-05, R-STO-04, R-STO-07 and R-FLT-27.

The Mule runs a private ZERO 3W bench image with protected system storage,
persistent configuration, and a separate p5 terrain filesystem. Its application
upgrade uses the consolidated branch containing main `5c783e9` and the September
camera/cockpit fixes. The repaired kernel has booted on the Mule. Both CSI and DJI
deliver decoded frames, and ZeroTier recovered with its original identity.
Ordinary warm-reboot qualification remains incomplete.

## Kernel diagnosis and build

The installed Armbian 26.8.1 package identifies Linux source `5280f9b` and driver
hash `073a1336_ceaab8e6`. The matching driver/patch recipe is Armbian `d28c4c8`,
which differs from the build revision recorded in the image release file.

The captured fault during FunctionFS teardown reaches `gadgets_drop` through
`device_destroy`, `class_find_device` and `kernfs_remove_by_name_ns`. This vendor
function calls `config_item_put(item)` before `android_device_destroy(gi)`, using
the gadget after the put can free it. Each Android root also uses device number
0:0, so removing a root by device number can remove a different root. The repair
unregisters the exact device, joins notification work before releasing the gadget,
and protects the exported function-device parent across multiple roots.

The [pinned repair and build recipe](../../image/kernel/rk35xx-usb-lifetime/README.md)
retains the installed configuration and kernel release. Independent source review
caught and corrected a proposed lock inversion and the shared-device-number
lookup; the revised patch has no remaining review findings.

`make -j6 Image modules` passed with the installed configuration unchanged.
All 19,567 exported symbols have identical CRCs; none were added or removed.
The installed headers, external IMX462/AIC8800 modules, DTBs and camera overlays
are retained. Identical CRCs do not establish split-BTF compatibility: the first
replacement-kernel boot rejected the old IPv6, HIDP and RFCOMM modules.
Installing all 2,300 matching in-tree modules fixed those load failures; five
external module files were preserved. The build recipe now packages matching
modules, checks their BTF sections and emits a manifest. The rebuilt Image SHA-256 is
`e22f69c3a205c4c1bbf0037930eb2cb0bfd9f363b4f81542776200e2f193ab28`.
Its build identifier is `yonder@mule-usb-lifetime-fix`, dated
`2026-09-13 02:09:01 UTC`, with release `6.1.115-vendor-rk35xx`.

## Existing storage compatibility

The newer administration helper needs the initramfs storage-mode handoff.
The Mule's old mount script lacks it; the newer four-partition script would
reject its retained fifth partition before starting services. The compatibility
change admits p1–p5 only for an explicitly identified legacy ZERO 3W bench card,
resolves partitions beneath the actual root disk, and verifies filesystem UUIDs.
Terrain failure gets a bounded read-only empty mount. It never grows p4 over p5.
Production four-partition admission remains unchanged.

The expanded generated-initramfs verifier covers extra partitions, a missing bench
marker, malformed terrain identity, successful p5 mounting without growth, and
read-only fallback after a terrain UUID mismatch. Shell syntax/ShellCheck and the
six image build tests passed. The static maintenance-token tests passed.
The first archive passed isolated mount tests but lost its storage-mode marker
at the actual initramfs-to-root handoff. initramfs-tools moves its own /run onto
the root after init-bottom, covering a second root-side /run. The fix writes the
observed marker into the existing initramfs /run. The verifier now executes that
exact move. An injected pre-move failure also verifies owned-loop cleanup.

The regenerated archive contains matching kernel modules and passed the actual
archive tests without a source overlay, including p1-p5 admission, p6 rejection,
UUID-bound terrain mounting, read-only fallback and the /run handoff. Its SHA-256 is
`84aeefb1507823572c842135b20c4a5d10eda5c260674175ff5b7535c054d9db`.
The U-Boot wrapper uses the original board's ARM64/gzip flags; both header and
payload CRCs were verified. Its SHA-256 is
`7d452eefc01ff88cec4baa0d7a3858089615a213f43182c7cd025522a93d77dd`.

## Deployment boundaries

Application installation uses the shared core and console roles in a private
mount namespace, with an isolated application tree and persistent console seed.
The existing ARM64 Node runtime and device configuration are retained. Incomplete
staged dependencies were rejected before replacing running services and corrected.
Boot files and the original application remain available for rollback.
All 901 staged first-party application files match the consolidated source build.

The original kernel faulted again during preparation, before any new boot image
was selected. The stack again reached `gadgets_drop` through configfs removal;
kernel taint changed to 4736, including the Oops bit. This is evidence from the
old kernel, not a failed test of the replacement.

The old helper must not execute its Python cleanup during initial activation:
that would hit the old kernel before the repair can boot. A one-time procedure
freezes the identified helper before terminating the old core group, avoiding an
EOF race into cleanup. Ordinary FunctionFS teardown and normal warm reboots must
then pass on the replacement kernel; that activation procedure is not a permanent
service behavior change.

## Initial activation and cold boot

The installed application matches all 901 first-party files from `2b4ff75`.
The kernel/storage repair is retained in branch commit `069f0a0`. Boot now selects
the verified Image and initramfs under the `6.1.115-vendor-rk35xx-yonder-usb1`
filenames. Original boot files, application tree and console seed are retained.
Nine protected configuration, credential, identity, boot-argument and camera-IQ
files remained byte-identical during activation.

All old core/helper tasks were confirmed stopped before the one-time SIGKILL
stop. Application and persistent console directories were exchanged atomically.
The console's tmpfs overmount initially blocked its directory exchange with
`EBUSY`; removing that overmount in the private activation namespace allowed the
persistent seed exchange. The runtime SIGKILL override was removed and the normal
SIGTERM policy restored before reboot. PID 1's root mount remained read-only.

An ordinary `systemctl reboot --no-block` request was accepted, and SSH closed.
The Mule did not return during the initial observation window. A physical power
cycle was requested to load the replacement from the already-faulted old kernel.
The subsequent cold boot loaded the replacement kernel, with boot ID
`6f6ab25d-d6fb-4fa0-89ab-6d0dea9914a5`. It joined local Wi-Fi at 192.168.68.72.
The missing /run marker and native ZeroTier ownership check blocked admin
startup, explaining the absent mesh address. The board itself had booted.

## Startup recovery on the replacement kernel

The installed ZeroTier 1.16.2 daemon owns its live identity and membership files
as its fixed non-login service account. The new recovery adapter incorrectly
required root ownership. It now accepts the verified native account for live
state while retaining helper-owned scratch, strict file types/modes, and existing
identity validation. The pinned real ZeroTier package passed the Linux fixture
covering native ownership, activation rollback and interrupted recovery.
All 17 adapter unit tests and the core build passed.

The normal admin service captured the existing identity and restored ZeroTier
without rejoining or regenerating it. The console returned on 10.113.83.24.
Nine protected file hashes still matched. The diagnostic startup override was
removed. Normal core shutdown/startup completed with kernel taint unchanged at
4096 (external modules only), without an Oops.

Source commit `e82a231` records the startup fixes and matching-module packaging.
The deployed application retains the consolidated `2b4ff75` build plus its rebuilt
ZeroTier adapter. Boot selects the repaired usb1 Image and usb2 initramfs.
Both CSI and DJI passed a local GStreamer read/decode test through their actual
MediaMTX preview paths, reaching EOS after 16 decoded buffers. The camera API
reports `mppvideodec` hardware H.264 decoding and zero pipeline restarts.
Early frame probes returned 404 before the publishers became ready; the bounded
retry test verified actual frames once publication began.

An ordinary warm reboot was then requested from the repaired kernel. SSH closed,
but neither known address returned during the first observation window. The
kernel cleanup repair and working cameras do not yet establish reliable reboot.

## Recovery after the failed warm reboot

The operator power-cycled the Mule again, producing boot ID
`a8cf8c78-8280-4032-ad3d-b446b582fd93`. The usb2 initramfs now supplied the observed
protected-mode marker through exactly one /run mount. Core, admin, console,
ZeroTier, CSI preparation, AIQ and MediaMTX started successfully, with no failed
systemd units. ZeroTier was ONLINE at the original address and the console
returned HTTP 200. All nine protected file hashes still matched.

The retained log from the preceding boot shows FunctionFS cleanup and core
shutdown completing without the earlier Oops. Systemd reached reboot.target;
systemd-shutdown synced filesystems and terminated journald. No intervening boot
is recorded before the physical recovery cycle. This narrows the unknown failure
to the period after persistent logging ends; it does not distinguish late kernel
shutdown, reset firmware, or early boot.

Ramoops is enabled, but its storage is reserved DRAM. The physical power cycle
can erase it, so empty pstore is not evidence that the reset path succeeded.
Neither an HDMI monitor nor a USB serial adapter was available. An external boot
console or another reliable way to retain late reset evidence remains necessary
to distinguish those stages without speculative changes.

CSI passed a decoded-frame check on this boot. DJI initially had no fresh video
and its USB connection remained at the initial phone stage. One normal core
service restart completed without a kernel fault, after which the accessory
connection negotiated successfully. The operator clarified that DJI had powered
down: its missing video is not evidence of a software startup regression, and
its return cannot be attributed solely to the service restart. Both cameras then
passed the 16-buffer decode check with zero pipeline restarts and kernel taint
unchanged at 4096. No further board reboot was issued during this recovery.

## ZeroTier startup regression after a later deployment

The September 13 afternoon boot (`1bfd4538-df5d-493e-8668-a21b114d064b`)
joined Wi-Fi at 192.168.68.72 and acquired a cellular address, but ZeroTier
remained stopped. The protected-mode marker was present. The admin helper
repeatedly failed initialization, reaching 59 restarts before repair.

The installed `dist/recovery/zerotier.js` no longer contained the native-account
ownership fix from `e82a231`. Its SHA-256 was
`5b58c746e0263ceeeeacd94a068ce475b084969a33d2736f0aae1babdb389c66`.
A direct read-only adapter check reproduced `ZEROTIER_STATE_INVALID` at
`privateFile`, rejecting the unchanged identity owned by `zerotier-one` UID 995.
The specific later deployment that replaced this module was not established.

The unchanged corrected source was compiled into an isolated output directory;
compilation and its 17 adapter tests passed. Only the deployed adapter module
was replaced, with SHA-256
`6b7ecbf9d7d3bf2b0b3a5dc3831998ee311b8c7e2886368af54da9b4c63023c0`.
The prior module and verification records are retained on the Mule under
`/var/lib/yonder-state/backups/zerotier-owner-20260913-1618`.
The write used a private mount namespace; PID 1's root remained read-only.

The admin socket/service were stopped for replacement. Because the core requires
that socket, systemd also stopped the core; it was explicitly started again
after admin recovery. Final checks showed admin, core, console and ZeroTier
active, no failed units, and zero admin restarts since activation. The same
read-only adapter check now passed with one membership. ZeroTier reported ONLINE,
its network reported OK at the original 10.113.83.24 address, and SSH and console
HTTP 200 succeeded over the mesh from the Mac.

Configuration, secrets, both mesh identity files, the installed Pocket guard,
camera IQ data, boot arguments and the checked SSH host key retained their
pre-repair hashes. Kernel taint remained 4096. This repair did not reboot the
board or qualify the unresolved warm-reset path. Subsequent full application
deployments must include `e82a231` in their actual built adapter, rather than
overwriting it with an older artifact.

The PR audit found the fix in PR #16, but absent from the then-current heads of
its dependent PRs #17 (`385651c`) and #18 (`f72a029`). A PR base relationship
does not update the dependent branch's build inputs. Before deploying a stacked
branch, merge the updated base into that branch, rebuild the application, and
run the inherited ZeroTier ownership/recovery tests. The installer consumes a
prebuilt application, so copying an older application tree can reintroduce this
failure even when the corrected source exists on another branch.
