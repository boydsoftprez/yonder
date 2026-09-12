"""Focused fixtures for the read-only compressed base-image inspector."""
import hashlib
import importlib.util
import json
import lzma
import pathlib
import subprocess
import struct
import tempfile
import unittest
from unittest.mock import patch
import uuid
import zlib


SCRIPT = pathlib.Path(__file__).with_name("inspect-base.py")
SPEC = importlib.util.spec_from_file_location("inspect_base", SCRIPT)
inspect_base = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inspect_base)


def ext4_superblock(*, uuid=bytes.fromhex("00112233445566778899aabbccddeeff")):
    sb = bytearray(1024)
    struct.pack_into("<I", sb, 0x00, 123)  # inodes
    struct.pack_into("<I", sb, 0x04, 4)  # low blocks
    struct.pack_into("<I", sb, 0x18, 2)  # 4096-byte blocks
    struct.pack_into("<H", sb, 0x38, 0xEF53)
    struct.pack_into("<I", sb, 0x5C, 0x04)  # has journal
    struct.pack_into("<I", sb, 0x60, 0x42)  # extents + filetype
    struct.pack_into("<I", sb, 0x64, 0x01)  # sparse super
    sb[0x68:0x78] = uuid
    struct.pack_into("<I", sb, 0x100, 0x0C)  # acl + user_xattr
    return sb


def mbr_image(*, partitions=((2048, 32, 0x83),), total_sectors=4096, ext4=True):
    raw = bytearray(total_sectors * 512)
    for index, (start, count, kind) in enumerate(partitions):
        entry = 446 + index * 16
        raw[entry + 4] = kind
        struct.pack_into("<II", raw, entry + 8, start, count)
    raw[510:512] = b"\x55\xaa"
    if ext4:
        first = partitions[0][0] * 512
        raw[first + 1024:first + 2048] = ext4_superblock()
    return bytes(raw)


def gpt_image(*, overlap=False):
    sectors = 4096
    raw = bytearray(mbr_image(partitions=((1, sectors - 1, 0xEE),), total_sectors=sectors, ext4=False))
    entries = bytearray(128 * 128)
    for index in range(2 if overlap else 1):
        offset = index * 128
        entries[offset:offset+16] = uuid.UUID("0fc63daf-8483-4772-8e79-3d69d8477de4").bytes_le
        entries[offset+16:offset+32] = uuid.UUID(int=index+1).bytes_le
        struct.pack_into("<QQQ", entries, offset+32, 2048, 2079, 0)
    for where in [2, sectors-33]: raw[where*512:where*512+len(entries)] = entries
    for where, alternate, table in [(1, sectors-1, 2), (sectors-1, 1, sectors-33)]:
        header = bytearray(512)
        struct.pack_into("<8sIIIIQQQQ16sQIII", header, 0, b"EFI PART", 0x10000, 92, 0, 0,
                         where, alternate, 2048, sectors-34, uuid.UUID(int=20).bytes_le,
                         table, 128, 128, zlib.crc32(entries))
        struct.pack_into("<I", header, 16, zlib.crc32(header[:92]))
        raw[where*512:(where+1)*512] = header
    raw[2048*512+1024:2048*512+2048] = ext4_superblock()
    return bytes(raw)


