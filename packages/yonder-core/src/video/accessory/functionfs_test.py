# SPDX-License-Identifier: GPL-3.0-or-later
import sys
sys.dont_write_bytecode = True
import importlib.util
import os
import pathlib
import unittest
from unittest.mock import patch, MagicMock
from types import SimpleNamespace
import errno
import tempfile

spec = importlib.util.spec_from_file_location('functionfs', pathlib.Path(__file__).parent / 'assets/functionfs.py')
ffs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ffs)
ffs.signal.signal(ffs.signal.SIGALRM, lambda _s, _f: None)
ffs.signal.siginterrupt(ffs.signal.SIGALRM, True)

class FdTests(unittest.TestCase):
    def test_endpoint_open_is_nonblocking(self):
        with patch.object(ffs.os, 'open', return_value=42) as opened:
            self.assertEqual(ffs.open_endpoint('/fake/ep1'), 42)
            self.assertTrue(opened.call_args.args[1] & os.O_NONBLOCK)

    def test_partial_write_rechecks_deadline_before_each_actual_write(self):
        calls = []
        with patch.object(ffs, 'now', side_effect=[10, 11, 30]), patch.object(ffs, 'endpoint_write', side_effect=lambda fd, data, deadline: calls.append(bytes(data)) or 2):
            pending = ffs.PendingWrite(1, b'abcdef', 20)
            self.assertFalse(pending.step(42))
            self.assertFalse(pending.step(42))
            with self.assertRaises(TimeoutError): pending.step(42)
        self.assertEqual(calls, [b'abcdef', b'cdef'])

    def test_eagain_does_not_block_or_ack(self):
        with patch.object(ffs, 'now', return_value=10), patch.object(ffs, 'endpoint_write', side_effect=[BlockingIOError(), 2, 2]):
            pending = ffs.PendingWrite(1, b'abcd', 20)
            self.assertFalse(pending.step(42))
            self.assertFalse(pending.step(42))
            self.assertTrue(pending.step(42))

    def test_expired_write_never_touches_fd(self):
        with patch.object(ffs, 'now', return_value=20), patch.object(ffs, 'endpoint_write') as write:
            with self.assertRaises(TimeoutError): ffs.PendingWrite(1, b'abc', 20).step(42)
            write.assert_not_called()

    def test_control_unknown_out_stalls_by_writing_and_unknown_in_by_reading(self):
        with patch.object(ffs, 'endpoint_write', return_value=0) as write, patch.object(ffs, 'endpoint_read', return_value=b'') as read:
            ffs.control_io(42, {'requestType': 64, 'length': 8}, 'stall', b'')
            self.assertEqual(write.call_args.args[:2], (42, b'')); read.assert_not_called()
            ffs.control_io(42, {'requestType': 192, 'length': 8}, 'stall', b'')
            self.assertEqual(read.call_args.args[:2], (42, 0))

    def test_decodes_fragmented_twelve_byte_linux_events(self):
        event = bytes.fromhex('403400000100060004000000')
        parser = ffs.Events()
        self.assertEqual(parser.push(event[:7]), [])
        self.assertEqual(parser.push(event[7:]), [(4, {'requestType': 64, 'request': 52, 'value': 0, 'index': 1, 'length': 6})])

    def test_strict_chunk_and_ipc_limits(self):
        with self.assertRaises(ValueError): ffs.decode('!')
        with self.assertRaises(ValueError): ffs.decode('AAAA' * 6000)
        ipc = ffs.Lines()
        self.assertEqual(ipc.push(b'{"type":'), [])
        self.assertEqual(ipc.push(b'"close"}\n'), [{'type': 'close'}])
        with self.assertRaises(ValueError): ipc.push(b'x' * 24001)

