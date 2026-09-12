#!/usr/bin/env python3
"""Read-only, bounded inspection of a hash-pinned compressed base image."""
import argparse
import hashlib
import json
import lzma
import pathlib
import struct
import sys
import uuid
import zlib


MAX_COMPRESSED_BYTES = 4 * 1024 ** 3
MAX_UNCOMPRESSED_BYTES = 16 * 1024 ** 3
MAX_XZ_MEMORY_BYTES = 128 * 1024 ** 2
SECTOR_BYTES = 512
EXT4_SUPERBLOCK_BYTES = 1024
TARGETS = ("rpi", "radxa-zero3w", "radxa-rock5c")


class InspectionError(Exception):
    pass


def _sha256(source):
    digest = hashlib.sha256()
    total = 0
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        total += len(chunk)
        if total > MAX_COMPRESSED_BYTES:
            raise InspectionError("compressed image exceeds inspection limit")
        digest.update(chunk)
    return digest.hexdigest()


def _read_lock(lock_path, target):
    try:
        lock = json.loads(pathlib.Path(lock_path).read_text(encoding="utf-8"))
        expected = lock["targets"][target]["sha256"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise InspectionError("invalid base lock") from error
    if not isinstance(expected, str) or len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
        raise InspectionError("invalid locked compressed SHA256")
    return expected


def _mbr_partitions(mbr):
    if len(mbr) < SECTOR_BYTES or mbr[510:512] != b"\x55\xaa":
        raise InspectionError("missing or malformed MBR signature")
    entries = []
    for number in range(4):
        data = mbr[446 + number * 16:462 + number * 16]
        kind = data[4]
        start, sectors = struct.unpack_from("<II", data, 8)
        if kind == 0xEE:
            raise InspectionError("GPT partition tables are unsupported")
        if kind in (0x05, 0x0F, 0x85):
            raise InspectionError("extended MBR partitions are unsupported without EBR traversal")
        if not kind and not start and not sectors:
            continue
        if not kind or not start or not sectors:
            raise InspectionError("malformed MBR partition entry")
        entries.append({"number": number + 1, "type": "0x%02x" % kind,
                        "startSector": start, "sectorCount": sectors,
                        "offset": start * SECTOR_BYTES,
                        "length": sectors * SECTOR_BYTES})
    return entries


def _gpt_header(data, expected_lba):
    if len(data) < 512 or data[:8] != b"EFI PART":
        raise InspectionError("missing GPT header")
    fields = struct.unpack_from("<8sIIIIQQQQ16sQIII", data)
    _, revision, size, crc, reserved, current, backup, first, last, guid, table, count, entry_size, table_crc = fields
    if revision != 0x10000 or not 92 <= size <= 512 or reserved or current != expected_lba:
        raise InspectionError("invalid GPT header fields")
    header = bytearray(data[:size]); header[16:20] = b"\0" * 4
    if zlib.crc32(header) != crc:
        raise InspectionError("GPT header CRC mismatch")
    if not 0 < count <= 4096 or entry_size < 128 or entry_size % 128 or count * entry_size > 1024 * 1024:
        raise InspectionError("GPT entry table exceeds inspection limit")
    if not 2 <= first <= last or not backup or not table:
        raise InspectionError("invalid GPT usable range")
    return dict(current=current, backup=backup, first=first, last=last, guid=guid,
                table=table, count=count, entry_size=entry_size, table_crc=table_crc)


def _gpt_partitions(prefix):
    header = _gpt_header(prefix[512:1024], 1)
    size = header["count"] * header["entry_size"]
    start = header["table"] * 512
    if start < 1024 or start + size > header["first"] * 512 or start + size > 2 * 1024 * 1024:
        raise InspectionError("unsupported GPT primary table placement")
    if len(prefix) < start + size:
        return None, header, None
    entries = bytes(prefix[start:start + size])
    if zlib.crc32(entries) != header["table_crc"]:
        raise InspectionError("GPT entry table CRC mismatch")
    if header["backup"] <= header["last"]:
        raise InspectionError("GPT backup overlaps usable range")
    partitions = []
    seen_guids = set()
    for index in range(header["count"]):
        entry = entries[index * header["entry_size"]:(index + 1) * header["entry_size"]]
        if entry[:16] == bytes(16):
            continue
        first, last, attributes = struct.unpack_from("<QQQ", entry, 32)
        if first < header["first"] or last > header["last"] or first > last:
            raise InspectionError("GPT partition outside usable range")
        guid = str(uuid.UUID(bytes_le=entry[16:32]))
        if entry[16:32] == bytes(16) or guid in seen_guids:
            raise InspectionError("invalid or duplicate GPT partition UUID")
        seen_guids.add(guid)
        partitions.append({"number": index + 1, "typeGuid": str(uuid.UUID(bytes_le=entry[:16])),
                           "partitionUuid": guid, "startSector": first, "sectorCount": last - first + 1,
                           "attributes": hex(attributes), "offset": first * 512, "length": (last - first + 1) * 512})
    if not partitions:
        raise InspectionError("GPT contains no partitions")
    return partitions, header, entries


def _verify_gpt_backup(header, entries, collected, total):
    start, finish, data = collected
    if finish != total or len(data) != finish - start:
        raise InspectionError("GPT backup does not end at image boundary")
    backup = _gpt_header(data[-512:], header["backup"])
    if backup["backup"] != 1 or any(backup[k] != header[k] for k in ["first", "last", "guid", "count", "entry_size", "table_crc"]):
        raise InspectionError("GPT backup header disagrees with primary")
    table_start = backup["table"] * 512
    table_end = table_start + len(entries)
    if table_start < start or table_start <= header["last"] * 512 or table_end > header["backup"] * 512:
        raise InspectionError("unsupported GPT backup table placement")
    backup_entries = bytes(data[table_start - start:table_end - start])
    if backup_entries != entries or zlib.crc32(backup_entries) != backup["table_crc"]:
        raise InspectionError("GPT backup entry table mismatch")


def _uuid(value):
    text = value.hex()
    return "%s-%s-%s-%s-%s" % (text[:8], text[8:12], text[12:16], text[16:20], text[20:])


def _ext_filesystem(partition, superblock):
    if len(superblock) != EXT4_SUPERBLOCK_BYTES or struct.unpack_from("<H", superblock, 0x38)[0] != 0xEF53:
        return None
    log_block_size = struct.unpack_from("<I", superblock, 0x18)[0]
    if log_block_size > 6:
        raise InspectionError("invalid ext4 block size")
    compatible = struct.unpack_from("<I", superblock, 0x5C)[0]
    incompat = struct.unpack_from("<I", superblock, 0x60)[0]
    blocks = struct.unpack_from("<I", superblock, 0x04)[0]
    if incompat & 0x80:
        blocks |= struct.unpack_from("<I", superblock, 0x150)[0] << 32
    block_size = 1024 << log_block_size
    if not blocks:
        raise InspectionError("ext filesystem has zero blocks")
    if blocks * block_size > partition["length"]:
        raise InspectionError("ext filesystem is larger than partition")
    # The magic predates ext4. Extents identify ext4; a journal without extents is ext3.
    filesystem_type = "ext4" if incompat & 0x40 else "ext3" if compatible & 0x04 else "ext2"
    return {
        "type": filesystem_type,
        "uuid": _uuid(superblock[0x68:0x78]),
        "blockSize": block_size,
        "blockCount": blocks,
        "features": {
            "compatible": "0x%08x" % compatible,
            "incompatible": "0x%08x" % incompat,
            "readOnlyCompatible": "0x%08x" % struct.unpack_from("<I", superblock, 0x64)[0],
        },
        "defaultMountOptions": "0x%08x" % struct.unpack_from("<I", superblock, 0x100)[0],
    }


class _RangeCollector:
    def __init__(self, partitions):
        self.ranges = {
            p["number"]: (p["offset"] + 1024, p["offset"] + 2048, bytearray())
            for p in partitions if p["length"] >= 2048
        }

    def feed(self, offset, chunk):
        end = offset + len(chunk)
        for _, (start, finish, collected) in self.ranges.items():
            left, right = max(offset, start), min(end, finish)
            if left < right:
                expected = left - start
                if len(collected) != expected:
                    raise InspectionError("unable to collect partition superblock")
                collected.extend(chunk[left - offset:right - offset])


def _decompressed_chunks(source, compressed_digest):
    """Yield bounded output chunks while limiting XZ dictionary memory."""
    def decoder():
        return lzma.LZMADecompressor(format=lzma.FORMAT_XZ, memlimit=MAX_XZ_MEMORY_BYTES)

    try:
        compressed_bytes = 0
        current = decoder()
        pending = b""
        member_started = False
        while True:
            if current.needs_input:
                data = pending
                if not data:
                    data = source.read(1024 * 1024)
                    compressed_bytes += len(data)
                    if compressed_bytes > MAX_COMPRESSED_BYTES:
                        raise InspectionError("compressed image exceeds inspection limit")
                    compressed_digest.update(data)
                pending = b""
                if not data:
                    if not member_started or current.eof:
                        return
                    raise InspectionError("truncated or malformed XZ image")
                member_started = True
            else:
                data = b""
            output = current.decompress(data, max_length=1024 * 1024)
            if output:
                yield output
            if current.eof:
                pending = current.unused_data
                current = decoder()
                member_started = False
    except (lzma.LZMAError, EOFError, MemoryError) as error:
        raise InspectionError("truncated, malformed, or over-memory-limit XZ image") from error


def inspect_image(target, image_path, lock_path=None, *, max_uncompressed_bytes=MAX_UNCOMPRESSED_BYTES):
    """Return a shareable report. `lock_path` is injectable for fixture tests."""
    if target not in TARGETS:
        raise InspectionError("unknown image target")
    if max_uncompressed_bytes <= 0:
        raise InspectionError("invalid decompression limit")
    image_path = pathlib.Path(image_path)
    lock_path = pathlib.Path(lock_path) if lock_path else pathlib.Path(__file__).with_name("bases.lock.json")
    expected_compressed = _read_lock(lock_path, target)
    with open(image_path, "rb") as source:
        return _inspect_open_image(target, image_path, source, expected_compressed, max_uncompressed_bytes)


def _inspect_open_image(target, image_path, source, expected_compressed, max_uncompressed_bytes):
    compressed_sha256 = _sha256(source)
    if compressed_sha256 != expected_compressed:
        raise InspectionError("compressed SHA256 mismatch")

    source.seek(0)
    second_compressed_hash = hashlib.sha256()
    raw_hash = hashlib.sha256()
    total = 0
    prefix = bytearray()
    partitions = None
    collector = None
    gpt_header = None
    gpt_entries = None
    table_kind = "mbr"
    protective_sectors = None
    for chunk in _decompressed_chunks(source, second_compressed_hash):
        if total + len(chunk) > max_uncompressed_bytes:
            raise InspectionError("uncompressed image exceeds inspection limit")
        raw_hash.update(chunk)
        if partitions is None:
            prefix.extend(chunk)
            if len(prefix) >= 1024:
                protective = any(prefix[446 + i * 16 + 4] == 0xEE for i in range(4))
                if protective or prefix[512:520] == b"EFI PART":
                    if not protective or prefix[510:512] != b"\x55\xaa":
                        raise InspectionError("GPT is missing protective MBR")
                    if any(prefix[446 + i * 16 + 4] not in (0, 0xEE) for i in range(4)):
                        raise InspectionError("hybrid GPT/MBR is unsupported")
                    protective_entries = [prefix[446 + i * 16:462 + i * 16] for i in range(4) if prefix[446 + i * 16 + 4] == 0xEE]
                    if len(protective_entries) != 1:
                        raise InspectionError("GPT requires exactly one protective MBR entry")
                    protective_start, protective_sectors = struct.unpack_from("<II", protective_entries[0], 8)
                    if protective_start != 1 or not protective_sectors:
                        raise InspectionError("invalid protective MBR range")
                    table_kind = "gpt"
                    partitions, gpt_header, gpt_entries = _gpt_partitions(prefix)
                else:
                    partitions = _mbr_partitions(prefix[:512])
                    if not partitions:
                        raise InspectionError("MBR contains no partitions")
                if partitions is not None:
                    collector = _RangeCollector(partitions)
                    if gpt_header:
                        finish = (gpt_header["backup"] + 1) * 512
                        if finish > max_uncompressed_bytes:
                            raise InspectionError("GPT backup exceeds inspection limit")
                        collector.ranges["gpt_backup"] = (max(0, finish - 2 * 1024 * 1024), finish, bytearray())
                    collector.feed(0, prefix)
                    prefix.clear()
            if len(prefix) > 2 * 1024 * 1024:
                raise InspectionError("partition table exceeds inspection prefix limit")
        else:
            collector.feed(total, chunk)
        total += len(chunk)
    if second_compressed_hash.hexdigest() != expected_compressed:
        raise InspectionError("compressed image changed during inspection")
    if partitions is None:
        raise InspectionError("image is too small for a complete partition table")
    if gpt_header:
        if protective_sectors != min(total // 512 - 1, 0xFFFFFFFF):
            raise InspectionError("protective MBR does not cover image")
        _verify_gpt_backup(gpt_header, gpt_entries, collector.ranges["gpt_backup"], total)
    for partition in partitions:
        if partition["offset"] + partition["length"] > total:
            raise InspectionError("partition lies outside image")
    ordered = sorted(partitions, key=lambda item: item["offset"])
    for earlier, later in zip(ordered, ordered[1:]):
        if earlier["offset"] + earlier["length"] > later["offset"]:
            raise InspectionError("partitions overlap")
    for partition in partitions:
        collected_range = collector.ranges.get(partition["number"])
        if collected_range:
            start, finish, collected = collected_range
            if finish > total:
                raise InspectionError("partition superblock lies outside image")
            filesystem = _ext_filesystem(partition, bytes(collected))
            if filesystem:
                partition["filesystem"] = filesystem
        del partition["offset"], partition["length"]
    return {
        "schemaVersion": 1,
        "target": target,
        "imageFileName": image_path.name,
        "compressedSha256": compressed_sha256,
        "rawSha256": raw_hash.hexdigest(),
        "uncompressedBytes": total,
        "partitionTable": table_kind,
        "partitions": partitions,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=TARGETS, required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args(argv)
    try:
        report = inspect_image(args.target, args.image)
    except (InspectionError, OSError) as error:
        message = str(error) if isinstance(error, InspectionError) else "unable to read image or base lock"
        print(json.dumps({"schemaVersion": 1, "error": message}, sort_keys=True))
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
