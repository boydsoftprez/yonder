# SPDX-License-Identifier: GPL-3.0-or-later
import errno
import struct
import tempfile
import unittest
import contextlib
import io
from unittest.mock import patch
from pathlib import Path
import prepare


class CaptureModeTest(unittest.TestCase):
    def test_bound_i2c_sensor_does_not_require_media_node(self):
        with tempfile.TemporaryDirectory() as directory:
            driver = Path(directory) / 'imx462'
            device = Path(directory) / 'devices' / '2-001a'
            driver.mkdir()
            device.mkdir(parents=True)
            link = driver / '2-001a'
            link.symlink_to(device)
            self.assertEqual(prepare.bound_sensor_device(driver), str(link))

    def test_absent_sensor_never_tears_down_the_isp_graph(self):
        calls = []
        with patch.object(prepare.Path, 'read_bytes', return_value=b'radxa,zero3\0'), \
             patch.object(prepare, 'run', side_effect=lambda *args: calls.append(args) or ''), \
             patch.object(prepare, 'bound_sensor_device', return_value=None), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            prepare.main()
        self.assertEqual(calls, [('modprobe', 'imx462_yonder')])
        self.assertIn('not bound', output.getvalue())

    def test_missing_sensor_graph_never_rebinds_vendor_drivers(self):
        calls = []
        with patch.object(prepare.Path, 'read_bytes', return_value=b'radxa,zero3\0'), \
             patch.object(prepare, 'run', side_effect=lambda *args: calls.append(args) or ''), \
             patch.object(prepare, 'bound_sensor_device', return_value='/sys/bus/i2c/devices/2-001a'), \
             patch.object(prepare.Path, 'write_text') as sysfs_write, \
             patch.object(prepare.os, 'open') as device_open:
            with self.assertRaises(SystemExit):
                prepare.main()
        sysfs_write.assert_not_called()
        device_open.assert_not_called()
        self.assertEqual(calls, [('modprobe', 'imx462_yonder'),
                                 ('media-ctl', '-d', 'platform:rkisp-vir0', '-p')])

    def test_preparation_does_not_overwrite_hdr_shutters_or_timing(self):
        graph = ('- entity 4: m00_b_imx462 2-001a\n subtype Sensor\n'
                 ' device node name /dev/v4l-subdev3\n')
        with patch.object(prepare.Path, 'read_bytes', return_value=b'radxa,zero3\0'), \
             patch.object(prepare, 'run', side_effect=lambda *args: graph if args[0] == 'media-ctl' else ''), \
             patch.object(prepare, 'bound_sensor_device', return_value='/dev/v4l-subdev3'), \
             patch.object(prepare.os, 'open', return_value=7), \
             patch.object(prepare.os, 'close'), \
             patch.object(prepare, 'sensor_capture_mode', return_value=5), \
             patch.object(prepare.fcntl, 'ioctl') as controls, \
             contextlib.redirect_stdout(io.StringIO()):
            prepare.main()
        controls.assert_not_called()

    def test_legacy_driver_is_linear(self):
        with patch.object(prepare.fcntl, 'ioctl', side_effect=OSError(errno.ENOTTY, 'unsupported')):
            self.assertEqual(prepare.sensor_capture_mode(7), 0)

    def test_hdr_readback_and_unknown_modes(self):
        def query(mode):
            def fill(fd, request, data, mutate):
                struct.pack_into('I', data, 0, mode)
            return fill
        for mode in (0, 5):
            with patch.object(prepare.fcntl, 'ioctl', side_effect=query(mode)):
                self.assertEqual(prepare.sensor_capture_mode(7), mode)
        with patch.object(prepare.fcntl, 'ioctl', side_effect=query(6)):
            with self.assertRaises(RuntimeError): prepare.sensor_capture_mode(7)

    def test_io_failure_does_not_fall_back_to_linear_writes(self):
        with patch.object(prepare.fcntl, 'ioctl', side_effect=OSError(errno.EIO, 'sensor error')):
            with self.assertRaises(OSError): prepare.sensor_capture_mode(7)


if __name__ == '__main__': unittest.main()
