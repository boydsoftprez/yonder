# SPDX-License-Identifier: GPL-3.0-or-later
"""
Enough of PyGObject for `installer/payload/yonder-pipeline` to run without
GStreamer, so the host itself is under test rather than a description of it.

CI has no GStreamer and no camera, and a host that were only tested through a
TypeScript stand-in would be the defect this branch keeps meeting: a value
that travels partway and stops. With this on `PYTHONPATH` the real Python
program parses the real argv `compose()` emits, walks a real graph built from
it, sets real properties and answers over its real stdout -- so a rate
asserted in vitest went all the way through it.
"""


def require_version(namespace, version):
    return None


def get_required_version(namespace):
    return None
