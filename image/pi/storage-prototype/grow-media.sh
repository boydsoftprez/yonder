#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Grow only Pi logical media partition 6 on the disk supplying mounted root.
set -eu

PATH=/usr/lib/yonder/initramfs-bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
LC_ALL=C
export LC_ALL

root=${1:?mounted root required}
[ "$root" != / ] && [ -d "$root/etc" ] || exit 2
config=$root/etc/yonder-storage-layout.conf
if [ -f "$config" ] && [ ! -L "$config" ]; then
    parser=/scripts/yonder-storage-layout
    [ -f "$parser" ] || parser=$root/usr/lib/yonder/storage/layout.sh
    # shellcheck disable=SC1090 # installed parser code, not layout data
    . "$parser"
    yonder_read_layout "$config" rpi || exit 1
else
    config=$root/etc/yonder-pi-storage-prototype.conf
    [ -f "$config" ] && [ ! -L "$config" ] || exit 2
    # The prototype assembler creates this immutable file.
    # shellcheck disable=SC1090
    . "$config"
fi

fail() {
    echo "Yonder Pi media growth: $*" >&2
    exit 1
}

number() {
    case "$1" in ''|*[!0-9]*) return 1 ;; esac
}

lower() {
    printf '%s' "$1" | tr 'A-F' 'a-f'
}

uuid() {
    value=$(lower "$1")
    printf '%s\n' "$value" |
        grep -Eq '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
}

[ "${MBR_DISK_ID:-}" = 041bba91 ] || fail 'invalid configured DOS identifier'
[ "${BOOT_UUID:-}" = B2F0-82D2 ] || fail 'invalid configured boot UUID'
for variable in ROOT_UUID STATE_UUID LOG_UUID MEDIA_UUID; do
    eval "value=\${$variable:-}"
    uuid "$value" || fail "invalid configured $variable"
done
for variable in BOOT_START BOOT_SIZE ROOT_START ROOT_SIZE STATE_START STATE_SIZE \
        EXTENDED_START EXTENDED_MIN_SIZE LOG_START LOG_SIZE SECOND_EBR \
        MEDIA_START MEDIA_MIN_SIZE; do
    eval "value=\${$variable:-}"
    number "$value" || fail "invalid configured $variable"
done
[ "$BOOT_START:$BOOT_SIZE:$ROOT_START:$ROOT_SIZE" = \
    16384:1048576:1064960:12582912 ] ||
    fail 'configured boot/root geometry differs from the prototype'
[ "$STATE_START:$STATE_SIZE:$EXTENDED_START:$EXTENDED_MIN_SIZE" = \
    13647872:1048576:14696448:2080768 ] ||
    fail 'configured state/extended geometry differs from the prototype'
[ "$LOG_START:$LOG_SIZE:$SECOND_EBR:$MEDIA_START:$MEDIA_MIN_SIZE" = \
    14698496:524288:15222784:15224832:1552384 ] ||
    fail 'configured logical geometry differs from the prototype'

root_device=$(findmnt -n -T "$root" -o SOURCE 2>/dev/null || true)
root_device=${root_device%%\[*}
root_device=$(readlink -f "$root_device" 2>/dev/null || true)
[ -b "$root_device" ] || fail 'mounted root did not resolve to a block device'
root_name=${root_device##*/}
[ -r "/sys/class/block/$root_name/partition" ] ||
    fail 'mounted root is not a partition'
[ "$(cat "/sys/class/block/$root_name/partition")" = 2 ] ||
    fail 'mounted root is not partition 2'
parent=$(lsblk -dn -o PKNAME "$root_device" 2>/dev/null || true)
[ -n "$parent" ] || fail 'cannot identify the disk supplying root'
disk=/dev/$parent
[ -b "$disk" ] || fail 'root parent is not a block device'
[ "$(blockdev --getss "$disk")" = 512 ] ||
    fail 'boot disk logical sector size is not 512 bytes'

partition_number() {
    name=${1##*/}
    [ -r "/sys/class/block/$name/partition" ] || return 1
    cat "/sys/class/block/$name/partition"
}

# Paths and TYPE fields contain no whitespace. Require the disk, its three
# primary data partitions, the extended container and exactly two logicals.
# shellcheck disable=SC2046
set -- $(lsblk -nrpo NAME,TYPE "$disk")
[ "$#" -eq 14 ] && [ "$1" = "$disk" ] || fail 'unexpected boot-disk child count'
case "$2" in disk|loop) ;; *) fail 'root parent has an unexpected device type' ;; esac
shift 2
boot_device=
state_device=
extended_device=
log_device=
media_device=
while [ "$#" -gt 0 ]; do
    [ "$2" = part ] || fail 'unexpected non-partition child on the boot disk'
    case "$(partition_number "$1")" in
        1) boot_device=$1 ;;
        2) [ "$1" = "$root_device" ] || fail 'root device path changed' ;;
        3) state_device=$1 ;;
        4) extended_device=$1 ;;
        5) log_device=$1 ;;
        6) media_device=$1 ;;
        *) fail 'unexpected partition number on the boot disk' ;;
    esac
    shift 2
