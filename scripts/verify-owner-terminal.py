#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Exercise password echo and cancellation through a real disposable PTY."""
import errno
import os
from pathlib import Path
import pty
import select
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = r'''
import {createOwnerTerminal} from './packages/yonder-core/dist/owner-access/terminal.js';
const terminal = createOwnerTerminal(process.stdin, process.stdout);
try {
  const user = await terminal.read('Username: ');
  const password = await terminal.read('Password: ', true);
  const confirm = await terminal.read('Confirm: ', true);
  if (user !== 'pilot' || password !== confirm || password.length < 8) process.exitCode = 1;
  else terminal.write('ACCEPTED\n');
} catch { terminal.write('CANCELLED\n'); }
finally { terminal.close(); }
'''


def probe(cancel=False):
    master, slave = pty.openpty()
    process = subprocess.Popen(['node', '--input-type=module', '-e', SCRIPT], cwd=ROOT,
                               stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    transcript = bytearray()

    def until(marker):
        deadline = time.monotonic() + 5
        while marker not in transcript:
            if time.monotonic() > deadline:
                raise AssertionError('Terminal did not reach expected prompt')
            if select.select([master], [], [], .1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        raise AssertionError('Terminal exited before expected prompt') from None
                    raise
                if not chunk:
                    raise AssertionError('Terminal closed before expected prompt')
                transcript.extend(chunk)

    try:
        until(b'Username: ')
        os.write(master, b'pilot\n')
        until(b'Password: ')
        os.write(master, b'terminal-secret-fixture')
        if cancel:
            os.write(master, b'\x03')
            until(b'CANCELLED')
        else:
            os.write(master, b'\n')
            until(b'Confirm: ')
            os.write(master, b'terminal-secret-fixture\n')
            until(b'ACCEPTED')
        assert process.wait(timeout=5) == 0
        assert b'terminal-secret-fixture' not in transcript, 'Password was echoed'
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


probe()
probe(cancel=True)
print('PASS: real PTY password/confirmation echo suppression and Ctrl-C cancellation')
