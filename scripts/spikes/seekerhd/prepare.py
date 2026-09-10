#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""R-CAM-01: prepare the measured SeekerHD mode before Yonder starts."""
import re
import subprocess
import fcntl
import os
import struct
from pathlib import Path


def run(*args):
    return subprocess.check_output(args, text=True, timeout=20)


def main():
    compatible = Path('/proc/device-tree/compatible').read_bytes().split(b'\0')
    if not any(c == b'radxa,zero3' or c.startswith(b'radxa,zero3-') for c in compatible):
        raise SystemExit('This camera preparation is only for Radxa Zero 3')
    run('modprobe', 'imx462_yonder')
    graph = run('media-ctl', '-d', 'platform:rkisp-vir0', '-p')
    if 'subtype Sensor' not in graph:
        # The built-in vendor ISP drops unbound sensor links at late-init,
        # before modules can load. Rebuild just the camera graph, once.
        for driver, name, operation in [
            ('rkisp', 'rkisp-vir0', 'unbind'),
            ('rockchip-csi2-dphy', 'csi2-dphy0', 'unbind'),
            ('rockchip-csi2-dphy', 'csi2-dphy0', 'bind'),
            ('rkisp', 'rkisp-vir0', 'bind'),
        ]:
            Path('/sys/bus/platform/drivers', driver, operation).write_text(name)
        graph = run('media-ctl', '-d', 'platform:rkisp-vir0', '-p')
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
        for control, value in [(0x009e0901, 1170), (0x00980911, 2000), (0x009e0903, 48)]:
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
    print('SeekerHD prepared: full-field NV12 1280x720, sensor 30 fps')


if __name__ == '__main__':
    main()
