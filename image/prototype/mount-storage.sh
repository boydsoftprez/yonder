#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Task 2 boot experiment, not the production state/owner coordinator.
# Invoked inside initramfs, before services see the real root.
set -eu
# Prefer the full tools bundled by our initramfs hook over klibc's /bin tools.
# The same script also runs in the rootfs mount verifier, where this directory
# is absent and the normal full system tools remain available.
PATH=/usr/lib/yonder/initramfs-bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
root=${1:?mounted root required}
[ "$root" != / ] && [ -d "$root/etc" ] || exit 2
config=$root/etc/yonder-storage-layout.conf
if [ -f "$config" ] && [ ! -L "$config" ]; then
    parser=/scripts/yonder-storage-layout
    [ -f "$parser" ] || parser=$root/usr/lib/yonder/storage/layout.sh
    # shellcheck disable=SC1090 # installed parser code, not layout data
    . "$parser"
    yonder_read_layout "$config" radxa || exit 1
else
    # Generated root-owned prototype configuration, never user-provided.
    # shellcheck disable=SC1091
    . "$root/etc/yonder-storage-prototype.conf"
fi
state=$root/var/lib/yonder-state

partition_number() {
    name=${1##*/}
    [ -r "/sys/class/block/$name/partition" ] || return 1
    cat "/sys/class/block/$name/partition"
}

root_device=$(findmnt -n -T "$root" -o SOURCE 2>/dev/null || true)
root_device=${root_device%%\[*}
root_device=$(readlink -f "$root_device" 2>/dev/null || true)
[ -b "$root_device" ] || exit 1
parent=$(lsblk -dn -o PKNAME "$root_device" 2>/dev/null || true)
[ -n "$parent" ] || exit 1
disk=/dev/$parent
# Resolve partitions only underneath the device that supplies the mounted root.
# Duplicate filesystem UUIDs on an inserted/cloned disk are deliberately ignored.
# shellcheck disable=SC2046 # deliberate tokenization of controlled lsblk fields
set -- $(lsblk -nrpo NAME,TYPE "$disk")
[ "$#" -eq 10 ] && [ "$1" = "$disk" ] || exit 1
shift 2
root_partition=''
state_device=''
log_device=''
media_device=''
while [ "$#" -gt 0 ]; do
    [ "$2" = part ] || exit 1
    case "$(partition_number "$1")" in
        1) root_partition=$1 ;;
        2) state_device=$1 ;;
        3) log_device=$1 ;;
        4) media_device=$1 ;;
        *) exit 1 ;;
    esac
    shift 2
done
[ "$root_partition" = "$root_device" ] \
    && [ -b "$state_device" ] && [ -b "$log_device" ] && [ -b "$media_device" ] \
    || exit 1

uuid_matches() {
    actual=$(blkid -s UUID -o value "$1" 2>/dev/null || true)
    [ "$(printf '%s' "$actual" | tr 'A-F' 'a-f')" = "$(printf '%s' "$2" | tr 'A-F' 'a-f')" ]
}
uuid_matches "$root_device" "$ROOT_UUID" \
    && uuid_matches "$state_device" "$STATE_UUID" || exit 1
log_ready=1
media_ready=1
uuid_matches "$log_device" "$LOG_UUID" || log_ready=0
uuid_matches "$media_device" "$MEDIA_UUID" || media_ready=0

mount_device() {
    device=$1
    destination=$2
    mount -t ext4 -o rw,noatime,data=ordered,commit=5 "$device" "$destination"
}

ram_copy() {
    relative=$1
    size=$2
    mode=$3
    # A directory bind avoids an unbounded temporary copy in initramfs RAM.
    source_dir=/run/yonder-prototype-ram-source
    mkdir -p "$source_dir"
    mount --bind "$root/$relative" "$source_dir"
    mount -t tmpfs -o "size=$size,mode=$mode,nosuid,nodev" tmpfs "$root/$relative"
    cp -a "$source_dir/." "$root/$relative/"
    umount "$source_dir"
    rmdir "$source_dir"
}

