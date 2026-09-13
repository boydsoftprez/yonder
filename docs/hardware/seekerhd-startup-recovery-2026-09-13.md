# SeekerHD startup recovery on Radxa ZERO 3

Requirements: R-CAM-01, R-CAM-22, R-HW-04.

## Failure observed on the bench

With Armbian 26.8.1 and `6.1.115-vendor-rk35xx`, the initial CSI DPHY probe
completed at 9.359502 seconds. RKISP discarded an unready sensor link at
9.792846 seconds. The IMX462 module began probing at 9.816251 seconds, after
that connection was gone. The existing modules-load configuration and service
ordering were present.

The camera preparation service then tried to unbind/rebind the ISP and DPHY.
At 16.894803 seconds that operation caused a kernel Oops in
`asd_equal → v4l2_async_nf_asd_valid → __v4l2_async_nf_add_fwnode_remote →
rockchip_csi2_dphy_probe → bind_store`. Preparation exited with signal 11,
RKAIQ could not start, and no video devices remained. The same fallback had
succeeded on a previous boot; it was not a safe recovery mechanism.

## Correction

Preserve RKISP's pending sensor connection by adding
`initcall_blacklist=rkisp_clr_unready_dev` to the existing Armbian `extraargs`.
The installer preserves other arguments and blacklist entries. Its target
kernel must support the named callback and KALLSYMS.

The pinned [Rockchip driver](https://github.com/rockchip-linux/kernel/blob/77168c8d5ab82399f65a80e9f807b50ba37cf483/drivers/media/platform/rockchip/isp/dev.c)
registers that cleanup as `late_initcall_sync`. The kernel's
[initialization code](https://github.com/rockchip-linux/kernel/blob/77168c8d5ab82399f65a80e9f807b50ba37cf483/init/main.c)
supports skipping an individual named initcall. The bench kernel exposes that
exact symbol and has `CONFIG_KALLSYMS=y`.

Preparation now refuses a missing media graph without detaching either driver.
An absent camera still affects only camera availability. Core's dependency on
camera preparation remains optional. Sensor timing and image controls are
unchanged.

## Verification

The regression test reproduced all four unsafe driver-binding writes on the
old preparation code. The corrected preparation passes the test without any
sysfs write or attempt to open a video device when the graph is absent.

Hardware acceptance is pending the corrected reboot: confirm the command line,
normal sensor registration and notifier completion, stable capture device,
RKAIQ readiness, advancing decoded frames, and sustained pipeline operation.

The bench deployment replaced only `prepare.py` and added the boot argument.
Original files were backed up, replacements were read back by hash, and root
was returned to read-only. The saved configuration, camera service units,
DJI decoder runtime, vehicle runtime and terrain runtime retained their hashes.
The seven preparation tests also passed on the board before installation.

A software reboot was requested after verifying the vehicle was disarmed and
idle and synchronizing storage. Because the current kernel had already faulted,
the reboot skipped userspace service teardown to avoid the separately observed
USB gadget cleanup Oops. The board did not return over either known network
path; a physical power cycle is required before hardware acceptance can finish.
This shutdown result does not establish whether the corrected startup works.
