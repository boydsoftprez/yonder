# Mule USB cleanup and warm reboot repair

Requirements: R-DIA-08, R-CAM-05, R-STO-04, R-STO-07 and R-FLT-27.

The Mule runs a private ZERO 3W bench image with protected system storage,
persistent configuration, and a separate p5 terrain filesystem. Its application
upgrade uses the consolidated branch containing main `5c783e9` and the September
camera/cockpit fixes. The update is installed; physical qualification is pending
the first boot of the replacement kernel.

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
This supports retaining the installed headers, external IMX462/AIC8800 modules,
DTBs and camera overlays. The rebuilt Image SHA-256 is
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
The generated ARM64 initramfs passed the privileged, isolated loop-device tests,
including exact p1–p5 admission, p6 rejection, UUID-bound terrain mounting and
read-only fallback. Its SHA-256 is
`1daa85540e590f929e48610a5d83553fe34e617461166586e187d6fb32bc29b4`.
The U-Boot wrapper uses the original board's ARM64/gzip flags; both header and
payload CRCs were verified. Physical reboot qualification is pending.

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

## Installed state and first reboot

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
There is no verified replacement-kernel boot, camera result or successful warm
reboot yet; those checks remain required before calling the hardware repaired.
