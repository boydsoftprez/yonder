#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""R-CAM-15. Private FunctionFS fd helper; AOA/DUML policy belongs to TypeScript.

Bounded NDJSON on stdin/stdout, no capture files, no protocol-generated writes.
Bulk transfers use native AIO so reads cannot block command handling.
SIGTERM/parent EOF retires this entire generation.
"""
import base64
import ctypes
import errno
import fcntl
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from usb_aio import LinuxAio

MAX_CHUNK = 16384
MAX_LINE = 24000
MAX_OUTPUT = 1024 * 1024
# Keep room for control/event replies from both prepared stages and write/bind
# completion while the bulk data producer is paused. The total cap is unchanged.
CONTROL_OUTPUT_RESERVE = 4 * MAX_LINE
EVENT_NAMES = ('BIND', 'UNBIND', 'ENABLE', 'DISABLE', 'SETUP', 'SUSPEND', 'RESUME')


def now():
    return time.monotonic() * 1000


def open_endpoint(path):
    return os.open(path, os.O_RDWR | os.O_NONBLOCK | os.O_CLOEXEC)


# FunctionFS synchronous USB completion may sleep even with O_NONBLOCK (Linux
# f_fs.c: ffs_epfile_io / __ffs_ep0_queue_wait). Its bulk fds have no poll hook.
# Call libc directly so EINTR is not transparently restarted by Python (PEP475).
# Linux dequeues the USB request on interruption and returns any completed bytes.
# A no-op handler preserves that returned byte count; raising from the handler
# could discard a read which completed just as the timer fired.
_libc = ctypes.CDLL(None, use_errno=True)
for _name in ('read', 'write'):
    _function = getattr(_libc, _name)
    _function.argtypes = (ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t)
    _function.restype = ctypes.c_ssize_t


def endpoint_call(operation, fd, buffer, length, deadline):
    remaining = deadline - now()
    if remaining <= 0:
        raise TimeoutError('endpoint deadline expired')
    # Repeating timer also covers preemption between arming and entering libc.
    signal.setitimer(signal.ITIMER_REAL, remaining / 1000, 0.001)
    try:
        if now() >= deadline:
            raise TimeoutError('endpoint deadline expired')
        result = getattr(_libc, operation)(fd, buffer, length)
        if result < 0:
            code = ctypes.get_errno()
            if code == errno.EINTR:
                raise TimeoutError('endpoint completion deadline expired')
            raise OSError(code, 'endpoint IO failed')
        return result
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


def endpoint_read(fd, length, deadline):
    buffer = ctypes.create_string_buffer(max(1, length))
    count = endpoint_call('read', fd, buffer, length, deadline)
    return buffer.raw[:count]


def endpoint_write(fd, data, deadline):
    buffer = ctypes.create_string_buffer(data, max(1, len(data)))
    return endpoint_call('write', fd, buffer, len(data), deadline)


def decode(text):
    if not isinstance(text, str) or len(text) > 21848:
        raise ValueError('invalid chunk size')
    data = base64.b64decode(text, validate=True)
    if len(data) > MAX_CHUNK:
        raise ValueError('invalid chunk size')
    return data


class Lines:
    def __init__(self):
        self.buffer = b''

    def push(self, chunk):
        self.buffer += chunk
        messages = []
        while b'\n' in self.buffer:
            line, self.buffer = self.buffer.split(b'\n', 1)
            if len(line) > MAX_LINE:
                raise ValueError('IPC line too large')
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError('IPC message must be an object')
            messages.append(value)
        if len(self.buffer) > MAX_LINE:
            raise ValueError('IPC line too large')
        return messages


class Events:
    def __init__(self):
        self.buffer = b''

    def push(self, chunk):
        self.buffer += chunk
        events = []
        while len(self.buffer) >= 12:
            rt, req, value, index, length, typ = struct.unpack_from('<BBHHHB', self.buffer)
            self.buffer = self.buffer[12:]
            if typ >= len(EVENT_NAMES):
                raise ValueError('invalid FunctionFS event')
            events.append((typ, dict(requestType=rt, request=req, value=value, index=index, length=length)))
        return events


class PendingWrite:
    def __init__(self, ident, data, deadline):
        if not isinstance(deadline, (int, float)) or not math.isfinite(deadline):
            raise ValueError('invalid write deadline')
        self.ident, self.data, self.deadline, self.offset = ident, data, deadline, 0

    def complete(self, count):
        if count <= 0 or count > len(self.data) - self.offset:
            raise OSError('endpoint write made invalid progress')
        self.offset += count
        return self.offset == len(self.data)

    def submit(self, bulk, fd):
        if now() >= self.deadline:
            raise TimeoutError('endpoint write deadline expired')
        return bulk.submit(fd, data=self.data[self.offset:], deadline=self.deadline)


def control_io(fd, setup, action, data, deadline=None):
    deadline = now() + 1000 if deadline is None else deadline
    if action == 'stall':
        try:
            if setup['requestType'] & 128:
                endpoint_read(fd, 0, deadline)
            else:
                endpoint_write(fd, b'', deadline)
        except OSError as error:
            if error.errno != errno.EL2HLT:
                raise
        return b''
    if action == 'read':
        if setup['requestType'] & 128:
            raise ValueError('invalid control direction')
        result = endpoint_read(fd, setup['length'], deadline)
        if len(result) != setup['length']:
            raise ValueError('short control data')
        return result
    if action == 'write':
        if not setup['requestType'] & 128 or len(data) > setup['length']:
            raise ValueError('invalid control direction or size')
        if endpoint_write(fd, data, deadline) != len(data):
            raise OSError('short control write')
        return b''
    raise ValueError('invalid control action')


class Stop(Exception):
    pass


class Unavailable(Exception):
    pass


def command(*args):
    # These commands touch only kernel modules or this helper's own mounts.
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=0.75)


class Gadget:
    def __init__(self, root, stage):
        self.stage = stage
        token = uuid.uuid4().hex[:12]
        self.name = 'yonder-pocket2-' + token + '-' + stage
        # Include ffs. in configfs's component limit and leave room for the
        # ffs- workqueue prefix plus NUL in the kernel's 24-byte name buffer.
        self.function_name = 'yp2-' + token + '-' + stage[0]
        self.gadget = Path('/sys/kernel/config/usb_gadget') / self.name
        self.mount = root / self.name
        self.fds = []
        self.dirs = []
        self.link = None
        self.mounted = False
        self.ep0 = self.ep_in = self.ep_out = None
        self.events = Events()
        self.control = None

    def directory(self, path):
        path.mkdir()
        self.dirs.append(path)

    def prepare(self, description):
        self.directory(self.gadget)
        for key, value in [('idVendor', '0x' + description['vendorId']), ('idProduct', '0x' + description['productId']),
                           ('bcdUSB', '0x0200'), ('bcdDevice', '0x0100')]:
            (self.gadget / key).write_text(value)
        self.directory(self.gadget / 'strings/0x409')
        for key, value in [('manufacturer', description['manufacturer']), ('product', description['product']), ('serialnumber', description['serial'])]:
            (self.gadget / 'strings/0x409' / key).write_text(value)
        self.directory(self.gadget / 'configs/c.1')
        self.directory(self.gadget / 'configs/c.1/strings/0x409')
        (self.gadget / 'configs/c.1/strings/0x409/configuration').write_text(self.stage)
        (self.gadget / 'configs/c.1/MaxPower').write_text('500')
        function = self.gadget / ('functions/ffs.' + self.function_name)
        self.directory(function)
        link = self.gadget / 'configs/c.1' / function.name
        link.symlink_to(function)
        self.link = link
        self.directory(self.mount)
        command('mount', '-t', 'functionfs', self.function_name, str(self.mount))
        self.mounted = True
        self.ep0 = open_endpoint(self.mount / 'ep0')
        self.fds.append(self.ep0)
        for blob in (description['descriptors'], description['strings']):
            data = decode(blob)
            # FunctionFS descriptor blocks are atomic writes, never USB data.
            if os.write(self.ep0, data) != len(data):
                raise OSError('short descriptor write')

    def enable(self):
        if self.ep_in is not None:
            raise ValueError('duplicate endpoint enable')
        self.ep_in = open_endpoint(self.mount / 'ep1')
        self.fds.append(self.ep_in)
        self.ep_out = open_endpoint(self.mount / 'ep2')
        self.fds.append(self.ep_out)

    def unbind(self):
        if self.gadget not in self.dirs:
            return  # Exclusive creation failed: this name belongs to somebody else.
        try:
            if (self.gadget / 'UDC').read_text().strip():
                (self.gadget / 'UDC').write_text('\n')
        except OSError as error:
            if error.errno not in (errno.ENODEV, errno.ENOENT):
                raise

    def close(self):
        failures = []
        def attempt(operation):
            try:
                operation()
            except OSError as error:
                if error.errno != errno.ENOENT:
                    failures.append(error)
            except subprocess.SubprocessError as error:
                failures.append(error)
        attempt(self.unbind)
        for fd in reversed(self.fds):
            attempt(lambda fd=fd: os.close(fd))
        self.fds.clear()
        if self.link:
            attempt(self.link.unlink)
        if self.mounted:
            attempt(lambda: command('umount', str(self.mount)))
        for path in reversed(self.dirs):
            attempt(path.rmdir)
        return failures


class Helper:
    def __init__(self, bulk_factory=LinuxAio):
        self.lines = Lines()
        self.output = bytearray()
        self.output_partial = False
        self.priority_end = 0
        self.bulk_factory = bulk_factory
        self.bulk = None
        self.read_token = None
        self.write_token = None
        self.stages = {}
        self.root = None
        self.lock = None
        self.controller = None
        self.pending = None
        self.binding = None
        self.ident = 0
        self.prepared = False

    def emit(self, **message):
        line = json.dumps(message, separators=(',', ':')).encode() + b'\n'
        if len(line) > MAX_LINE or len(self.output) + len(line) > MAX_OUTPUT:
            raise ValueError('IPC output queue limit')
        if message.get('type') == 'written':
            boundary = self.priority_end or (self.output.index(b'\n') + 1 if self.output_partial else 0)
            self.output[boundary:boundary] = line
            self.priority_end = boundary + len(line)
        else:
            self.output.extend(line)

    def consumed_output(self, count):
        if not 0 <= count <= len(self.output):
            raise ValueError('Invalid IPC write count')
        if count:
            self.output_partial = self.output[count - 1] != 10
            self.priority_end = max(0, self.priority_end - count)
            del self.output[:count]

    def reap_bulk(self):
        if self.bulk is None:
            return
        completed = self.bulk.poll()
        # Commands get acknowledged before processing more video bytes.
        completed.sort(key=lambda result: result[0] != self.write_token)
        for token, count, data in completed:
            if count < 0:
                raise OSError(-count, 'asynchronous USB transfer failed')
            if token == self.write_token:
                self.write_token = None
                if self.pending is None:
                    raise ValueError('USB write completed without an owner')
                if self.pending.complete(count):
                    self.emit(type='written', id=self.pending.ident)
                    self.pending = None
            elif token == self.read_token:
                self.read_token = None
                # Zero-length USB packets are valid, not an endpoint EOF.
                if data:
                    self.emit(type='data', data=base64.b64encode(data).decode())
            else:
                raise ValueError('Unexpected asynchronous USB token')

    def queue_bulk(self):
        stage = self.stages.get('accessory')
        if stage is None or stage.ep_out is None or stage.ep_in is None:
            return
        if self.bulk is None:
            self.bulk = self.bulk_factory()
        if self.pending is not None and self.write_token is None:
            # Original command expiry is checked at actual kernel submission,
            # including each continuation after a partial completion.
            if now() >= self.pending.deadline:
                raise TimeoutError('endpoint write deadline expired')
            try:
                self.write_token = self.pending.submit(self.bulk, stage.ep_in)
            except BlockingIOError:
                pass
        if self.read_token is None and self.can_read_bulk():
            try:
                self.read_token = self.bulk.submit(stage.ep_out, length=MAX_CHUNK)
            except BlockingIOError:
                pass

    def can_read_bulk(self):
        # A maximum-sized data chunk fits within one bounded IPC line. Check
        # before reading USB bytes, so backpressure never consumes then drops data.
        return len(self.output) + MAX_LINE + CONTROL_OUTPUT_RESERVE <= MAX_OUTPUT

    def prepare(self, message):
        if self.prepared:
            raise ValueError('already prepared')
        self.prepared = True
        controller = message['controller']
        if not isinstance(controller, str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,128}', controller):
            raise ValueError('invalid controller')
        if not (Path('/sys/class/udc') / controller).exists():
            raise Unavailable('USB peripheral controller missing; peripheral mode must be configured separately')
        lock_root = Path('/run/yonder/accessory-usb')
        lock_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Persistent lock inode avoids races with a third opener during release.
        self.lock = os.open(lock_root / (controller + '.lock'), os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Unavailable('USB controller already owned by another Pocket 2 runtime')
        command('modprobe', 'libcomposite')
        command('modprobe', 'usb_f_fs')
        gadgets = Path('/sys/kernel/config/usb_gadget')
        if not gadgets.is_dir():
            raise Unavailable('USB configfs or FunctionFS is unavailable')
        for udc in gadgets.glob('*/UDC'):
            if udc.read_text().strip() == controller:
                raise Unavailable('USB controller already bound to another gadget')
        self.controller = controller
        descriptions = message['stages']
        if len(descriptions) != 2 or [d['stage'] for d in descriptions] != ['phone', 'accessory']:
            raise ValueError('invalid stage descriptors')
        self.root = Path(tempfile.mkdtemp(prefix='yonder-pocket2-', dir=lock_root))
        for description in descriptions:
            stage = Gadget(self.root, description['stage'])
            self.stages[stage.stage] = stage
            stage.prepare(description)
        self.emit(type='ready')

    def handle(self, message):
        typ = message['type']
        if typ == 'prepare':
            self.prepare(message)
        elif typ == 'close':
            raise Stop()
        elif typ == 'bind':
            stage = message['stage']
            if stage not in self.stages or self.binding:
                raise ValueError('invalid bind')
            for other in self.stages.values():
                if other.stage != stage:
                    other.unbind()
            self.binding = (stage, now() + 3000, now())
        elif typ == 'write':
            stage = self.stages.get('accessory')
            if self.pending or not stage or stage.ep_in is None:
                raise ValueError('endpoint writer unavailable')
            data = decode(message['data'])
            if not data:
                raise ValueError('empty bulk write')
            self.pending = PendingWrite(message['id'], data, min(message['deadline'], now() + 1000))
        elif typ == 'control':
            matches = [s for s in self.stages.values() if s.control and s.control['id'] == message['id']]
            if len(matches) != 1:
                raise ValueError('invalid control correlation')
            control = matches[0].control
            if control['action'] is not None:
                raise ValueError('duplicate control policy')
            control['action'] = message['action']
            control['data'] = decode(message.get('data', ''))
        else:
            raise ValueError('unknown IPC request')

    def tick(self):
        current = now()
        if self.binding:
            stage, deadline, retry = self.binding
            if current >= deadline:
                raise TimeoutError('USB handover bind timeout')
            if current >= retry:
                try:
                    (self.stages[stage].gadget / 'UDC').write_text(self.controller)
                    self.binding = None
                    self.emit(type='bound', stage=stage)
                except OSError as error:
                    if error.errno != errno.ENODEV:
                        raise
                    self.binding = (stage, deadline, current + 100)
        if self.pending and current >= self.pending.deadline:
            if self.bulk is not None and self.write_token is not None:
                self.bulk.cancel(self.write_token)
            raise TimeoutError('endpoint write deadline expired')
        for stage in self.stages.values():
            control = stage.control
            if control:
                if current >= control['deadline']:
                    raise TimeoutError('USB setup policy/data timed out')
                if control['action'] is not None:
                    try:
                        data = control_io(stage.ep0, control['setup'], control['action'], control['data'], control['deadline'])
                    except BlockingIOError:
                        continue
                    if control['action'] == 'read' and control['setup']['length']:
                        self.emit(type='control-data', id=control['id'], data=base64.b64encode(data).decode())
                    else:
                        self.emit(type='control-done', id=control['id'])
                    stage.control = None

    def run(self):
        os.set_blocking(0, False)
        os.set_blocking(1, False)
        while True:
            self.reap_bulk()
            self.tick()
            reads = [0] + [s.ep0 for s in self.stages.values() if s.control is None]
            if self.bulk is not None:
                reads.append(self.bulk.eventfd)
            writes = [1] if self.output else []
            timeout = min(0.02, max(0, (self.pending.deadline - now()) / 1000)) if self.pending else 0.02
            readable, writable, _ = select.select(reads, writes, [], timeout)
            # Parent EOF/control precedes all endpoint work, including an active write.
            if 0 in readable:
                data = os.read(0, 8192)
                if not data:
                    raise Stop()
                for message in self.lines.push(data):
                    self.handle(message)
            if 1 in writable:
                try:
                    count = os.write(1, self.output[:65536])
                    self.consumed_output(count)
                except BlockingIOError:
                    pass
            for stage in self.stages.values():
                if stage.ep0 in readable:
                    try:
                        data = os.read(stage.ep0, 12)
                    except BlockingIOError:
                        continue
                    if not data:
                        raise OSError('control endpoint closed')
                    for typ, setup in stage.events.push(data):
                        if typ == 4:
                            self.ident += 1
                            stage.control = dict(id=self.ident, setup=setup, action=None, data=b'', deadline=now() + 1000)
                            self.emit(type='setup', stage=stage.stage, id=self.ident, setup=setup)
                        else:
                            if typ == 2 and stage.stage == 'accessory':
                                stage.enable()
                            self.emit(type='event', stage=stage.stage, event=EVENT_NAMES[typ])
                            if typ in (1, 3) and stage.stage == 'accessory':
                                # Never permit bytes after a disable even before the parent sees it.
                                self.pending = None
                                if self.bulk is not None:
                                    self.bulk.close()
                                    self.bulk = None
                                self.read_token = self.write_token = None
                                for fd in (stage.ep_in, stage.ep_out):
                                    if fd is not None:
                                        os.close(fd)
                                        stage.fds.remove(fd)
                                stage.ep_in = stage.ep_out = None
            # USB completions wake eventfd; no synchronous bulk read/write can
            # hold this loop away from stdin, lifecycle events or deadlines.
            self.reap_bulk()
            self.queue_bulk()

    def flush_error(self, error):
        # Fixed text only: no exception payload, media, or command bytes in logs.
        if isinstance(error, Unavailable):
            code, message = 'unavailable', str(error)
        else:
            code, message = 'fault', 'FunctionFS failed: ' + type(error).__name__
            if isinstance(error, OSError) and error.errno is not None:
                message += ' errno=' + str(error.errno)
        try:
            self.output.clear()
            self.emit(type='error', code=code, message=message)
            if select.select([], [1], [], 0.1)[1]:
                os.write(1, self.output)
        except (OSError, ValueError):
            pass

    def close(self):
        failures = []
        # Unbind before joining AIO: closing a userspace fd alone does not
        # cancel kernel-owned transfers. Keep all buffers alive through join.
        for stage in reversed(list(self.stages.values())):
            try:
                stage.unbind()
            except OSError as error:
                failures.append(error)
        if self.bulk is not None:
            try:
                self.bulk.close()
                self.bulk = None
            except OSError as error:
                failures.append(error)
        for stage in reversed(list(self.stages.values())):
            failures.extend(stage.close())
        if self.root:
            try:
                self.root.rmdir()
            except OSError:
                failures.append('runtime directory remains')
        if self.lock is not None:
            os.close(self.lock)
        if failures:
            print('FunctionFS owned-resource cleanup failed', file=sys.stderr)
        return not failures


def main():
    if sys.platform != 'linux':
        print('{"type":"error","code":"unavailable","message":"FunctionFS requires Linux"}', flush=True)
        return 1
    helper = Helper()
    def stop(_signum, _frame):
        raise Stop()
    signal.signal(signal.SIGALRM, lambda _signum, _frame: None)
    signal.siginterrupt(signal.SIGALRM, True)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    status = 0
    try:
        helper.run()
    except Stop:
        pass
    except Exception as error:
        helper.flush_error(error)
        status = 1
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        if not helper.close():
            status = 2
    return status


if __name__ == '__main__':
    sys.exit(main())
