# SPDX-License-Identifier: GPL-3.0-or-later
import hashlib, io, tempfile, pathlib, unittest
from download import store_checked
class DownloadTests(unittest.TestCase):
 def test_changed_and_oversized_source_never_replaces_output(self):
  with tempfile.TemporaryDirectory() as root:
   path=pathlib.Path(root)/'source'
   with self.assertRaises(ValueError):store_checked(io.BytesIO(b'oversize'),path,3,hashlib.sha256(b'abc').hexdigest())
   self.assertFalse(path.exists())
   with self.assertRaises(ValueError):store_checked(io.BytesIO(b'bad'),path,3,hashlib.sha256(b'abc').hexdigest())
   self.assertFalse(path.exists())
   store_checked(io.BytesIO(b'abc'),path,3,hashlib.sha256(b'abc').hexdigest())
   self.assertEqual(path.read_bytes(),b'abc')
if __name__=='__main__':unittest.main()
