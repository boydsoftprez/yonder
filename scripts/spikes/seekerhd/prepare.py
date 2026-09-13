#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""R-CAM-01: prepare the measured SeekerHD mode before Yonder starts."""
import re
import subprocess
import fcntl
import os
import struct
import errno
from pathlib import Path


def run(*args):
    return subprocess.check_output(args, text=True, timeout=20)


def sensor_capture_mode(fd):
    # Pinned vendor 6.1 rkmodule_hdr_cfg ABI: 16 bytes mode/packing and
    # 324 bytes compression description. The legacy bring-up driver has
    # no GET_HDR_CFG; ENOTTY means its existing linear-only behavior.
    data = bytearray(340)
    try:
        fcntl.ioctl(fd, 0x815456c4, data, True)  # RKMODULE_GET_HDR_CFG
    except OSError as error:
        if error.errno == errno.ENOTTY:
            return 0
        raise
    mode = struct.unpack_from('I', data)[0]
    if mode not in (0, 5):
        raise RuntimeError(f'Unsupported sensor capture mode {mode}')
    return mode


def bound_sensor_device(driver=Path('/sys/bus/i2c/drivers/imx462')):
    """Return the bound IMX462 I2C device, or None if no sensor answered."""
    if not driver.is_dir():
        return None
    for device in sorted(driver.glob('*-001a')):
        if device.is_symlink():
            # The I2C device can bind before its media node is available.
            # Check the media graph separately without detaching drivers.
            return str(device)
    return None


def main():
    compatible = Path('/proc/device-tree/compatible').read_bytes().split(b'\0')
    if not any(c == b'radxa,zero3' or c.startswith(b'radxa,zero3-') for c in compatible):
        raise SystemExit('This camera preparation is only for Radxa Zero 3')
    run('modprobe', 'imx462_yonder')
    bound_sensor = bound_sensor_device()
    if bound_sensor is None:
        # The overlay creates an I2C client even with the camera unplugged.
        # Camera absence must cost only the camera.
        print('SeekerHD IMX462 is not bound; leaving the ISP graph untouched')
        return
    graph = run('media-ctl', '-d', 'platform:rkisp-vir0', '-p')
    if 'subtype Sensor' not in graph:
        # Vendor remove paths retain async-notifier references. Rebinding
        # can Oops the kernel even when the sensor is present. Preserve the
        # notifier at boot instead, so the module can register normally.
        raise SystemExit(
            'SeekerHD sensor is missing from the media graph; leaving drivers attached. '
            'Check the camera boot setup and initcall_blacklist=rkisp_clr_unready_dev.')
    sensors = [s for s in graph.split('- entity ') if 'subtype Sensor' in s]
    if len(sensors) != 1 or 'm00_b_imx462 2-001a' not in sensors[0]:
        raise SystemExit('Expected one attached SeekerHD IMX462 sensor')
    sensor = re.search(r'device node name (/dev/v4l-subdev\d+)', sensors[0]).group(1)
    # 1920x1080 sensor, 2200 clocks/line at 148.5 MHz: 2250 lines = 30 fps.
    # The ISP scales the full sensor field to the 1280x720 capture buffer.
    # Debian's newer v4l2-ctl exits 255 on this kernel's missing optional
    # SUBDEV_S_CLIENT_CAP ioctl, even when its control write succeeds. Use
    # the stable V4L2 control ABI and verify each write through G_CTRL.
    fd = os.open(sensor, os.O_RDWR)
    try:
        hdr2 = sensor_capture_mode(fd) == 5
        # HDR owns its FSC, two shutters and two gains through the vendor
        # HDR exposure ABI. Applying linear controls here would corrupt it.
        controls = [] if hdr2 else [(0x009e0901, 1170), (0x00980911, 2000), (0x009e0903, 48)]
        for control, value in controls:
            fcntl.ioctl(fd, 0xc008561c, struct.pack('Ii', control, value))  # S_CTRL
            result = bytearray(struct.pack('Ii', control, 0))
            fcntl.ioctl(fd, 0xc008561b, result, True)  # G_CTRL
            if struct.unpack('Ii', result)[1] != value:
                raise RuntimeError(f'Sensor control {control:#x} did not retain {value}')
    finally:
        os.close(fd)
    run('udevadm', 'settle', '--timeout=10')
    run('v4l2-ctl', '-d', '/dev/v4l/by-path/platform-rkisp-vir0-video-index0',
        '--set-fmt-video=width=1280,height=720,pixelformat=NV12')
    print('SeekerHD prepared: NV12 1280x720, ' +
          ('experimental HDR2 timing retained' if hdr2 else 'linear sensor 30 fps'))


if __name__ == '__main__':
    main()