class LifecycleTests(unittest.TestCase):
    def test_owned_controller_lock_refuses_before_module_or_gadget_changes(self):
        helper = ffs.Helper()
        with patch.object(ffs.Path, 'exists', return_value=True), patch.object(ffs.Path, 'mkdir'), patch.object(ffs.os, 'open', return_value=42), patch.object(ffs.fcntl, 'flock', side_effect=BlockingIOError()), patch.object(ffs, 'command') as command:
            with self.assertRaisesRegex(ffs.Unavailable, 'already owned'):
                helper.prepare({'controller': 'test.udc'})
            command.assert_not_called()
            self.assertEqual(helper.stages, {})

    def test_handover_retries_enodev_within_bound(self):
        helper = ffs.Helper()
        gadget = MagicMock()
        write = gadget.__truediv__.return_value.write_text
        write.side_effect = [OSError(errno.ENODEV, 'transient'), None]
        helper.stages['accessory'] = SimpleNamespace(gadget=gadget, control=None)
        helper.controller = 'test.udc'
        helper.binding = ('accessory', 3000, 0)
        with patch.object(ffs, 'now', side_effect=[0, 50, 100]):
            helper.tick(); helper.tick(); helper.tick()
        self.assertEqual(write.call_count, 2)
        self.assertIsNone(helper.binding)
        self.assertIn(b'"type":"bound"', helper.output)
        helper.binding = ('accessory', 3000, 0)
        with patch.object(ffs, 'now', return_value=3000):
            with self.assertRaises(TimeoutError): helper.tick()
        self.assertEqual(write.call_count, 2)

    def test_setup_waits_for_policy_and_control_reads_never_ack_unknown_out(self):
        helper = ffs.Helper()
        setup = dict(requestType=64, request=99, length=8)
        control = dict(id=7, setup=setup, action=None, data=b'', deadline=100)
        helper.stages['phone'] = SimpleNamespace(ep0=42, control=control)
        with patch.object(ffs, 'now', return_value=0), patch.object(ffs, 'endpoint_read') as read, patch.object(ffs, 'endpoint_write', return_value=0) as write:
            helper.tick(); read.assert_not_called(); write.assert_not_called()
            helper.handle({'type': 'control', 'id': 7, 'action': 'stall'})
            helper.tick(); read.assert_not_called(); self.assertEqual(write.call_args.args[:2], (42, b''))
        self.assertIn(b'"type":"control-done"', helper.output)

    def test_cleanup_only_closes_owned_fds_mount_and_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            unrelated = root / 'unrelated'; unrelated.mkdir()
            mount = root / 'owned-mount'; mount.mkdir()
            gadget_path = root / 'owned-gadget'; gadget_path.mkdir()
            link = root / 'owned-link'; link.symlink_to(gadget_path)
            read, write = os.pipe()
            gadget = ffs.Gadget(root, 'phone')
            gadget.gadget = gadget_path; gadget.mount = mount
            gadget.dirs = [gadget_path, mount]; gadget.fds = [read, write]
            gadget.link = link; gadget.mounted = True
            with patch.object(ffs, 'command') as command:
                self.assertEqual(gadget.close(), [])
                command.assert_called_once_with('umount', str(mount))
            self.assertTrue(unrelated.is_dir())
            self.assertFalse(mount.exists()); self.assertFalse(gadget_path.exists()); self.assertFalse(link.exists())
            with self.assertRaises(OSError): os.fstat(read)
            with self.assertRaises(OSError): os.fstat(write)

    def test_real_full_pipe_never_blocks_and_expiry_prevents_any_write(self):
        read, write = os.pipe()
        try:
            os.set_blocking(write, False)
            while True:
                try: os.write(write, b'x' * 4096)
                except BlockingIOError: break
            pending = ffs.PendingWrite(1, b'command', ffs.now() + 1000)
            self.assertFalse(pending.step(write))
            pending.deadline = ffs.now() - 1
            with self.assertRaises(TimeoutError): pending.step(write)
            os.close(write); write = None
            received = b''
            while True:
                chunk = os.read(read, 4096)
                if not chunk: break
                received += chunk
            self.assertNotIn(b'command', received)
        finally:
            os.close(read)
            if write is not None: os.close(write)

    def test_deadline_interrupts_actual_blocking_read_and_write(self):
        read, write = os.pipe()
        try:
            before = ffs.now()
            with self.assertRaises(TimeoutError): ffs.endpoint_read(read, 8, before + 20)
            self.assertLess(ffs.now() - before, 250)
            os.set_blocking(write, False)
            while True:
                try: os.write(write, b'x' * 4096)
                except BlockingIOError: break
            os.set_blocking(write, True)
            before = ffs.now()
            with self.assertRaises(TimeoutError): ffs.endpoint_write(write, b'old', before + 20)
            self.assertLess(ffs.now() - before, 250)
        finally:
            os.close(read); os.close(write)

    def test_failed_exclusive_gadget_creation_never_unbinds_another_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            gadget = ffs.Gadget(pathlib.Path(directory), 'accessory')
            self.assertLessEqual(len(gadget.name), 40)
            with patch.object(ffs.Path, 'read_text') as read:
                self.assertEqual(gadget.close(), [])
                read.assert_not_called()

if __name__ == '__main__': unittest.main()
