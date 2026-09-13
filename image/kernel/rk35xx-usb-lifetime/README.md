# RK35xx USB gadget lifetime repair

Requirements: R-DIA-08, R-VID-03 and R-STO-04.

The Mule's vendor 6.1.115 kernel releases the configfs gadget before removing
its Android USB notification device. Removing a FunctionFS gadget can therefore
use freed memory in `gadgets_drop`, leave the kernel faulted and prevent a warm
reboot. Notification work also needs to finish before the gadget is freed.
Every Android root uses device number 0:0, so teardown must unregister the exact
device pointer rather than finding the first matching device number.

`configfs-lifetime.patch` repairs that lifetime, serializes notification scheduling
against teardown, and maintains the parent used by exported function devices
when multiple gadget roots exist. It preserves FunctionFS and USB state events.
Independent source review covered lock ordering, work cancellation, exact device
removal, registration rollback and the two-root accessory configuration.
Compilation and hardware results are recorded separately in deployment evidence.

## Pinned build

The installed package's control metadata, rather than just `/etc/armbian-release`,
identifies these inputs:

- [Linux source 5280f9b](https://github.com/armbian/linux-rockchip/tree/5280f9b4336199c4025c8eed894d2b4e2268dcc6), version 6.1.115.
- [Armbian recipe d28c4c8](https://github.com/armbian/build/tree/d28c4c8ec9aa8ba5f272a5c8cc8b98b683cdecd4).
- Driver hash `073a1336_ceaab8e6`, kernel patch hash `fe894a5445242afd`, and upstream configuration hash `e24ec8afe5d61715`.
- `kernel.config` is the installed kernel's expanded configuration, SHA-256 `8b5661999dbc4b7a1087f1d9c6b335ab6228360ee901da922e71de191f994f99`.

Use a Linux ARM64 Debian Trixie builder with GCC 14.2.0, binutils 2.44 and pahole
1.30. Packages include `build-essential gcc-aarch64-linux-gnu git ca-certificates
bc bison flex libssl-dev libelf-dev cpio rsync kmod xz-utils dwarves`.
Allow at least 8 GiB RAM and substantial build space. The command requires a new
work directory, fetches pinned commits and refuses a changed configuration:

```sh
image/kernel/rk35xx-usb-lifetime/build.sh /work/yonder-usb-kernel
```

`YONDER_KERNEL_JOBS` defaults to 6. Output includes Image, System.map,
Module.symvers, configuration, hashes, and a verified
`kernel-modules-6.1.115-vendor-rk35xx.tar.gz`. The module archive contains only
matching in-tree modules and their `modules.order`/built-in metadata. It is made
with `INSTALL_MOD_STRIP=1`, retains `.BTF`, and excludes the builder-only `build`
and `source` links. Its adjacent manifest and metadata record every payload hash,
the linked kernel inputs, the in-tree module count, and BTF checks for IPv6, HIDP,
and RFCOMM. This command does not install or reboot.

It retains `6.1.115-vendor-rk35xx`; compare every exported symbol CRC against the
installed kernel before considering external modules compatible. Matching
`Module.symvers` alone does **not** permit retaining old in-tree modules when the
replacement kernel's split BTF changed: their BTF references the old `vmlinux`.
Deploy the matching kernel and this complete in-tree module payload together, then
regenerate the initrd. Preserve DTBs, overlays, camera tuning and boot arguments.
External DKMS modules, including camera and Wi-Fi modules, are deliberately not in
the archive: preserve or rebuild them separately against the replacement kernel
and validate the complete replacement before activation.

A rebuild is not physical qualification. Retain original boot files and a rollback
path; verify normal FunctionFS teardown, CSI/DJI pictures, and repeated warm reboot
with fresh boot IDs and no kernel faults. A faulted old kernel may require one
physical power cycle to activate the replacement. Include this repair in a retained
kernel input before claiming a newly assembled image contains it; the stock Armbian
base alone does not contain the repair.
