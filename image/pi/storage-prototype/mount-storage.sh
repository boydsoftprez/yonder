#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Pi MBR storage prototype, invoked after initramfs-tools mounts partition 2.
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
    # shellcheck disable=SC1090 # generated immutable prototype configuration
    . "$config"
fi

fail() {
    echo "Yonder Pi storage prototype: $*" >&2
    exit 1
}

lower() {
    printf '%s' "$1" | tr 'A-F' 'a-f'
}

uuid_matches() {
    actual=$(blkid -s UUID -o value "$1" 2>/dev/null || true)
    [ "$(lower "$actual")" = "$(lower "$2")" ]
}

sysfs_value() {
    name=${1##*/}
    field=$2
    [ -r "/sys/class/block/$name/$field" ] || return 1
    cat "/sys/class/block/$name/$field"
}

partition_number() {
    sysfs_value "$1" partition
}

[ "${MBR_DISK_ID:-}:${BOOT_UUID:-}:${ROOT_UUID:-}" = \
    041bba91:B2F0-82D2:15f4c6be-1102-4331-9904-f78e78afd1fd ] ||
    fail 'configured boot identity differs from the prototype'
[ "${STATE_UUID:-}:${LOG_UUID:-}:${MEDIA_UUID:-}" = \
    1b09abf7-4d55-4ec3-b480-0e503f6ad440:80305cc3-c18e-4d6c-b14d-22f78a536c40:e43b8b78-96ce-407a-817c-a36156158e6b ] ||
    fail 'configured data identity differs from the prototype'
[ "${BOOT_START:-}:${BOOT_SIZE:-}:${ROOT_START:-}:${ROOT_SIZE:-}" = \
    16384:1048576:1064960:12582912 ] ||
    fail 'configured boot/root geometry differs from the prototype'
[ "${STATE_START:-}:${STATE_SIZE:-}:${EXTENDED_START:-}:${EXTENDED_MIN_SIZE:-}" = \
    13647872:1048576:14696448:2080768 ] ||
    fail 'configured state/extended geometry differs from the prototype'
[ "${LOG_START:-}:${LOG_SIZE:-}:${SECOND_EBR:-}:${MEDIA_START:-}:${MEDIA_MIN_SIZE:-}" = \
    14698496:524288:15222784:15224832:1552384 ] ||
    fail 'configured logical geometry differs from the prototype'

root_device=$(findmnt -n -T "$root" -o SOURCE 2>/dev/null || true)
root_device=${root_device%%\[*}
root_device=$(readlink -f "$root_device" 2>/dev/null || true)
[ -b "$root_device" ] || fail 'mounted root did not resolve to a block device'
[ "$(partition_number "$root_device" 2>/dev/null || true)" = 2 ] ||
    fail 'mounted root is not partition 2'
parent=$(lsblk -dn -o PKNAME "$root_device" 2>/dev/null || true)
[ -n "$parent" ] || fail 'cannot identify the disk supplying root'
disk=/dev/$parent
[ -b "$disk" ] || fail 'root parent is not a block device'
[ "$(blockdev --getss "$disk")" = 512 ] ||
    fail 'boot disk logical sector size is not 512 bytes'

# Resolve only children of the root-backed disk. The extended container appears
# as partition 4 and has no filesystem; both logical partitions remain children
# of the disk in lsblk's raw view.
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
    case "$(partition_number "$1" 2>/dev/null || true)" in
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

check_fixed() {
    device=$1
    expected_start=$2
    expected_size=$3
    expected_partuuid=$4
    [ "$(sysfs_value "$device" start 2>/dev/null || true)" = "$expected_start" ] &&
        [ "$(sysfs_value "$device" size 2>/dev/null || true)" = "$expected_size" ] &&
        [ "$(lower "$(blkid -s PARTUUID -o value "$device" 2>/dev/null || true)")" = "$expected_partuuid" ]
}

check_fixed "$boot_device" "$BOOT_START" "$BOOT_SIZE" 041bba91-01 ||
    fail 'boot partition geometry or identity differs'
check_fixed "$root_device" "$ROOT_START" "$ROOT_SIZE" 041bba91-02 ||
    fail 'root partition geometry or identity differs'
check_fixed "$state_device" "$STATE_START" "$STATE_SIZE" 041bba91-03 ||
    fail 'state partition geometry or identity differs'
check_fixed "$log_device" "$LOG_START" "$LOG_SIZE" 041bba91-05 ||
    fail 'journal partition geometry or identity differs'
extended_actual_start=$(sysfs_value "$extended_device" start 2>/dev/null || true)
extended_actual_size=$(sysfs_value "$extended_device" size 2>/dev/null || true)
# Linux exposes a DOS extended container as a two-sector placeholder on this
# exact pin; the raw MBR helper validates its real count before any growth.
if ! { [ "$extended_actual_start" = "$EXTENDED_START" ] &&
    [ "$(lower "$(blkid -s PARTUUID -o value "$extended_device" 2>/dev/null || true)")" = 041bba91-04 ] &&
    { [ "$extended_actual_size" = 2 ] ||
        [ "$extended_actual_size" -ge "$EXTENDED_MIN_SIZE" ]; }; }; then
    fail "extended partition geometry differs ($extended_actual_start/$extended_actual_size)"
fi
media_actual_start=$(sysfs_value "$media_device" start 2>/dev/null || true)
media_actual_size=$(sysfs_value "$media_device" size 2>/dev/null || true)
if ! { [ "$media_actual_start" = "$MEDIA_START" ] &&
    [ "$media_actual_size" -ge "$MEDIA_MIN_SIZE" ] &&
    [ "$(lower "$(blkid -s PARTUUID -o value "$media_device" 2>/dev/null || true)")" = 041bba91-06 ]; }; then
    fail "media partition geometry differs ($media_actual_start/$media_actual_size)"
fi

uuid_matches "$boot_device" "$BOOT_UUID" || fail 'boot filesystem identity differs'
uuid_matches "$root_device" "$ROOT_UUID" || fail 'root filesystem identity differs'
uuid_matches "$state_device" "$STATE_UUID" || fail 'state filesystem identity differs'
log_ready=1
media_ready=1
uuid_matches "$log_device" "$LOG_UUID" || log_ready=0
uuid_matches "$media_device" "$MEDIA_UUID" || media_ready=0

mount_ext4() {
    device=$1
    destination=$2
    mount -t ext4 -o rw,noatime,data=ordered,commit=5 "$device" "$destination"
}

ram_copy() {
    relative=$1
    size=$2
    mode=$3
    source_dir=/run/yonder-pi-prototype-ram-source
    mkdir -p "$source_dir"
    mount --bind "$root/$relative" "$source_dir"
    mount -t tmpfs -o "size=$size,mode=$mode,nosuid,nodev" tmpfs "$root/$relative"
    cp -a "$source_dir/." "$root/$relative/"
    umount "$source_dir"
    rmdir "$source_dir"
}

state=$root/var/lib/yonder-state
mount_ext4 "$state_device" "$state" ||
    fail 'state partition unavailable; refusing fresh setup'
[ -f "$state/seed-complete" ] ||
    fail 'incomplete state seed; refusing fresh setup'

maintenance_mode=0
maintenance_helper=/usr/lib/yonder/initramfs-bin/yonder-maintenance-token
[ -x "$maintenance_helper" ] || maintenance_helper=$root/usr/lib/yonder/storage-prototype/yonder-maintenance-token
if maintenance_result=$("$maintenance_helper" consume "$root" 2>&1); then
    [ "$maintenance_result" = maintenance ] || fail 'maintenance helper returned an invalid result'
    maintenance_mode=1
else
    maintenance_status=$?
    [ "$maintenance_status" -eq 10 ] ||
        echo 'Yonder Pi storage prototype: invalid maintenance request ignored; protected boot enforced.' >&2
fi

grow_media=/scripts/yonder-pi-grow-media
[ -x "$grow_media" ] || grow_media=$root/usr/lib/yonder/storage-prototype/grow-media.sh
if [ "$log_ready" -ne 1 ]; then
    media_ready=0
elif [ "$media_ready" -ne 1 ]; then
    echo 'Yonder Pi storage prototype: media identity mismatch; recordings disabled.' >&2
elif ! "$grow_media" "$root"; then
    media_ready=0
    echo 'Yonder Pi storage prototype: media growth refused or failed; recordings disabled.' >&2
fi

if [ "$maintenance_mode" -eq 1 ]; then
    mount -o remount,rw "$root" || fail 'cannot expose the system filesystem for maintenance'
    mount -t vfat -o rw,noatime "$boot_device" "$root/boot/firmware" ||
        fail 'cannot expose the firmware filesystem for maintenance'
else
    mount -o remount,ro "$root" || fail 'cannot protect the system filesystem'
    mount -t vfat -o ro,noatime "$boot_device" "$root/boot/firmware" ||
        fail 'cannot mount the firmware filesystem read-only'
    ram_copy etc 32m 755
fi
# The initramfs runs before systemd establishes the normal volatile /run.
# Mount it here so the storage-mode handoff is writable even with a protected
# root and survives switch_root for the administrator service to observe.
ram_copy run 8m 755
for mapping in 'config etc/yonder' 'ssh etc/ssh' 'app var/lib/yonder' \
        'networkmanager var/lib/NetworkManager' 'zerotier var/lib/zerotier-one' \
        'systemd var/lib/systemd'; do
    # shellcheck disable=SC2086 # fixed trusted source/destination pairs
    set -- $mapping
    [ -d "$state/$1" ] && [ -d "$root/$2" ] ||
        fail "durable mapping $1 is unavailable"
    mount --bind "$state/$1" "$root/$2"
done

if [ ! -e "$state/machine-id" ]; then
    tr -d '-' </proc/sys/kernel/random/uuid >"$state/machine-id.new"
    chmod 0444 "$state/machine-id.new"
    sync -f "$state/machine-id.new"
    mv "$state/machine-id.new" "$state/machine-id"
    sync -f "$state"
fi
grep -Eq '^[0-9a-f]{32}$' "$state/machine-id" || fail 'durable machine ID is invalid'
cp "$state/machine-id" "$root/etc/machine-id"

ram_copy var/lib/yonder/console 64m 750
if [ "$maintenance_mode" -ne 1 ]; then
    ram_copy home 16m 755
    ram_copy root 8m 700
fi
ram_copy var/lib/dbus 1m 755
mount -t tmpfs -o size=32m,mode=1777,nosuid,nodev tmpfs "$root/tmp"
mount -t tmpfs -o size=16m,mode=1777,nosuid,nodev tmpfs "$root/var/tmp"
if [ "$maintenance_mode" -ne 1 ]; then
    mount -t tmpfs -o size=32m,mode=755,nosuid,nodev tmpfs "$root/var/cache"
fi
mount -t tmpfs -o size=16m,mode=755,nosuid,nodev tmpfs "$root/var/log"
mkdir -p "$root/var/log/journal"
if [ "$log_ready" -ne 1 ] || ! mount_ext4 "$log_device" "$root/var/log/journal"; then
    echo 'Yonder Pi storage prototype: journal disk unavailable; bounded RAM logs only.' >&2
fi
if [ "$media_ready" -ne 1 ] || ! mount_ext4 "$media_device" "$root/var/lib/yonder/captures"; then
    mount -t tmpfs -o size=4k,mode=755,ro,nosuid,nodev tmpfs \
        "$root/var/lib/yonder/captures"
    echo 'Yonder Pi storage prototype: media unavailable; recordings disabled by read-only mount.' >&2
fi
root_options=$(findmnt -n -T "$root" -o OPTIONS 2>/dev/null || true)
boot_options=$(findmnt -n -T "$root/boot/firmware" -o OPTIONS 2>/dev/null || true)
case ",$root_options," in
    *,rw,*) observed_mode=maintenance ;;
    *,ro,*) observed_mode=protected ;;
    *) fail 'cannot observe system filesystem mode' ;;
esac
case ",$boot_options," in
    *,rw,*) observed_boot_mode=maintenance ;;
    *,ro,*) observed_boot_mode=protected ;;
    *) fail 'cannot observe firmware filesystem mode' ;;
esac
if [ "$observed_mode" != "$observed_boot_mode" ] ||
        { [ "$maintenance_mode" -eq 1 ] && [ "$observed_mode" != maintenance ]; } ||
        { [ "$maintenance_mode" -ne 1 ] && [ "$observed_mode" != protected ]; }; then
    fail 'system or firmware filesystem mode differs from boot request'
fi
printf '%s\n' "$observed_mode" >"$root/run/yonder-storage-mode"
echo 'Yonder Pi storage prototype: mounts ready; physical qualification pending.'
