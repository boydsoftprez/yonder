#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Contract tests for the SeekerHD kernel-initcall boot argument."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("bootargs.py")
TOKEN = "initcall_blacklist=rkisp_clr_unready_dev"


class BootArgsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "armbianEnv.txt"

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, *extra, ok=True):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), *extra, str(self.path)],
            text=True,
            capture_output=True,
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def test_adds_extraargs_when_missing(self):
        self.path.write_text("verbosity=1\nuser_overlays=uart2-m0\n")
        self.invoke()
        self.assertEqual(
            self.path.read_text(),
            "verbosity=1\nuser_overlays=uart2-m0\nextraargs=" + TOKEN + "\n",
        )

    def test_adds_extraargs_after_an_unterminated_last_line(self):
        self.path.write_text("verbosity=1")
        self.invoke()
        self.assertEqual(self.path.read_text(), "verbosity=1\nextraargs=" + TOKEN + "\n")

    def test_adds_token_to_empty_extraargs(self):
        self.path.write_text("extraargs=\nconsole=display\n")
        self.invoke()
        self.assertEqual(self.path.read_text(), "extraargs=" + TOKEN + "\nconsole=display\n")

    def test_merges_existing_blacklist_and_is_idempotent(self):
        before = "extraargs=quiet initcall_blacklist=old_init,another_init cma=256M\n"
        self.path.write_text(before)
        self.invoke()
        self.invoke()
        self.assertEqual(
            self.path.read_text(),
            "extraargs=quiet initcall_blacklist=old_init,another_init,rkisp_clr_unready_dev cma=256M\n",
        )

    def test_preserves_unrelated_extraargs_spacing_and_quoted_values(self):
        self.path.write_text('extraargs=  quiet  "console=tty1 loglevel=1"  cma=256M\n')
        self.invoke()
        self.assertEqual(
            self.path.read_text(),
            'extraargs=  quiet  "console=tty1 loglevel=1"  cma=256M ' + TOKEN + '\n',
        )

    def test_ignores_blacklist_lookalike_inside_a_quoted_unrelated_value(self):
        self.path.write_text('extraargs=foo="a initcall_blacklist=old b" cma=256M\n')
        self.invoke()
        self.assertEqual(
            self.path.read_text(),
            'extraargs=foo="a initcall_blacklist=old b" cma=256M ' + TOKEN + '\n',
        )

    def test_fills_an_empty_blacklist_value(self):
        self.path.write_text("extraargs=quiet initcall_blacklist= cma=256M\n")
        self.invoke()
        self.assertEqual(
            self.path.read_text(),
            "extraargs=quiet " + TOKEN + " cma=256M\n",
        )

    def test_rejects_empty_and_real_blacklist_tokens_without_mutation(self):
        original = b"extraargs=initcall_blacklist= initcall_blacklist=old\n"
        self.path.write_bytes(original)
        result = self.invoke(ok=False)
        self.assertIn("ambiguous", result.stderr)
        self.assertEqual(self.path.read_bytes(), original)

    def test_preserves_quoted_real_blacklist_value(self):
        self.path.write_text('extraargs=quiet initcall_blacklist="old_init" cma=256M\n')
        self.invoke()
        self.assertEqual(
            self.path.read_text(),
            'extraargs=quiet initcall_blacklist="old_init,rkisp_clr_unready_dev" cma=256M\n',
        )

    def test_check_detects_missing_then_accepts_result(self):
        self.path.write_text("verbosity=1\n")
        original = self.path.read_bytes()
        self.invoke("--check", ok=False)
        self.assertEqual(self.path.read_bytes(), original)
        self.invoke()
        self.invoke("--check")

    def test_single_quotes_do_not_hide_literal_kernel_value_characters(self):
        original = "extraargs=initcall_blacklist='rkisp_clr_unready_dev'\n"
        self.path.write_text(original)
        self.invoke('--check', ok=False)
        self.invoke()
        self.assertEqual(self.path.read_text(),
                         original.rstrip('\n') + ',rkisp_clr_unready_dev\n')
        self.invoke('--check')

    def test_backslashes_are_literal_to_the_kernel(self):
        original = 'extraargs=initcall_blacklist=rkisp\\_clr_unready_dev\n'
        self.path.write_text(original)
        self.invoke('--check', ok=False)
        self.invoke()
        self.assertEqual(self.path.read_text(),
                         original.rstrip('\n') + ',rkisp_clr_unready_dev\n')

    def test_refuses_arguments_after_kernel_parameter_terminator(self):
        original = ('extraargs=-- ' + TOKEN + '\n').encode()
        self.path.write_bytes(original)
        self.invoke('--check', ok=False)
        self.invoke(ok=False)
        self.assertEqual(self.path.read_bytes(), original)

    def test_rejects_duplicate_extraargs_without_mutation(self):
        original = b"extraargs=quiet\nextraargs=console=tty1\n"
        self.path.write_bytes(original)
        result = self.invoke(ok=False)
        self.assertIn("ambiguous", result.stderr)
        self.assertEqual(self.path.read_bytes(), original)

    def test_check_rejects_multiple_blacklist_tokens_without_mutation(self):
        original = b"extraargs=initcall_blacklist=old initcall_blacklist=other\n"
        self.path.write_bytes(original)
        result = self.invoke("--check", ok=False)
        self.assertIn("ambiguous", result.stderr)
        self.assertEqual(self.path.read_bytes(), original)

    def test_preserves_permissions_and_replaces_file_atomically(self):
        self.path.write_text("extraargs=quiet\n")
        self.path.chmod(0o640)
        before_inode = self.path.stat().st_ino
        self.invoke()
        stat = self.path.stat()
        self.assertEqual(stat.st_mode & 0o777, 0o640)
        self.assertNotEqual(stat.st_ino, before_inode)
        self.assertIn(TOKEN, self.path.read_text())


if __name__ == "__main__":
    unittest.main()
