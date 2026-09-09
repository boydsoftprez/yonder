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

sys.path.insert(0, str(pathlib.Path(__file__).parent / 'assets'))
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

    def test_partial_write_rechecks_deadline_before_each_submission(self):
        bulk = MagicMock(); bulk.submit.side_effect = [1, 2]
        pending = ffs.PendingWrite(1, b'abcdef', 20)
        with patch.object(ffs, 'now', return_value=10):
            self.assertEqual(pending.submit(bulk, 42), 1)
            self.assertFalse(pending.complete(2))
            self.assertEqual(pending.submit(bulk, 42), 2)
            bulk.submit.assert_called_with(42, data=b'cdef', deadline=20)
        with patch.object(ffs, 'now', return_value=20):
            with self.assertRaises(TimeoutError): pending.submit(bulk, 42)
        self.assertEqual(bulk.submit.call_count, 2)

    def test_invalid_completion_cannot_ack_a_write(self):
        pending = ffs.PendingWrite(1, b'abc', 20)
        for count in [0, -1, 4]:
            with self.assertRaises(OSError): pending.complete(count)
        self.assertEqual(pending.offset, 0)

    def test_expired_write_never_submits_to_the_kernel(self):
        bulk = MagicMock()
        with patch.object(ffs, 'now', return_value=20):
            with self.assertRaises(TimeoutError): ffs.PendingWrite(1, b'abc', 20).submit(bulk, 42)
        bulk.submit.assert_not_called()

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
    def test_write_completion_does_not_wait_behind_queued_video(self):
        helper = ffs.Helper()
        payload = base64.b64encode(b'x' * 16384).decode()
        for _ in range(30): helper.emit(type='data', data=payload)
        helper.emit(type='written', id=7)
        first = json.loads(bytes(helper.output).splitlines()[0])
        self.assertEqual(first, dict(type='written', id=7))
        self.assertEqual(sum(json.loads(line)['type'] == 'data' for line in bytes(helper.output).splitlines()), 30)

    def test_blocked_parent_burst_pauses_bulk_but_services_control_and_write_then_resumes_intact(self):
        ep0, bulk, phone_ep0 = 10001, 10002, 10003
        stdout_read, stdout_write = os.pipe()
        command_read, command_write = os.pipe()
        raw_read, raw_write, raw_select = os.read, os.write, ffs.select.select
        for fd in (stdout_read, stdout_write, command_read, command_write): os.set_blocking(fd, False)
        class Aio:
            eventfd = 10004
            def __init__(self): self.serial = 0; self.held = {}; self.done = []
            def submit(self, fd, data=None, length=16384, deadline=None):
                self.serial += 1; token = self.serial
                self.held[token] = (fd, data, length)
                if data is not None: self.done.append((token, raw_write(fd, data), None))
                return token
            def poll(self):
                out, self.done = self.done, []
                for token, _, _ in out: self.held.pop(token)
                return out
            def cancel(self, token): raise AssertionError('unexpected cancellation')
        aio = Aio(); helper = ffs.Helper(bulk_factory=lambda: aio)
        stage = SimpleNamespace(stage='accessory', ep0=ep0, ep_in=command_write,
                                ep_out=bulk, control=None, events=ffs.Events())
        phone = SimpleNamespace(stage='phone', ep0=phone_ep0, ep_in=None,
                                ep_out=None, control=None, events=ffs.Events())
        helper.stages = dict(accessory=stage, phone=phone)
        chunks = [bytes([n]) * 16384 for n in range(80)]
        received = bytearray()
        state = dict(next_chunk=0, calls=0, pause=0, draining=False, input=b'', control_reads=[])
        def drain():
            while True:
                try: received.extend(raw_read(stdout_read, 65536))
                except BlockingIOError: break
        def choose(reads, writes, errors, timeout):
            state['calls'] += 1
            self.assertLess(state['calls'], 500)
            self.assertLessEqual(len(helper.output), 1048576)
            self.assertNotIn(bulk, reads, 'synchronous bulk polling must not return')
            self.assertNotIn(command_write, writes)
            self.assertLessEqual(len(aio.held), 2)
            if state['draining']:
                drain()
                if state['next_chunk'] == len(chunks) and not helper.output:
                    state['input'] = b''; return [0], [], []
            ready = []
            for token, (fd, data, length) in list(aio.held.items()):
                if fd == bulk and state['next_chunk'] < len(chunks):
                    chunk = chunks[state['next_chunk']]; state['next_chunk'] += 1
                    aio.done.append((token, len(chunk), chunk)); ready = [aio.eventfd]; break
            if not state['draining'] and helper.bulk and helper.read_token is None:
                if state['pause'] == 0:
                    state['pause'] = 1
                    state['input'] = json.dumps(dict(type='write', id=99, data=base64.b64encode(b'command').decode(), deadline=1000)).encode() + b'\n'
                    return [0, ep0, phone_ep0], [], []
                if state['pause'] == 1:
                    state['pause'] = 2
                    state['input'] = b'{"type":"control","id":1,"action":"read"}\n{"type":"control","id":2,"action":"read"}\n'
                    return [0], [], []
                self.assertIsNone(helper.pending)
                self.assertIsNone(stage.control); self.assertIsNone(phone.control)
                self.assertEqual(json.loads(bytes(helper.output).splitlines()[0]), dict(type='written', id=99))
                self.assertEqual(state['control_reads'], [ep0, phone_ep0])
                drain(); self.assertEqual(received, b'x' * filler); received.clear()
                state['draining'] = True
            writable = [1] if 1 in writes and raw_select([], [stdout_write], [], 0)[1] else []
            return ready, writable, []
        def read(fd, length):
            if fd == 0: return state['input']
            if fd in (ep0, phone_ep0): return struct.pack('<BBHHHB3x', 64, 52, 0, 0, 2, 4)
            raise AssertionError('unexpected synchronous read')
        def control_read(fd, length, deadline):
            self.assertIn(fd, (ep0, phone_ep0)); state['control_reads'].append(fd); return b'xx'
        try:
            filler = 0
            while True:
                try: filler += raw_write(stdout_write, b'x' * 4096)
                except BlockingIOError: break
            with patch.object(ffs, 'now', return_value=0), patch.object(ffs.os, 'set_blocking'), patch.object(ffs.os, 'read', side_effect=read), patch.object(ffs.os, 'write', side_effect=lambda fd,data: raw_write(stdout_write if fd == 1 else fd,data)), patch.object(ffs.select, 'select', side_effect=choose), patch.object(ffs, 'endpoint_read', side_effect=control_read):
                with self.assertRaises(ffs.Stop): helper.run()
            drain()
            messages = [json.loads(line) for line in received.splitlines()]
            self.assertEqual([base64.b64decode(m['data']) for m in messages if m['type'] == 'data'], chunks)
            self.assertEqual(raw_read(command_read, 100), b'command')
        finally:
            for fd in (stdout_read, stdout_write, command_read, command_write): os.close(fd)

    def test_completion_priority_preserves_partial_line_and_control_order(self):
        helper = ffs.Helper()
        helper.emit(type='data', data='first'); helper.emit(type='data', data='second')
        sent = bytes(helper.output[:9]); helper.consumed_output(9)
        helper.emit(type='written', id=1); helper.emit(type='written', id=2)
        messages = [json.loads(line) for line in (sent + bytes(helper.output)).splitlines()]
        self.assertEqual(messages, [dict(type='data', data='first'), dict(type='written', id=1), dict(type='written', id=2), dict(type='data', data='second')])
        helper.consumed_output(len(helper.output))
        self.assertFalse(helper.output_partial); self.assertEqual(helper.priority_end, 0)

    def test_pending_video_read_does_not_block_write_and_partial_completion_rechecks_expiry(self):
        aio = MagicMock(); aio.submit.side_effect = [1, 2, 3]; aio.poll.return_value = []
        helper = ffs.Helper(bulk_factory=lambda: aio)
        helper.stages['accessory'] = SimpleNamespace(ep_in=6, ep_out=7)
        with patch.object(ffs, 'now', return_value=10):
            helper.queue_bulk(); self.assertEqual(helper.read_token, 1)
            helper.pending = ffs.PendingWrite(42, b'abcd', 100)
            helper.queue_bulk(); self.assertEqual(helper.write_token, 2)
            aio.submit.assert_called_with(6, data=b'abcd', deadline=100)
            aio.poll.return_value = [(2, 2, None)]
            helper.reap_bulk(); self.assertEqual(helper.pending.offset, 2)
        with patch.object(ffs, 'now', return_value=100):
            with self.assertRaises(TimeoutError): helper.queue_bulk()
        self.assertEqual(aio.submit.call_count, 2)
        self.assertEqual(helper.read_token, 1)

    def test_zero_length_usb_packet_is_not_a_disconnect(self):
        aio = MagicMock(); aio.submit.side_effect = [1, 2]
        helper = ffs.Helper(bulk_factory=lambda: aio)
        helper.stages['accessory'] = SimpleNamespace(ep_in=6, ep_out=7)
        helper.queue_bulk(); aio.poll.return_value = [(1, 0, None)]
        helper.reap_bulk(); helper.queue_bulk()
        self.assertEqual(helper.read_token, 2); self.assertEqual(helper.output, b'')

    def test_expired_inflight_write_cancels_the_kernel_request(self):
        helper = ffs.Helper(); helper.bulk = MagicMock(); helper.write_token = 8
        helper.pending = ffs.PendingWrite(42, b'command', 100)
        with patch.object(ffs, 'now', return_value=100):
            with self.assertRaises(TimeoutError): helper.tick()
        helper.bulk.cancel.assert_called_once_with(8)
        self.assertNotIn(b'"type":"written"', helper.output)

    def test_cleanup_unbinds_before_joining_and_releasing_aio_buffers(self):
        calls = []; stage = MagicMock(); stage.unbind.side_effect = lambda: calls.append('unbind')
        stage.close.side_effect = lambda: calls.append('close-fds') or []
        helper = ffs.Helper(); helper.stages['accessory'] = stage; helper.bulk = MagicMock()
        helper.bulk.close.side_effect = lambda: calls.append('join-aio')
        self.assertTrue(helper.close()); self.assertEqual(calls, ['unbind', 'join-aio', 'close-fds'])

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

    def test_eagain_submission_remains_pending_until_its_original_deadline(self):
        aio = MagicMock(); aio.submit.side_effect = BlockingIOError()
        helper = ffs.Helper(bulk_factory=lambda: aio)
        helper.stages['accessory'] = SimpleNamespace(ep_in=6, ep_out=7, control=None)
        helper.pending = ffs.PendingWrite(1, b'command', 100)
        with patch.object(ffs, 'now', return_value=10): helper.queue_bulk()
        self.assertIsNotNone(helper.pending); self.assertIsNone(helper.write_token)
        self.assertNotIn(b'"type":"written"', helper.output)
        with patch.object(ffs, 'now', return_value=100):
            with self.assertRaises(TimeoutError): helper.tick()

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
