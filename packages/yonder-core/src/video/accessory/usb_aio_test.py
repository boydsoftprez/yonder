# SPDX-License-Identifier: GPL-3.0-or-later
import sys
sys.dont_write_bytecode = True
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent / 'assets'))
import ctypes
import errno
import unittest
from unittest.mock import patch, MagicMock
from usb_aio import LinuxAio, IOCB, Event
import usb_aio


def aio():
    value = LinuxAio.__new__(LinuxAio)
    value.requests = {}; value.serial = 0; value.context = ctypes.c_ulong(17); value.eventfd = 9000
    value.call = MagicMock(return_value=1)
    return value


class AsyncIoTests(unittest.TestCase):
    def test_kernel_abi_and_independent_read_write_slots(self):
        self.assertEqual(ctypes.sizeof(IOCB), 64); self.assertEqual(ctypes.sizeof(Event), 32)
        value = aio(); read = value.submit(7, length=16); write = value.submit(6, data=b'command')
        rcb, rbuf, reading = value.requests[read]; wcb, wbuf, writing = value.requests[write]
        self.assertEqual((rcb.opcode, wcb.opcode), (0, 1)); self.assertEqual(wbuf.raw, b'command')
        self.assertTrue(reading); self.assertFalse(writing)
        self.assertEqual(rcb.flags, 1); self.assertEqual(rcb.eventfd, 9000)
        with self.assertRaises(ValueError): value.submit(7)

    def test_deadline_is_rechecked_at_kernel_submission(self):
        value = aio()
        with patch.object(usb_aio.time, 'monotonic', return_value=.2):
            with self.assertRaises(TimeoutError): value.submit(6, data=b'old', deadline=100)
        value.call.assert_not_called(); self.assertEqual(value.requests, {})

    def test_signal_after_submission_retains_buffers_for_cleanup(self):
        class Stop(BaseException): pass
        value = aio(); value.call.side_effect = Stop()
        with self.assertRaises(Stop): value.submit(6, data=b'held')
        self.assertEqual(len(value.requests), 1)
        self.assertEqual(value.requests[1][1].raw, b'held')

    def test_failed_submission_releases_only_the_unsubmitted_buffer(self):
        value = aio(); read = value.submit(7)
        value.call.side_effect = BlockingIOError(errno.EAGAIN, 'busy')
        with self.assertRaises(BlockingIOError): value.submit(6, data=b'not queued')
        self.assertEqual(list(value.requests), [read])

    def test_completion_copies_read_bytes_and_correlates_the_write(self):
        value = aio(); read = value.submit(7, length=8); write = value.submit(6, data=b'hello')
        ctypes.memmove(value.requests[read][1], b'frame123', 8)
        def completed(operation, context, minimum, maximum, events, timeout):
            self.assertEqual(operation, 4); self.assertEqual(minimum.value, 0)
            events[0] = Event(read, ctypes.addressof(value.requests[read][0]), 8, 0)
            events[1] = Event(write, ctypes.addressof(value.requests[write][0]), 5, 0)
            return 2
        value.call.side_effect = completed
        with patch.object(usb_aio.os, 'eventfd_read', create=True):
            self.assertEqual(value.poll(), [(read, 8, b'frame123'), (write, 5, None)])
        self.assertEqual(value.requests, {})

    def test_bad_correlation_cannot_confirm_a_write(self):
        value = aio(); token = value.submit(6, data=b'x')
        def completed(_op, _context, _minimum, _maximum, events, _timeout):
            events[0] = Event(token, 1, 1, 0); return 1
        value.call.side_effect = completed
        with patch.object(usb_aio.os, 'eventfd_read', create=True):
            with self.assertRaises(ValueError): value.poll()
        self.assertIn(token, value.requests)

    def test_cancel_race_retains_buffers_until_kernel_join(self):
        value = aio(); token = value.submit(7)
        value.call.side_effect = OSError(errno.EINPROGRESS, 'cancel queued'); value.cancel(token)
        self.assertIn(token, value.requests)
        def join(operation, context):
            self.assertEqual(operation, 1); self.assertIn(token, value.requests); return 0
        value.call.side_effect = join
        with patch.object(usb_aio.os, 'close') as close:
            value.close(); close.assert_called_once_with(9000)
        self.assertEqual(value.requests, {}); self.assertEqual(value.context.value, 0)


if __name__ == '__main__': unittest.main()