class InspectBaseTests(unittest.TestCase):
    def write_xz(self, directory, raw):
        path = pathlib.Path(directory) / "fixture.img.xz"
        path.write_bytes(lzma.compress(raw))
        return path

    def lock_for(self, directory, image, digest=None):
        path = pathlib.Path(directory) / "bases.lock.json"
        path.write_text(json.dumps({"schemaVersion": 1, "targets": {
            "rpi": {"fileName": image.name, "sha256": digest or hashlib.sha256(image.read_bytes()).hexdigest()}
        }}))
        return path

    def test_hash_and_inspection_share_open_file_and_recheck_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            image = self.write_xz(directory, mbr_image())
            lock = self.lock_for(directory, image)
            original_hash = inspect_base._sha256
            def replace_path(source):
                digest = original_hash(source)
                image.unlink()
                image.write_bytes(b"different pathname contents")
                return digest
            with patch.object(inspect_base, "_sha256", replace_path):
                self.assertEqual(inspect_base.inspect_image("rpi", image, lock)["partitionTable"], "mbr")
            image = self.write_xz(directory, mbr_image())
            def change_open_file(source):
                digest = original_hash(source)
                image.write_bytes(lzma.compress(mbr_image(partitions=((2048, 33, 0x83),))))
                return digest
            with patch.object(inspect_base, "_sha256", change_open_file):
                with self.assertRaisesRegex(inspect_base.InspectionError, "changed during inspection"):
                    inspect_base.inspect_image("rpi", image, lock)

    def test_compressed_size_is_bounded_before_checksum_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            image = self.write_xz(directory, mbr_image())
            lock = self.lock_for(directory, image)
            with patch.object(inspect_base, "MAX_COMPRESSED_BYTES", 1):
                with self.assertRaisesRegex(inspect_base.InspectionError, "compressed image exceeds"):
                    inspect_base.inspect_image("rpi", image, lock)

    def test_gpt_rejects_invalid_protective_mbr(self):
        for mode in ["duplicate", "zero", "start", "coverage"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                raw = bytearray(gpt_image())
                if mode == "duplicate":
                    raw[462:478] = raw[446:462]
                else:
                    struct.pack_into("<II", raw, 454, 2 if mode == "start" else 1, 0 if mode == "zero" else 100)
                image = self.write_xz(directory, raw)
                with self.assertRaisesRegex(inspect_base.InspectionError, "protective MBR"):
                    inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))

    def test_gpt_primary_backup_and_ext4(self):
        with tempfile.TemporaryDirectory() as directory:
            image = self.write_xz(directory, gpt_image())
            result = inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))
            self.assertEqual(result["partitionTable"], "gpt")
            self.assertEqual(result["partitions"][0]["startSector"], 2048)
            self.assertEqual(result["partitions"][0]["filesystem"]["type"], "ext4")

    def test_gpt_rejects_metadata_corruption_truncated_backup_and_overlap(self):
        raw = gpt_image()
        cases = []
        for offset in [512+16, 2*512, len(raw)-512+16, len(raw)-33*512]:
            changed = bytearray(raw); changed[offset] ^= 1; cases.append(changed)
        cases.extend([raw[:-512], gpt_image(overlap=True)])
        for corrupted in cases:
            with self.subTest(), tempfile.TemporaryDirectory() as directory:
                image = self.write_xz(directory, corrupted)
                with self.assertRaises(inspect_base.InspectionError):
                    inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))

    def test_gpt_rejects_huge_entry_table_before_collecting(self):
        raw = bytearray(gpt_image())
        struct.pack_into("<I", raw, 512+80, 0xffffffff)
        struct.pack_into("<I", raw, 512+16, 0)
        struct.pack_into("<I", raw, 512+16, zlib.crc32(raw[512:604]))
        with tempfile.TemporaryDirectory() as directory:
            image = self.write_xz(directory, raw)
            with self.assertRaisesRegex(inspect_base.InspectionError, "table exceeds"):
                inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))

    def test_reports_mbr_ext4_and_digests_without_source_path(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = mbr_image()
            image = self.write_xz(directory, raw)
            result = inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))
        self.assertEqual(result["partitionTable"], "mbr")
        self.assertEqual(result["uncompressedBytes"], len(raw))
        self.assertEqual(result["rawSha256"], hashlib.sha256(raw).hexdigest())
        partition = result["partitions"][0]
        self.assertEqual(partition["filesystem"]["type"], "ext4")
        self.assertEqual(partition["filesystem"]["uuid"], "00112233-4455-6677-8899-aabbccddeeff")
        self.assertEqual(partition["filesystem"]["blockSize"], 4096)
        self.assertEqual(partition["filesystem"]["blockCount"], 4)
        self.assertNotIn(str(image), json.dumps(result))

    def test_rejects_truncated_and_out_of_bounds_mbr_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            image = self.write_xz(directory, mbr_image(partitions=((4000, 200, 0x83),)))
            lock = self.lock_for(directory, image)
            with self.assertRaisesRegex(inspect_base.InspectionError, "outside image"):
                inspect_base.inspect_image("rpi", image, lock)
            truncated = pathlib.Path(directory) / "truncated.img.xz"
            truncated.write_bytes(image.read_bytes()[:-8])
            self.lock_for(directory, truncated, hashlib.sha256(truncated.read_bytes()).hexdigest())
            with self.assertRaises(inspect_base.InspectionError):
                inspect_base.inspect_image("rpi", truncated, pathlib.Path(directory) / "bases.lock.json")

    def test_rejects_overlapping_mbr_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            image = self.write_xz(directory, mbr_image(partitions=((2048, 32, 0x83), (2060, 32, 0x83))))
            with self.assertRaisesRegex(inspect_base.InspectionError, "overlap"):
                inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))

    def test_rejects_extended_mbr_without_ebr_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            image = self.write_xz(directory, mbr_image(partitions=((2048, 32, 0x0F),)))
            with self.assertRaisesRegex(inspect_base.InspectionError, "extended MBR"):
                inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))

    def test_rejects_ext_superblock_larger_than_partition(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = bytearray(mbr_image(partitions=((2048, 32, 0x83),)))
            struct.pack_into("<I", raw, 2048 * 512 + 1024 + 4, 999999)
            image = self.write_xz(directory, bytes(raw))
            with self.assertRaisesRegex(inspect_base.InspectionError, "larger than partition"):
                inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))

    def test_does_not_report_ext2_magic_as_ext4(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = bytearray(mbr_image())
            # A zero feature set is compatible with ext2 and has the shared ext magic.
            start = 2048 * 512 + 1024
            struct.pack_into("<I", raw, start + 0x5C, 0)
            struct.pack_into("<I", raw, start + 0x60, 0)
            image = self.write_xz(directory, bytes(raw))
            result = inspect_base.inspect_image("rpi", image, self.lock_for(directory, image))
            self.assertEqual(result["partitions"][0]["filesystem"]["type"], "ext2")

    def test_rejects_decompression_over_limit_and_hash_before_parsing(self):
        with tempfile.TemporaryDirectory() as directory:
            image = self.write_xz(directory, mbr_image())
            lock = self.lock_for(directory, image)
            with self.assertRaisesRegex(inspect_base.InspectionError, "limit"):
                inspect_base.inspect_image("rpi", image, lock, max_uncompressed_bytes=1024)
            malformed = pathlib.Path(directory) / "not-an-image.img.xz"
            malformed.write_bytes(b"not xz")
            bad_lock = self.lock_for(directory, malformed, "0" * 64)
            with self.assertRaisesRegex(inspect_base.InspectionError, "compressed SHA256 mismatch"):
                inspect_base.inspect_image("rpi", malformed, bad_lock)

    def test_cli_reports_missing_image_as_json_without_its_path(self):
        missing = "/private/unshared/missing-base.img.xz"
        process = subprocess.run(
            ["python3", str(SCRIPT), "--target", "rpi", "--image", missing],
            check=False, capture_output=True, text=True,
        )
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(process.stdout)["error"], "unable to read image or base lock")
        self.assertNotIn(missing, process.stdout)


if __name__ == "__main__":
    unittest.main()
