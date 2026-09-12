#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Convert only a verified locked Pi base copy to the bounded MBR prototype.
set -euo pipefail
umask 077

usage() {
    printf '%s\n' 'Usage: assemble-layout.sh IMAGE EXPECTED_RAW_SHA256' >&2
    exit 2
}

[[ $# == 2 ]] || usage
image=$1
expected_sha=$2
[[ -f $image && ! -L $image && $expected_sha =~ ^[a-f0-9]{64}$ ]] || usage
[[ $(uname -m) == aarch64 && -f /.dockerenv ]]
for tool in blkid cc dosfsck e2fsck losetup mkfs.ext4 mount resize2fs \
        sha256sum tune2fs umount; do
    command -v "$tool" >/dev/null
done

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
tmp=$(mktemp -d)
mounted_root=$tmp/root
mkdir "$mounted_root"
cleanup() {
    mountpoint -q "$mounted_root" && umount "$mounted_root" || true
    while IFS=: read -r loop _; do
        [[ -n $loop ]] && losetup -d "$loop" 2>/dev/null || true
    done <<<"$(losetup --associated "$image" 2>/dev/null || true)"
    rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

printf '%s  %s\n' "$expected_sha" "$image" | sha256sum -c -
[[ $(stat -c %s "$image") == 2977955840 ]]

boot_loop=$(losetup --find --show --offset $((16384 * 512)) \
    --sizelimit $((1048576 * 512)) "$image")
root_loop=$(losetup --find --show --offset $((1064960 * 512)) \
    --sizelimit $((4751360 * 512)) "$image")
[[ $(blkid -s UUID -o value "$boot_loop") == B2F0-82D2 ]]
[[ $(blkid -s TYPE -o value "$boot_loop") == vfat ]]
[[ $(blkid -s UUID -o value "$root_loop") == 15f4c6be-1102-4331-9904-f78e78afd1fd ]]
[[ $(blkid -s TYPE -o value "$root_loop") == ext4 ]]
losetup -d "$boot_loop" "$root_loop"

cc -std=c11 -O2 -Wall -Wextra -Werror -static "$here/mbr-layout.c" \
    -o "$tmp/yonder-pi-mbr-layout"
"$tmp/yonder-pi-mbr-layout" assemble "$image"

boot_loop=$(losetup --find --show --offset $((16384 * 512)) \
    --sizelimit $((1048576 * 512)) "$image")
root_loop=$(losetup --find --show --offset $((1064960 * 512)) \
    --sizelimit $((12582912 * 512)) "$image")
state_loop=$(losetup --find --show --offset $((13647872 * 512)) \
    --sizelimit $((1048576 * 512)) "$image")
log_loop=$(losetup --find --show --offset $((14698496 * 512)) \
    --sizelimit $((524288 * 512)) "$image")
media_loop=$(losetup --find --show --offset $((15224832 * 512)) \
    --sizelimit $((1552384 * 512)) "$image")

set +e
e2fsck -fy "$root_loop"
fsck_status=$?
set -e
[[ $fsck_status -le 1 ]]
resize2fs "$root_loop" >/dev/null

mkfs.ext4 -q -F -L yonder-state \
    -U 1b09abf7-4d55-4ec3-b480-0e503f6ad440 "$state_loop"
mkfs.ext4 -q -F -L yonder-log \
    -U 80305cc3-c18e-4d6c-b14d-22f78a536c40 "$log_loop"
mkfs.ext4 -q -F -L yonder-media \
    -U e43b8b78-96ce-407a-817c-a36156158e6b "$media_loop"
for loop in "$state_loop" "$log_loop" "$media_loop"; do
    tune2fs -o journal_data_ordered "$loop" >/dev/null
done

mount "$root_loop" "$mounted_root"
install -d -m 0755 "$mounted_root/etc"
cat >"$mounted_root/etc/yonder-pi-storage-prototype.conf" <<'EOF'
MBR_DISK_ID=041bba91
BOOT_UUID=B2F0-82D2
ROOT_UUID=15f4c6be-1102-4331-9904-f78e78afd1fd
STATE_UUID=1b09abf7-4d55-4ec3-b480-0e503f6ad440
LOG_UUID=80305cc3-c18e-4d6c-b14d-22f78a536c40
MEDIA_UUID=e43b8b78-96ce-407a-817c-a36156158e6b
BOOT_START=16384
BOOT_SIZE=1048576
ROOT_START=1064960
ROOT_SIZE=12582912
STATE_START=13647872
STATE_SIZE=1048576
EXTENDED_START=14696448
EXTENDED_MIN_SIZE=2080768
LOG_START=14698496
LOG_SIZE=524288
SECOND_EBR=15222784
MEDIA_START=15224832
MEDIA_MIN_SIZE=1552384
EOF
chmod 0644 "$mounted_root/etc/yonder-pi-storage-prototype.conf"
sync
umount "$mounted_root"

for loop in "$root_loop" "$state_loop" "$log_loop" "$media_loop"; do
    e2fsck -fn "$loop" >/dev/null
done
dosfsck -n "$boot_loop" >/dev/null
losetup -d "$boot_loop" "$root_loop" "$state_loop" "$log_loop" "$media_loop"
sync -f "$image"

cleanup
trap - EXIT INT TERM
printf '%s\n' 'pi-storage-assembly: exact MBR prototype layout created'
