#!/bin/bash
# Grow only partition 2 of an inspected Raspberry Pi DOS image.
set -euo pipefail

usage() {
    printf '%s\n' 'Usage: layout.sh IMAGE NEW_BYTES MBR_ID BOOT_START BOOT_COUNT BOOT_TYPE ROOT_START ROOT_COUNT ROOT_TYPE' >&2
    exit 2
}

[[ $# == 9 ]] || usage
image=$1
new_bytes=$2
mbr_id=$3
boot_start=$4
boot_count=$5
boot_type=$6
root_start=$7
root_count=$8
root_type=$9

[[ -f $image && ! -L $image ]] || usage
for value in "$new_bytes" "$boot_start" "$boot_count" "$root_start" "$root_count"; do
    [[ $value =~ ^[0-9]+$ ]] || usage
done
[[ $mbr_id =~ ^0x[0-9a-f]{8}$ && $boot_type =~ ^0x[0-9a-f]{2}$ \
    && $root_type =~ ^0x[0-9a-f]{2}$ ]] || usage
(( new_bytes % 512 == 0 )) || usage

python3 -I - "$image" "$new_bytes" "$mbr_id" "$boot_start" "$boot_count" \
        "$boot_type" "$root_start" "$root_count" "$root_type" <<'PY'
import os
import struct
import sys

path = sys.argv[1]
new_bytes, boot_start, boot_count, root_start, root_count = map(
    int, (sys.argv[2], sys.argv[4], sys.argv[5], sys.argv[7], sys.argv[8]))
mbr_id, boot_type, root_type = map(
    lambda value: int(value, 16), (sys.argv[3], sys.argv[6], sys.argv[9]))

old_bytes = os.stat(path).st_size
if old_bytes != (root_start + root_count) * 512:
    raise SystemExit('image length does not match the inspected root partition end')
if new_bytes <= old_bytes or new_bytes % 512:
    raise SystemExit('new image length must be a larger whole number of sectors')
new_root_count = new_bytes // 512 - root_start
if new_root_count > 0xffffffff:
    raise SystemExit('grown root partition exceeds the DOS partition size field')

with open(path, 'r+b') as stream:
    mbr = bytearray(stream.read(512))
    if len(mbr) != 512 or mbr[510:512] != b'\x55\xaa':
        raise SystemExit('image has no valid DOS boot signature')
    if struct.unpack_from('<I', mbr, 440)[0] != mbr_id:
        raise SystemExit('image DOS identifier does not match inspected input')

    facts = []
    for index in range(4):
        offset = 446 + index * 16
        facts.append((mbr[offset + 4], *struct.unpack_from('<II', mbr, offset + 8)))
    if facts[0] != (boot_type, boot_start, boot_count):
        raise SystemExit('boot partition does not match inspected input')
    if facts[1] != (root_type, root_start, root_count):
        raise SystemExit('root partition does not match inspected input')
    if any(kind or start or count for kind, start, count in facts[2:]):
        raise SystemExit('unexpected additional DOS partition')
    if boot_start + boot_count > root_start:
        raise SystemExit('inspected boot and root partitions overlap')

    original = bytes(mbr)
    struct.pack_into('<I', mbr, 446 + 16 + 12, new_root_count)
    changed = [index for index, pair in enumerate(zip(original, mbr)) if pair[0] != pair[1]]
    if any(index < 474 or index > 477 for index in changed):
        raise SystemExit('partition growth changed bytes outside the root size field')
    stream.seek(0)
    stream.write(mbr)
    stream.flush()
    os.fsync(stream.fileno())
    stream.truncate(new_bytes)

print(new_root_count)
PY
