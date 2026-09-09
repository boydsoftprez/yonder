# SPDX-License-Identifier: GPL-3.0-or-later
"""Small bounded Linux native-AIO adapter for FunctionFS bulk endpoints.

FunctionFS O_NONBLOCK does not make synchronous USB completion nonblocking.
Keep endpoint buffers alive until kernel completion; eventfd lets the owner's
single event loop continue handling commands while video is waiting on USB.
"""
import ctypes
import errno
import os
import platform
import sys
import time


class IOCB(ctypes.Structure):
    _fields_ = [('data', ctypes.c_uint64), ('key', ctypes.c_uint32),
                ('rw_flags', ctypes.c_uint32), ('opcode', ctypes.c_uint16),
                ('priority', ctypes.c_int16), ('fd', ctypes.c_uint32),
                ('buffer', ctypes.c_uint64), ('length', ctypes.c_uint64),
                ('offset', ctypes.c_int64), ('reserved', ctypes.c_uint64),
                ('flags', ctypes.c_uint32), ('eventfd', ctypes.c_uint32)]


class Event(ctypes.Structure):
    _fields_ = [('data', ctypes.c_uint64), ('obj', ctypes.c_uint64),
                ('result', ctypes.c_int64), ('result2', ctypes.c_int64)]


class Timespec(ctypes.Structure):
    _fields_ = [('seconds', ctypes.c_long), ('nanoseconds', ctypes.c_long)]


class LinuxAio:
    """Two slots: one USB read and one USB write, with no userspace worker queue."""
    def __init__(self):
        if sys.platform != 'linux' or sys.byteorder != 'little':
            raise OSError('FunctionFS asynchronous I/O requires little-endian Linux')
        numbers = {'aarch64': (0, 1, 2, 3, 4), 'x86_64': (206, 207, 209, 210, 208),
                   'armv7l': (243, 244, 246, 247, 245), 'armv6l': (243, 244, 246, 247, 245)}
        if platform.machine() not in numbers:
            raise OSError('Unsupported FunctionFS asynchronous-I/O architecture')
        if ctypes.sizeof(IOCB) != 64 or ctypes.sizeof(Event) != 32:
            raise OSError('Unexpected Linux asynchronous-I/O ABI')
        self.numbers = numbers[platform.machine()]
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.syscall.restype = ctypes.c_long
        self.context = ctypes.c_ulong(0)
        self.requests = {}
        self.serial = 0
        self.eventfd = os.eventfd(0, os.EFD_NONBLOCK | os.EFD_CLOEXEC)
        try:
            self.call(0, ctypes.c_uint(2), ctypes.byref(self.context))
        except BaseException:
            os.close(self.eventfd)
            raise

    def call(self, operation, *args):
        result = self.libc.syscall(ctypes.c_long(self.numbers[operation]), *args)
        if result < 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        return result

    def submit(self, fd, *, data=None, length=16384, deadline=None):
        if len(self.requests) >= 2:
            raise ValueError('Asynchronous USB slot limit')
        if data is not None:
            length = len(data)
        if not 0 < length <= 16384:
            raise ValueError('Invalid asynchronous USB transfer size')
        self.serial += 1
        buffer = ctypes.create_string_buffer(length)
        if data is not None:
            ctypes.memmove(buffer, bytes(data), length)
        cb = IOCB(data=self.serial, opcode=0 if data is None else 1, fd=fd,
                  buffer=ctypes.addressof(buffer), length=length, flags=1, eventfd=self.eventfd)
        pointers = (ctypes.POINTER(IOCB) * 1)(ctypes.pointer(cb))
        token = self.serial
        # Retain before entering the kernel: SIGTERM can unwind Python after
        # io_submit queued a request but before its return value is handled.
        self.requests[token] = (cb, buffer, data is None)
        try:
            if deadline is not None and time.monotonic() * 1000 >= deadline:
                raise TimeoutError('endpoint write deadline expired at kernel submission')
            submitted = self.call(2, self.context, ctypes.c_long(1), pointers)
        except OSError:
            self.requests.pop(token)
            raise
        if submitted != 1:
            self.requests.pop(token)
            raise OSError('USB transfer was not submitted')
        return token

    def poll(self):
        try:
            os.eventfd_read(self.eventfd)
        except BlockingIOError:
            pass
        events = (Event * 2)()
        timeout = Timespec(0, 0)
        count = self.call(4, self.context, ctypes.c_long(0), ctypes.c_long(2),
                          events, ctypes.byref(timeout))
        result = []
        for event in events[:count]:
            held = self.requests.get(event.data)
            if held is None or event.obj != ctypes.addressof(held[0]):
                raise ValueError('Uncorrelated asynchronous USB completion')
            cb, buffer, reading = self.requests.pop(event.data)
            if event.result2 or event.result > cb.length:
                raise ValueError('Invalid asynchronous USB completion')
            result.append((event.data, event.result,
                           buffer.raw[:event.result] if reading and event.result > 0 else None))
        return result

    def cancel(self, token):
        held = self.requests.get(token)
        if held is None:
            return
        event = Event()
        try:
            self.call(3, self.context, ctypes.byref(held[0]), ctypes.byref(event))
        except OSError as error:
            # Cancellation/completion may race. Retain the buffers until the
            # generation unbinds and io_destroy has finished either way.
            if error.errno not in (errno.EINPROGRESS, errno.EAGAIN, errno.EINVAL):
                raise

    def close(self):
        # Caller unbinds the owned gadget FIRST, canceling outstanding USB.
        # io_destroy joins kernel completion before releasing any user buffer.
        if self.context.value:
            self.call(1, self.context)
            self.context.value = 0
            self.requests.clear()
        if self.eventfd is not None:
            os.close(self.eventfd)
            self.eventfd = None
