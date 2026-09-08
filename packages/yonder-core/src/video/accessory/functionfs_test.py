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
import base64
import json
import struct

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

class BackpressureTests(unittest.TestCase):
    def test_blocked_parent_burst_pauses_bulk_but_services_control_and_write_then_resumes_intact(self):
        helper = ffs.Helper()
        ep0, bulk, phone_ep0 = 10001, 10002, 10003
        stdout_read, stdout_write = os.pipe()
        command_read, command_write = os.pipe()
        raw_read, raw_write, raw_select = os.read, os.write, ffs.select.select
        for fd in (stdout_read, stdout_write, command_read, command_write): os.set_blocking(fd, False)
        try:
            # A real full stdout pipe models a parent temporarily unable to read.
            filler = 0
            while True:
                try: filler += raw_write(stdout_write, b'x' * 4096)
                except BlockingIOError: break
            stage = SimpleNamespace(stage='accessory', ep0=ep0, ep_in=command_write,
                                    ep_out=bulk, control=None, events=ffs.Events())
            helper.stages['accessory'] = stage
            phone = SimpleNamespace(stage='phone', ep0=phone_ep0, ep_in=None, ep_out=None, control=None, events=ffs.Events())
            helper.stages['phone'] = phone
            chunks = [bytes([n]) * 16384 for n in range(80)]
            received = bytearray()
            state = dict(next_chunk=0, calls=0, pause=0, draining=False, input=b'', control_reads=[])
            def drain():
                while True:
                    try: received.extend(raw_read(stdout_read, 65536))
                    except BlockingIOError: break
            def choose(reads, writes, errors, timeout):
                state['calls'] += 1
                self.assertLess(state['calls'], 250, 'paused bulk descriptor caused an always-ready loop')
                self.assertLessEqual(len(helper.output), 1048576)
                self.assertEqual(timeout, 0.02)
                if state['draining']:
                    drain()
                    if state['next_chunk'] == len(chunks) and not helper.output:
                        state['input'] = b''
                        return [0], [], []
                    readable = [bulk] if bulk in reads and state['next_chunk'] < len(chunks) else []
                    writable = [1] if 1 in writes and raw_select([], [stdout_write], [], 0)[1] else []
                    return readable, writable, []
                self.assertFalse(raw_select([], [stdout_write], [], 0)[1])
                if bulk in reads:
                    return [bulk], [], []
                # Once paused, stdin and ep0 must still be selectable; metadata
                # and a pending IN command must progress before the parent drains.
                self.assertIn(0, reads)
                if state['pause'] == 0:
                    self.assertIn(ep0, reads); self.assertIn(phone_ep0, reads)
                    state['pause'] = 1
                    state['input'] = json.dumps(dict(type='write', id=99, data=base64.b64encode(b'command').decode(), deadline=1000)).encode() + b'\n'
                    return [0, ep0, phone_ep0], [], []
                if state['pause'] == 1:
                    self.assertIn(command_write, writes)
                    state['pause'] = 2
                    state['input'] = b'{"type":"control","id":1,"action":"read"}\n{"type":"control","id":2,"action":"read"}\n'
                    return [0], [command_write], []
                self.assertIsNone(helper.pending)
                self.assertIsNone(stage.control); self.assertIsNone(phone.control)
                self.assertIn(b'"type":"written","id":99', helper.output)
                self.assertEqual(state['control_reads'], [ep0, phone_ep0])
                # Only the initial filler has reached the real pipe so far.
                drain(); self.assertEqual(received, b'x' * filler); received.clear()
                state['draining'] = True
                return [], [1], []
            def read(fd, length):
                if fd == 0: return state['input']
                self.assertIn(fd, [ep0, phone_ep0])
                return struct.pack('<BBHHHB3x', 64, 52, 0, 0, 16384, 4)
            def bulk_read(fd, length, deadline):
                if fd in (ep0, phone_ep0):
                    self.assertEqual(length, 16384); self.assertEqual(deadline, 1000)
                    state['control_reads'].append(fd)
                    return (b'A' if fd == ep0 else b'P') * 16384
                self.assertEqual(fd, bulk); self.assertEqual(length, 16384); self.assertEqual(deadline, 20)
                self.assertLess(state['next_chunk'], len(chunks))
                data = chunks[state['next_chunk']]; state['next_chunk'] += 1
                return data
            def endpoint_write(fd, data, deadline):
                self.assertEqual(deadline, 1000)
                self.assertEqual(fd, command_write)
                return raw_write(fd, data)
            with patch.object(ffs.os, 'set_blocking'), patch.object(ffs.select, 'select', side_effect=choose), patch.object(ffs.os, 'read', side_effect=read), patch.object(ffs.os, 'write', side_effect=lambda fd, data: raw_write(stdout_write if fd == 1 else fd, data)), patch.object(ffs, 'endpoint_read', side_effect=bulk_read), patch.object(ffs, 'endpoint_write', side_effect=endpoint_write), patch.object(ffs, 'now', return_value=0):
                with self.assertRaises(ffs.Stop): helper.run()
            self.assertEqual(state['pause'], 2)
            self.assertEqual(raw_read(command_read, 64), b'command')
            messages = [json.loads(line) for line in received.splitlines()]
            self.assertEqual(b''.join(base64.b64decode(m['data']) for m in messages if m['type'] == 'data'), b''.join(chunks))
            self.assertEqual([m['type'] for m in messages if m['type'] != 'data'], ['setup', 'setup', 'written', 'control-data', 'control-data'])
            self.assertEqual([(m['id'], base64.b64decode(m['data'])) for m in messages if m['type'] == 'control-data'], [(1, b'A' * 16384), (2, b'P' * 16384)])
            self.assertEqual(helper.output, bytearray())
        finally:
            for fd in (stdout_read, stdout_write, command_read, command_write): os.close(fd)

    def test_bulk_pause_does_not_defer_pending_write_or_control_deadlines(self):
        helper = ffs.Helper()
        # Use valid complete IPC lines to approach the actual one-MiB cap.
        while len(helper.output) + 22000 < 1048576:
            helper.emit(type='data', data=base64.b64encode(b'x' * 16384).decode())
        helper.stages['accessory'] = SimpleNamespace(ep0=42, ep_in=43, ep_out=44, control=None)
        helper.pending = ffs.PendingWrite(7, b'command', 1000)
        with patch.object(ffs, 'now', return_value=1000), patch.object(ffs, 'endpoint_write') as write:
            with self.assertRaisesRegex(TimeoutError, 'write deadline'): helper.tick()
            write.assert_not_called()
        helper.pending = None
        helper.stages['accessory'].control = dict(id=1, setup={}, action=None, data=b'', deadline=1000)
        with patch.object(ffs, 'now', return_value=1000):
            with self.assertRaisesRegex(TimeoutError, 'setup policy/data'): helper.tick()

    def test_parent_close_is_serviced_while_bulk_is_paused(self):
        helper = ffs.Helper()
        while len(helper.output) + 22000 < 1048576:
            helper.emit(type='data', data=base64.b64encode(b'x' * 16384).decode())
        helper.stages['accessory'] = SimpleNamespace(ep0=42, ep_in=43, ep_out=44, control=None)
        def choose(reads, writes, errors, timeout):
            self.assertEqual(reads, [0, 42])
            self.assertIn(1, writes)
            return [0], [], []
        with patch.object(ffs.os, 'set_blocking'), patch.object(ffs.select, 'select', side_effect=choose), patch.object(ffs.os, 'read', return_value=b'{"type":"close"}\n'), patch.object(ffs, 'endpoint_read') as read:
            with self.assertRaises(ffs.Stop): helper.run()
            read.assert_not_called()

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

    def test_complete_functionfs_components_fit_kernel_and_workqueue_names(self):
        with tempfile.TemporaryDirectory() as directory:
            for stage in ('accessory', 'phone'):
                gadget = ffs.Gadget(pathlib.Path(directory), stage)
                description = dict(vendorId='18d1', productId='2d00', manufacturer='test', product='test', serial='0001', descriptors='AA==', strings='AA==')
                with patch.object(gadget, 'directory') as directory_created, patch.object(ffs.Path, 'write_text', autospec=True) as write_text, patch.object(ffs.Path, 'symlink_to'), patch.object(ffs, 'command') as command, patch.object(ffs, 'open_endpoint', return_value=42), patch.object(ffs.os, 'write', side_effect=lambda fd, data: len(data)):
                    gadget.prepare(description)
                components = [call.args[0].name for call in directory_created.call_args_list if call.args[0].parent.name == 'functions']
                self.assertEqual(len(components), 1)
                self.assertLessEqual(len(components[0]), 40, stage)
                instance = command.call_args.args[3]
                self.assertEqual(components[0], 'ffs.' + instance)
                self.assertLess(len('ffs-' + instance), 24, stage)
                self.assertTrue(gadget.name.startswith('yonder-pocket2-'))
                serial_writes = [call.args[1] for call in write_text.call_args_list if call.args[0].name == 'serialnumber']
                self.assertEqual(serial_writes, ['0001'])

    def test_failed_exclusive_gadget_creation_never_unbinds_another_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            gadget = ffs.Gadget(pathlib.Path(directory), 'accessory')
            with patch.object(ffs.Path, 'read_text') as read:
                self.assertEqual(gadget.close(), [])
                read.assert_not_called()

if __name__ == '__main__': unittest.main()
