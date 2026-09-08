#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Validate session log evidence consumed by the mounted stop probe."""

WRITE_FAILURES = (
    'bulk IN write failed',
    'bulk IN write: gave up after 0.5 s of EAGAIN',
)


def consume_session_log(text_buffer, chunk, sent, observed_at):
    """Consume complete lines and reject evidence after any failed write.

    The bench session logs an ``us -> camera inject[...]`` line even when its
    preceding ``write_in`` returned false. The failure is logged first, so the
    probe must stop there rather than count the following line as transmitted.
    """
    text_buffer += chunk
    lines = text_buffer.split('\n')
    remaining = lines.pop()
    for line in lines:
        if any(message in line for message in WRITE_FAILURES):
            raise RuntimeError(line)
        if 'REFUSED' in line:
            raise RuntimeError(line)
        if 'us -> camera  inject[' in line:
            sent.append({'t': observed_at, 'line': line})
    return remaining
