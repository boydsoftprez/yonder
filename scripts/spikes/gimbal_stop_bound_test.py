#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Regression tests for evidence accepted by gimbal-stop-bound.py."""

import unittest

from gimbal_stop_log import consume_session_log


class SessionLogTest(unittest.TestCase):
    def test_failed_late_write_cannot_be_counted_as_transmitted(self):
        failures = (
            'bulk IN write failed: [Errno 108] Cannot send after transport endpoint shutdown',
            'bulk IN write: gave up after 0.5 s of EAGAIN',
        )
        for failure in failures:
            with self.subTest(failure=failure):
                sent = []
                fixture = f"""\
[  1.0000] us -> camera  inject[4:0x0c:64000000000080:4:0] 19/20
[  1.1000] {failure}
[  1.1001] us -> camera  inject[4:0x0c:64000000000080:4:0] 20/20
"""

                with self.assertRaisesRegex(RuntimeError, failure.split(':')[0]):
                    consume_session_log("", fixture, sent, 50.0)

                self.assertEqual(len(sent), 1)


if __name__ == "__main__":
    unittest.main()
