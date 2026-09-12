#!/usr/bin/env python3
"""Validate the booted legacy U-Boot image payload against the inspected initrd."""
import pathlib
import struct
import sys
import zlib


def payload(path, expected_type):
    data = pathlib.Path(path).read_bytes()
    if len(data) < 64:
        raise ValueError("truncated U-Boot image")
    magic, header_crc, _, size, _, _, data_crc = struct.unpack(">7I", data[:28])
    header = data[:4] + bytes(4) + data[8:64]
    body = data[64:]
    if (magic != 0x27051956 or zlib.crc32(header) != header_crc
            or len(body) != size or zlib.crc32(body) != data_crc
            or data[30] != expected_type):
        raise ValueError("invalid U-Boot image header, payload, CRC or type")
    return body


def verify(wrapper, initrd, boot_script):
    if payload(wrapper, 3) != pathlib.Path(initrd).read_bytes():
        raise ValueError("uInitrd does not wrap the inspected initrd")
    script = payload(boot_script, 6)
    if b"uInitrd" not in script or b"Image" not in script:
        raise ValueError("boot script does not name the expected image paths")


if __name__ == "__main__":
    verify(*sys.argv[1:])
    print("PASS: U-Boot wrapper exactly matches verified initrd; boot script names Image/uInitrd")
