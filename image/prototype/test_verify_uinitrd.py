import pathlib
import struct
import tempfile
import unittest
import zlib

from verify_uinitrd import verify


def wrapped(body, kind):
    header = bytearray(64)
    struct.pack_into('>7I', header, 0, 0x27051956, 0, 0, len(body), 0, 0, zlib.crc32(body))
    header[30] = kind
    struct.pack_into('>I', header, 4, zlib.crc32(header))
    return bytes(header) + body


class VerifyBootImage(unittest.TestCase):
    def test_rejects_stale_corrupt_wrong_type_and_wrong_boot_script(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            initrd, wrapper, script = (root / name for name in ('initrd', 'uInitrd', 'boot.scr'))
            initrd.write_bytes(b'current verified initramfs')
            wrapper.write_bytes(wrapped(initrd.read_bytes(), 3))
            script.write_bytes(wrapped(b'load Image; load uInitrd;', 6))
            verify(wrapper, initrd, script)
            for invalid in (wrapped(b'stale initramfs', 3), b'', wrapped(initrd.read_bytes(), 6),
                            wrapped(initrd.read_bytes(), 3)[:-1],
                            wrapped(initrd.read_bytes(), 3) + b'extra'):
                wrapper.write_bytes(invalid)
                with self.assertRaises(ValueError):
                    verify(wrapper, initrd, script)
            wrapper.write_bytes(wrapped(initrd.read_bytes(), 3))
            script.write_bytes(wrapped(b'load old-initrd;', 6))
            with self.assertRaises(ValueError):
                verify(wrapper, initrd, script)


if __name__ == '__main__':
    unittest.main()