mount_device "$state_device" "$state" || {
    echo 'Yonder storage prototype: state partition unavailable; refusing fresh setup.' >&2
    exit 1
}
[ -f "$state/seed-complete" ] || {
    echo 'Yonder storage prototype: incomplete state seed; refusing fresh setup.' >&2
    exit 1
}
maintenance_mode=0
maintenance_helper=/usr/lib/yonder/initramfs-bin/yonder-maintenance-token
[ -x "$maintenance_helper" ] || maintenance_helper="$root/usr/lib/yonder/storage-prototype/yonder-maintenance-token"
if maintenance_result=$("$maintenance_helper" consume "$root" 2>&1); then
    [ "$maintenance_result" = maintenance ] || exit 1
    maintenance_mode=1
else
    maintenance_status=$?
    [ "$maintenance_status" -eq 10 ] ||
        echo 'Yonder storage prototype: invalid maintenance request ignored; protected boot enforced.' >&2
fi
grow_media=/scripts/yonder-grow-media
[ -x "$grow_media" ] || grow_media="$root/usr/lib/yonder/storage-prototype/grow-media.sh"
if [ "$log_ready" -ne 1 ]; then
    media_ready=0
elif [ "$media_ready" -ne 1 ]; then
    echo 'Yonder storage prototype: media identity mismatch; recordings disabled.' >&2
elif ! "$grow_media" "$root"; then
    media_ready=0
    echo 'Yonder storage prototype: media growth refused or failed; recordings disabled.' >&2
fi
# A consumed one-shot request exposes the persistent root for standard apt.
# Ordinary boots protect it and use a complete RAM copy of /etc.
if [ "$maintenance_mode" -eq 1 ]; then
    mount -o remount,rw "$root"
else
    mount -o remount,ro "$root"
    ram_copy etc 32m 755
fi
# The initramfs runs before systemd establishes the normal volatile /run.
# Mount it here so the storage-mode handoff is writable even with a protected
# root and survives switch_root for the administrator service to observe.
ram_copy run 8m 755
for mapping in 'config etc/yonder' 'ssh etc/ssh' 'app var/lib/yonder' \
        'networkmanager var/lib/NetworkManager' 'zerotier var/lib/zerotier-one' \
        'systemd var/lib/systemd'; do
    # shellcheck disable=SC2086 # fixed trusted pairs
    set -- $mapping
    [ -d "$state/$1" ] && [ -d "$root/$2" ] || exit 1
    mount --bind "$state/$1" "$root/$2"
done
# A machine ID is created durably before PID 1; never inherited from the builder.
if [ ! -e "$state/machine-id" ]; then
    tr -d '-' </proc/sys/kernel/random/uuid >"$state/machine-id.new"
    chmod 0444 "$state/machine-id.new"
    sync -f "$state/machine-id.new"
    mv "$state/machine-id.new" "$state/machine-id"
    sync -f "$state"
fi
grep -Eq '^[0-9a-f]{32}$' "$state/machine-id" || exit 1
cp "$state/machine-id" "$root/etc/machine-id"

# Node-RED belongs to Yonder; generated runtime/cache files need not hit the card.
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
if [ "$log_ready" -ne 1 ] || ! mount_device "$log_device" "$root/var/log/journal"; then
    echo 'Yonder storage prototype: journal disk unavailable; bounded RAM logs only.' >&2
fi
# Absent media must never redirect camera writes into configuration storage.
if [ "$media_ready" -ne 1 ] || ! mount_device "$media_device" "$root/var/lib/yonder/captures"; then
    mount -t tmpfs -o size=4k,mode=755,ro,nosuid,nodev tmpfs "$root/var/lib/yonder/captures"
    echo 'Yonder storage prototype: media unavailable; recordings disabled by read-only mount.' >&2
fi
root_options=$(findmnt -n -T "$root" -o OPTIONS 2>/dev/null || true)
case ",$root_options," in
    *,rw,*) observed_mode=maintenance ;;
    *,ro,*) observed_mode=protected ;;
    *) echo 'Yonder storage prototype: cannot observe system filesystem mode.' >&2; exit 1 ;;
esac
if { [ "$maintenance_mode" -eq 1 ] && [ "$observed_mode" != maintenance ]; } ||
        { [ "$maintenance_mode" -ne 1 ] && [ "$observed_mode" != protected ]; }; then
    echo 'Yonder storage prototype: system filesystem mode differs from boot request.' >&2
    exit 1
fi
printf '%s\n' "$observed_mode" >"$root/run/yonder-storage-mode"
echo 'Yonder storage prototype: mounts ready; physical qualification pending.'