done
for device in "$boot_device" "$state_device" "$extended_device" \
        "$log_device" "$media_device"; do
    [ -b "$device" ] || fail 'expected partition device is missing'
done
[ -z "$(findmnt -rn -S "$media_device" -o TARGET 2>/dev/null || true)" ] ||
    fail 'media partition is already mounted'

sysfs_value() {
    name=${1##*/}
    field=$2
    [ -r "/sys/class/block/$name/$field" ] || return 1
    cat "/sys/class/block/$name/$field"
}

check_fixed() {
    device=$1
    start=$2
    size=$3
    partuuid=$4
    [ "$(sysfs_value "$device" start)" = "$start" ] &&
        [ "$(sysfs_value "$device" size)" = "$size" ] &&
        [ "$(lower "$(blkid -s PARTUUID -o value "$device" 2>/dev/null || true)")" = "$partuuid" ]
}

check_fixed "$boot_device" "$BOOT_START" "$BOOT_SIZE" 041bba91-01 ||
    fail 'boot partition geometry or identity differs'
check_fixed "$root_device" "$ROOT_START" "$ROOT_SIZE" 041bba91-02 ||
    fail 'root partition geometry or identity differs'
check_fixed "$state_device" "$STATE_START" "$STATE_SIZE" 041bba91-03 ||
    fail 'state partition geometry or identity differs'
check_fixed "$log_device" "$LOG_START" "$LOG_SIZE" 041bba91-05 ||
    fail 'journal partition geometry or identity differs'
[ "$(sysfs_value "$media_device" start)" = "$MEDIA_START" ] &&
    [ "$(sysfs_value "$media_device" size)" -ge "$MEDIA_MIN_SIZE" ] &&
    [ "$(lower "$(blkid -s PARTUUID -o value "$media_device")")" = 041bba91-06 ] ||
    fail 'media partition geometry or identity differs'

check_filesystem() {
    device=$1
    expected=$2
    expected_type=$3
    [ "$(lower "$(blkid -s UUID -o value "$device" 2>/dev/null || true)")" = "$(lower "$expected")" ] &&
        [ "$(blkid -s TYPE -o value "$device" 2>/dev/null || true)" = "$expected_type" ]
}

check_filesystem "$boot_device" "$BOOT_UUID" vfat ||
    fail 'boot filesystem identity differs'
check_filesystem "$root_device" "$ROOT_UUID" ext4 ||
    fail 'root filesystem identity differs'
check_filesystem "$state_device" "$STATE_UUID" ext4 ||
    fail 'state filesystem identity differs'
check_filesystem "$log_device" "$LOG_UUID" ext4 ||
    fail 'journal filesystem identity differs'
check_filesystem "$media_device" "$MEDIA_UUID" ext4 ||
    fail 'media filesystem identity differs'

require_unique_uuid() {
    expected_device=$1
    expected_uuid=$2
    # shellcheck disable=SC2046
    set -- $(blkid -c /dev/null -t "UUID=$expected_uuid" -o device 2>/dev/null || true)
    [ "$#" -eq 1 ] &&
        [ "$(readlink -f "$1")" = "$(readlink -f "$expected_device")" ]
}

require_unique_uuid "$boot_device" "$BOOT_UUID" ||
    fail 'boot UUID is missing or duplicated'
require_unique_uuid "$root_device" "$ROOT_UUID" ||
    fail 'root UUID is missing or duplicated'
require_unique_uuid "$state_device" "$STATE_UUID" ||
    fail 'state UUID is missing or duplicated'
require_unique_uuid "$log_device" "$LOG_UUID" ||
    fail 'journal UUID is missing or duplicated'
require_unique_uuid "$media_device" "$MEDIA_UUID" ||
    fail 'media UUID is missing or duplicated'

layout_tool=/usr/lib/yonder/initramfs-bin/yonder-pi-mbr-layout
[ -x "$layout_tool" ] || fail 'private MBR layout helper is missing'
desired_media_size=$("$layout_tool" grow "$disk")
number "$desired_media_size" || fail 'layout helper returned an invalid size'

for partition in 4 5 6; do
    partx --update --nr "$partition" "$disk" >/dev/null ||
        fail "kernel did not accept partition $partition"
done

# Updating an extended container can reassign the dynamic dev_t for either
# logical partition. Rebuild only the three already-validated device paths from
# their exact sysfs identities; this also handles block major 259 in initramfs.
refresh_node() {
    device=$1
    device_numbers=$(sysfs_value "$device" dev) ||
        fail 'cannot read refreshed partition device number'
    major=${device_numbers%:*}
    minor=${device_numbers#*:}
    if ! number "$major" || ! number "$minor"; then
        fail 'invalid refreshed partition dev_t'
    fi
    replacement=$device.yonder-new
    [ ! -e "$replacement" ] || fail 'temporary partition device path already exists'
    mknod "$replacement" b "$major" "$minor" ||
        fail 'cannot create refreshed partition device node'
    chmod 0600 "$replacement"
    mv "$replacement" "$device"
}
refresh_node "$extended_device"
refresh_node "$log_device"
refresh_node "$media_device"

refreshed_size=$(sysfs_value "$media_device" size) ||
    fail 'cannot read refreshed media size'
[ "$refreshed_size" = "$desired_media_size" ] ||
    fail 'kernel media geometry did not reach the physical boundary'
[ "$(blockdev --getsz "$log_device")" = "$LOG_SIZE" ] ||
    fail 'refreshed journal device node has the wrong size'
[ "$(blockdev --getsz "$media_device")" = "$refreshed_size" ] ||
    fail 'refreshed media device node has the wrong size'

header=$(dumpe2fs -h "$media_device" 2>/dev/null) ||
    fail 'cannot inspect media ext4 filesystem'
block_count=$(printf '%s\n' "$header" | sed -n 's/^Block count:[[:space:]]*//p')
block_size=$(printf '%s\n' "$header" | sed -n 's/^Block size:[[:space:]]*//p')
if ! number "$block_count" || ! number "$block_size"; then
    fail 'media ext4 geometry is invalid'
fi
filesystem_bytes=$((block_count * block_size))
partition_bytes=$((refreshed_size * 512))
[ "$filesystem_bytes" -le "$partition_bytes" ] ||
    fail 'media filesystem extends beyond its partition'
if [ "$filesystem_bytes" -lt "$partition_bytes" ]; then
    resize2fs "$media_device" >/dev/null || fail 'media ext4 growth failed'
    sync -f "$media_device"
    blockdev --flushbufs "$media_device"
fi

header=$(dumpe2fs -h "$media_device" 2>/dev/null) ||
    fail 'cannot verify media ext4 filesystem'
block_count=$(printf '%s\n' "$header" | sed -n 's/^Block count:[[:space:]]*//p')
block_size=$(printf '%s\n' "$header" | sed -n 's/^Block size:[[:space:]]*//p')
[ "$((block_count * block_size))" = "$partition_bytes" ] ||
    fail 'media ext4 did not reach its partition boundary'
[ "$(lower "$(blkid -s UUID -o value "$media_device")")" = "$(lower "$MEDIA_UUID")" ] ||
    fail 'media UUID changed during growth'
printf '%s\n' 'Yonder Pi media growth: layout and filesystem verified'
