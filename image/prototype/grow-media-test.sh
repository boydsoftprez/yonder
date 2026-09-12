#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Disposable loop-device integration for grow-media.sh. Never accepts a host disk.
set -euo pipefail

if [[ ${1:-} != --inside ]]; then
    [[ $# == 0 && -f image/prototype/grow-media.sh && -f CLAUDE.md ]]
    exec docker run --rm --privileged \
        -v "$PWD:/source:ro" -w /source \
        debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1 \
        /bin/bash image/prototype/grow-media-test.sh --inside
fi

[[ $# == 1 && -f /.dockerenv && $PWD == /source ]]
export DEBIAN_FRONTEND=noninteractive
apt-get update >/dev/null
apt-get install -y --no-install-recommends e2fsprogs gdisk python3 util-linux >/dev/null
scratch=$(mktemp -d /tmp/yonder-grow-media.XXXXXX)
declare -A owned_loops=()
mounts=()

cleanup() {
    set +e
    local mount_path loop device expected_backing actual_backing
    for mount_path in "${mounts[@]}"; do mountpoint -q "$mount_path" && umount "$mount_path"; done
    for loop in "${!owned_loops[@]}"; do
        expected_backing=${owned_loops[$loop]}
        actual_backing=$(losetup -n -O BACK-FILE "$loop" 2>/dev/null || true)
        if [[ $actual_backing == "$expected_backing" ]]; then
            losetup -d "$loop"
            for device in "${loop}"p{1..4}; do [[ ! -b $device ]] || rm -f "$device"; done
        fi
    done
    rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

attach() {
    local image=$1 loop name device major minor
    loop=$(losetup --find --show --partscan "$image")
    [[ $(losetup -n -O BACK-FILE "$loop") == "$image" ]]
    owned_loops[$loop]=$image
    name=${loop##*/}
    for partition in {1..4}; do
        device=${loop}p$partition
        if [[ ! -b $device ]]; then
            IFS=: read -r major minor <"/sys/class/block/${name}p${partition}/dev"
            mknod "$device" b "$major" "$minor"
        fi
    done
    ATTACHED_LOOP=$loop
}

detach() {
    local loop=$1 device expected_backing actual_backing
    expected_backing=${owned_loops[$loop]:-}
    [[ -n $expected_backing ]]
    actual_backing=$(losetup -n -O BACK-FILE "$loop" 2>/dev/null || true)
    [[ $actual_backing == "$expected_backing" ]] || fail "refusing to detach reused loop $loop"
    losetup -d "$loop"
    for device in "${loop}"p{1..4}; do [[ ! -b $device ]] || rm -f "$device"; done
    unset 'owned_loops[$loop]'
}

filesystem_bytes() {
    local header blocks size
    header=$(dumpe2fs -h "$1" 2>/dev/null)
    blocks=$(sed -n 's/^Block count:[[:space:]]*//p' <<<"$header")
    size=$(sed -n 's/^Block size:[[:space:]]*//p' <<<"$header")
    printf '%s\n' "$((blocks * size))"
}

fixed_identity() {
    local disk=$1 partition
    blkid -s PTUUID -o value "$disk"
    for partition in {1..3}; do
        sgdisk -i "$partition" "$disk" | sed -n \
            -e '/^Partition GUID code:/p' -e '/^Partition unique GUID:/p' \
            -e '/^First sector:/p' -e '/^Last sector:/p' -e '/^Attribute flags:/p' \
            -e '/^Partition name:/p'
    done
}

write_config() {
    local loop=$1 root=$2 disk_guid partition
    local -a partuuid parttype start size fsuuid
    disk_guid=$(blkid -s PTUUID -o value "$loop")
    for partition in {1..4}; do
        partuuid[partition]=$(blkid -s PARTUUID -o value "${loop}p${partition}")
        parttype[partition]=$(sgdisk -i "$partition" "$loop" | sed -n 's/^Partition GUID code: \([^ ]*\).*/\1/p')
        start[partition]=$(<"/sys/class/block/${loop##*/}p${partition}/start")
        size[partition]=$(<"/sys/class/block/${loop##*/}p${partition}/size")
        fsuuid[partition]=$(blkid -s UUID -o value "${loop}p${partition}")
    done
    mkdir -p "$root/etc"
    cat >"$root/etc/yonder-storage-prototype.conf" <<EOF
ROOT_UUID=${fsuuid[1]}
STATE_UUID=${fsuuid[2]}
LOG_UUID=${fsuuid[3]}
MEDIA_UUID=${fsuuid[4]}
DISK_GUID=${disk_guid,,}
ROOT_PARTUUID=${partuuid[1],,}
STATE_PARTUUID=${partuuid[2],,}
LOG_PARTUUID=${partuuid[3],,}
MEDIA_PARTUUID=${partuuid[4],,}
ROOT_TYPE_GUID=${parttype[1],,}
STATE_TYPE_GUID=${parttype[2],,}
LOG_TYPE_GUID=${parttype[3],,}
MEDIA_TYPE_GUID=${parttype[4],,}
ROOT_START=${start[1]}
ROOT_SIZE=${size[1]}
STATE_START=${start[2]}
STATE_SIZE=${size[2]}
LOG_START=${start[3]}
LOG_SIZE=${size[3]}
MEDIA_START=${start[4]}
MEDIA_MIN_SIZE=${size[4]}
MEDIA_PARTLABEL=yonder-media
EOF
}

# Model the GPT geometry inherited from the locked Armbian images. Their main
# table ends at sector 33 but first usable is 2048. After sgdisk relocates the
# backup to a larger disk, it preserves that reserve at both ends and places
# the backup entry array at last_usable + 1.
apply_symmetric_gpt_reserve() {
    local image=$1 reserve=$2
    python3 -I - "$image" "$reserve" <<'PY'
import binascii
import os
import struct
import sys

path = sys.argv[1]
reserve = int(sys.argv[2])
sector_size = 512
sectors = os.path.getsize(path) // sector_size

with open(path, 'r+b') as disk:
    disk.seek(sector_size)
    primary = bytearray(disk.read(sector_size))
    if primary[:8] != b'EFI PART':
        raise SystemExit('primary GPT header missing')
    header_size = struct.unpack_from('<I', primary, 12)[0]
    entry_lba, entry_count, entry_size = struct.unpack_from('<QII', primary, 72)
    table_size = entry_count * entry_size
    table_sectors = (table_size + sector_size - 1) // sector_size
    if entry_lba != 2 or reserve < 34 or reserve <= table_sectors:
        raise SystemExit('unexpected source GPT geometry')
    disk.seek(entry_lba * sector_size)
    table = disk.read(table_size)
    if binascii.crc32(table) & 0xffffffff != struct.unpack_from('<I', primary, 88)[0]:
        raise SystemExit('source GPT table CRC mismatch')

    last_usable = sectors - reserve
    backup_table_lba = last_usable + 1
    if backup_table_lba + table_sectors >= sectors:
        raise SystemExit('reserve cannot contain backup GPT metadata')

    def finish_header(header, current_lba, backup_lba, table_lba):
        struct.pack_into('<QQQQ', header, 24, current_lba, backup_lba, reserve, last_usable)
        struct.pack_into('<Q', header, 72, table_lba)
        struct.pack_into('<I', header, 16, 0)
        struct.pack_into('<I', header, 16, binascii.crc32(header[:header_size]) & 0xffffffff)

    finish_header(primary, 1, sectors - 1, entry_lba)
    backup = bytearray(primary)
    finish_header(backup, sectors - 1, 1, backup_table_lba)
    disk.seek(sector_size)
    disk.write(primary)
    disk.seek(backup_table_lba * sector_size)
    disk.write(table)
    disk.seek((sectors - 1) * sector_size)
    disk.write(backup)
PY
    sgdisk -v "$image" | grep -q 'No problems found'
}

create_fixture() {
    local image=$1 root=$2 geometry=${3:-standard} loop partition root_start=2048 media_end=0
    truncate -s 192M "$image"
    if [[ $geometry == armbian ]]; then
        root_start=32768
        media_end=$(( $(stat -c %s "$image") / 512 - 2048 ))
    fi
    sgdisk --clear \
        --new="1:${root_start}:+32M" --change-name=1:yonder-root \
        --new=2:0:+16M --change-name=2:yonder-state \
        --new=3:0:+16M --change-name=3:yonder-logs \
        --new="4:0:${media_end}" --change-name=4:yonder-media "$image" >/dev/null
    if [[ $geometry == armbian ]]; then
        apply_symmetric_gpt_reserve "$image" 2048
    fi
    attach "$image"
    loop=$ATTACHED_LOOP
    for partition in {1..4}; do mkfs.ext4 -q -F "${loop}p${partition}"; done
    mkdir -p "$root"
    mount -o ro "${loop}p1" "$root"
    mounts+=("$root")
    # Populate through a temporary writable remount, then simulate initramfs's
    # already-mounted protected root during every growth attempt.
    mount -o remount,rw "$root"
    write_config "$loop" "$root"
    sync
    mount -o remount,ro "$root"
    FIXTURE_LOOP=$loop
}

drop_fixture() {
    local loop=$1 root=$2
    umount "$root"
    detach "$loop"
}

run_growth() {
    local root=$1 stop=${2:-}
    if [[ -n $stop ]]; then
        YONDER_GROW_STOP_AFTER=$stop /bin/sh /source/image/prototype/grow-media.sh "$root"
    else
        /bin/sh /source/image/prototype/grow-media.sh "$root"
    fi
}

prepare_mount_fixture() {
    local loop=$1 root=$2 state_mount=$scratch/state-seed
    mount -o remount,rw "$root"
    mkdir -p "$root/usr/lib/yonder/storage-prototype" "$root/etc/yonder" "$root/etc/ssh" \
        "$root/var/lib/yonder-state" "$root/var/lib/yonder/console" "$root/var/lib/yonder/captures" \
        "$root/var/lib/NetworkManager" "$root/var/lib/zerotier-one" \
        "$root/var/lib/systemd" "$root/var/lib/dbus" "$root/var/log/journal" \
        "$root/home" "$root/root" "$root/tmp" "$root/var/tmp" "$root/var/cache"
    install -m 0755 /source/image/prototype/grow-media.sh \
        "$root/usr/lib/yonder/storage-prototype/grow-media.sh"
    mkdir -p "$state_mount"
    mount "${loop}p2" "$state_mount"
    mkdir -p "$state_mount/config" "$state_mount/ssh" "$state_mount/app/console" \
        "$state_mount/app/captures" "$state_mount/networkmanager" \
        "$state_mount/zerotier" "$state_mount/systemd"
    printf '%s\n' prototype-v1 >"$state_mount/seed-complete"
    sync
    umount "$state_mount"
    mount -o remount,ro "$root"
}

# Valid larger disk, exact identity preservation, filesystem fill and true no-op.
image=$scratch/valid.img
root=$scratch/valid-root
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
before_fixed=$(fixed_identity "$loop")
before_media_fs=$(filesystem_bytes "${loop}p4")
drop_fixture "$loop" "$root"
truncate -s 320M "$image"
attach "$image"
loop=$ATTACHED_LOOP
mount -o ro "${loop}p1" "$root"
run_growth "$root"
after_fixed=$(fixed_identity "$loop")
[[ $after_fixed == "$before_fixed" ]] || fail 'growth changed disk identity or partitions 1-3'
media_end=$(sgdisk -i 4 "$loop" | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')
[[ $media_end == $(( $(blockdev --getsz "$loop") - 34 )) ]] || fail 'media did not reach the last usable sector'
after_media_fs=$(filesystem_bytes "${loop}p4")
[[ $after_media_fs -gt $before_media_fs ]] || fail 'media ext4 filesystem did not grow'
sync
blockdev --flushbufs "$loop"
before_noop=$(sha256sum "$image")
run_growth "$root"
sync
blockdev --flushbufs "$loop"
after_noop=$(sha256sum "$image")
[[ $before_noop == "$after_noop" ]] || fail 'a completed second run changed the disk'
drop_fixture "$loop" "$root"

# The locked Armbian source starts p1 at 32768 and uses first usable LBA 2048.
# sgdisk preserves that reserve at the tail when it relocates the backup GPT.
# Growth must use the CRC-validated usable bounds without changing the opaque
# bootloader gap or any fixed partition identity.
image=$scratch/armbian-geometry.img
root=$scratch/armbian-geometry-root
create_fixture "$image" "$root" armbian
loop=$FIXTURE_LOOP
armbian_fixed=$(fixed_identity "$loop")
armbian_boot_gap=$(dd if="$loop" bs=512 skip=34 count=$((32768 - 34)) status=none | sha256sum)
drop_fixture "$loop" "$root"
truncate -s 320M "$image"
attach "$image"
loop=$ATTACHED_LOOP
mount -o ro "${loop}p1" "$root"
run_growth "$root"
[[ $(fixed_identity "$loop") == "$armbian_fixed" ]] || fail 'Armbian growth changed partitions 1-3'
[[ $(dd if="$loop" bs=512 skip=34 count=$((32768 - 34)) status=none | sha256sum) == "$armbian_boot_gap" ]] \
    || fail 'Armbian growth changed the opaque bootloader gap'
armbian_media_end=$(sgdisk -i 4 "$loop" | sed -n 's/^Last sector: \([0-9]*\).*/\1/p')
[[ $armbian_media_end == $(( $(blockdev --getsz "$loop") - 2048 )) ]] \
    || fail 'Armbian media did not reach its validated last usable sector'
drop_fixture "$loop" "$root"

# Checkpoint failures stand in for power loss between durable phases. Each new
# invocation derives the remaining work from GPT/ext4 geometry and completes it.
image=$scratch/retry.img
root=$scratch/retry-root
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
retry_fixed=$(fixed_identity "$loop")
drop_fixture "$loop" "$root"
truncate -s 320M "$image"
attach "$image"
loop=$ATTACHED_LOOP
mount -o ro "${loop}p1" "$root"
if run_growth "$root" gpt-repair; then fail 'GPT-repair interruption unexpectedly succeeded'; fi
[[ $(fixed_identity "$loop") == "$retry_fixed" ]] || fail 'GPT repair changed partitions 1-3'
if run_growth "$root" partition; then fail 'partition-growth interruption unexpectedly succeeded'; fi
[[ $(fixed_identity "$loop") == "$retry_fixed" ]] || fail 'partition growth changed partitions 1-3'
if run_growth "$root" filesystem; then fail 'filesystem-growth interruption unexpectedly succeeded'; fi
run_growth "$root"
[[ $(fixed_identity "$loop") == "$retry_fixed" ]] || fail 'resumed growth changed partitions 1-3'
drop_fixture "$loop" "$root"

# A damaged backup copy is reconstructed only after the remaining readable GPT
# has matched every configured identity and fixed geometry.
image=$scratch/one-copy.img
root=$scratch/one-copy-root
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
one_copy_fixed=$(fixed_identity "$loop")
drop_fixture "$loop" "$root"
sectors=$(( $(stat -c %s "$image") / 512 ))
dd if=/dev/zero of="$image" bs=512 seek=$((sectors - 1)) count=1 conv=notrunc status=none
attach "$image"
loop=$ATTACHED_LOOP
mount -o ro "${loop}p1" "$root"
run_growth "$root"
sgdisk -v "$loop" | grep -q 'No problems found' || fail 'single-copy GPT damage was not repaired'
[[ $(fixed_identity "$loop") == "$one_copy_fixed" ]] || fail 'single-copy repair changed partitions 1-3'
drop_fixture "$loop" "$root"

# With both GPT headers destroyed after the kernel read the table, the grower
# must refuse and perform no further write. This models the bounded guarantee:
# it cannot reconstruct a trusted table from the protective MBR or guesses.
image=$scratch/no-copy.img
root=$scratch/no-copy-root
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
sectors=$(blockdev --getsz "$loop")
dd if=/dev/zero of="$loop" bs=512 seek=1 count=1 conv=notrunc status=none
dd if=/dev/zero of="$loop" bs=512 seek=$((sectors - 1)) count=1 conv=notrunc status=none
sync
blockdev --flushbufs "$loop"
before_no_copy=$(sha256sum "$image")
if run_growth "$root"; then fail 'both-copy GPT damage unexpectedly grew'; fi
sync
blockdev --flushbufs "$loop"
[[ $(sha256sum "$image") == "$before_no_copy" ]] || fail 'both-copy GPT refusal changed the disk'
drop_fixture "$loop" "$root"

# Even the expected p4 is never resized online; mounting it anywhere is a
# fail-closed condition and must leave the disk byte-for-byte unchanged.
image=$scratch/mounted-media.img
root=$scratch/mounted-media-root
media_mount=$scratch/mounted-media-target
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
mkdir -p "$media_mount"
mount "${loop}p4" "$media_mount"
mounts+=("$media_mount")
before_mounted=$(sha256sum "$image")
if run_growth "$root"; then fail 'mounted media unexpectedly grew'; fi
sync
[[ $(sha256sum "$image") == "$before_mounted" ]] || fail 'mounted-media refusal changed the disk'
umount "$media_mount"
drop_fixture "$loop" "$root"

# Wrong configured geometry refuses without changing the disk.
image=$scratch/wrong-layout.img
root=$scratch/wrong-layout-root
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
mount -o remount,rw "$root"
sed -i 's/^STATE_START=.*/STATE_START=1/' "$root/etc/yonder-storage-prototype.conf"
sync
mount -o remount,ro "$root"
before_refusal=$(sha256sum "$image")
if run_growth "$root"; then fail 'wrong layout unexpectedly grew'; fi
sync
after_refusal=$(sha256sum "$image")
[[ $before_refusal == "$after_refusal" ]] || fail 'wrong-layout refusal changed the disk'
drop_fixture "$loop" "$root"

# A byte-for-byte cloned card has every filesystem/partition/disk UUID in
# common. Mounted root still selects the only disk the grower may inspect.
image=$scratch/duplicate-root.img
clone_image=$scratch/duplicate-foreign.img
root=$scratch/duplicate-root
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
drop_fixture "$loop" "$root"
cp "$image" "$clone_image"
attach "$image"
loop=$ATTACHED_LOOP
mount -o ro "${loop}p1" "$root"
attach "$clone_image"
clone_loop=$ATTACHED_LOOP
before_duplicate_root=$(sha256sum "$image")
before_duplicate_foreign=$(sha256sum "$clone_image")
run_growth "$root"
sync
[[ $(sha256sum "$image") == "$before_duplicate_root" ]] || fail 'duplicate-UUID no-op changed the root disk'
[[ $(sha256sum "$clone_image") == "$before_duplicate_foreign" ]] || fail 'duplicate-UUID selection changed the foreign disk'
detach "$clone_loop"
drop_fixture "$loop" "$root"

# Exercise mount-storage itself with a cloned foreign disk still attached. All
# durable mounts must come from the mounted root's parent, never blkid's global
# first match, and boot-time writes must leave the foreign clone unchanged.
image=$scratch/mount-root.img
clone_image=$scratch/mount-foreign.img
root=$scratch/mount-root
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
prepare_mount_fixture "$loop" "$root"
drop_fixture "$loop" "$root"
cp "$image" "$clone_image"
attach "$image"
loop=$ATTACHED_LOOP
mount -o ro "${loop}p1" "$root"
attach "$clone_image"
clone_loop=$ATTACHED_LOOP
before_mount_foreign=$(sha256sum "$clone_image")
/bin/sh /source/image/prototype/mount-storage.sh "$root"
[[ $(findmnt -n -T "$root/var/lib/yonder-state" -o SOURCE) == "${loop}p2" ]]
[[ $(findmnt -n -T "$root/var/log/journal" -o SOURCE) == "${loop}p3" ]]
[[ $(findmnt -n -T "$root/var/lib/yonder/captures" -o SOURCE) == "${loop}p4" ]]
sync
[[ $(sha256sum "$clone_image") == "$before_mount_foreign" ]] || fail 'mount path wrote to duplicate-UUID foreign disk'
umount --recursive "$root"
detach "$clone_loop"
detach "$loop"

# Log and media identity failures are degraded boot conditions. State remains
# available for the AP/core configuration, while the affected sinks use RAM or
# a read-only empty mount. A bad log identity also disables recording because
# the grower may no longer trust the complete fixed layout.
for bad_partition in log media; do
    image=$scratch/degraded-$bad_partition.img
    root=$scratch/degraded-$bad_partition-root
    create_fixture "$image" "$root"
    loop=$FIXTURE_LOOP
    prepare_mount_fixture "$loop" "$root"
    mount -o remount,rw "$root"
    if [[ $bad_partition == log ]]; then
        sed -i 's/^LOG_UUID=.*/LOG_UUID=00000000-0000-0000-0000-000000000000/' \
            "$root/etc/yonder-storage-prototype.conf"
    else
        sed -i 's/^MEDIA_UUID=.*/MEDIA_UUID=00000000-0000-0000-0000-000000000000/' \
            "$root/etc/yonder-storage-prototype.conf"
    fi
    sync
    mount -o remount,ro "$root"
    before_degraded_media=$(sha256sum "${loop}p4")
    /bin/sh /source/image/prototype/mount-storage.sh "$root"
    [[ $(findmnt -n -T "$root/var/lib/yonder-state" -o SOURCE) == "${loop}p2" ]]
    if [[ $bad_partition == log ]]; then
        [[ $(findmnt -n -T "$root/var/log/journal" -o FSTYPE) == tmpfs ]]
    else
        [[ $(findmnt -n -T "$root/var/log/journal" -o SOURCE) == "${loop}p3" ]]
    fi
    [[ $(findmnt -n -T "$root/var/lib/yonder/captures" -o FSTYPE) == tmpfs ]]
    case ",$(findmnt -n -T "$root/var/lib/yonder/captures" -o OPTIONS)," in
        *,ro,*) ;;
        *) fail "$bad_partition identity fallback media mount was writable" ;;
    esac
    sync
    [[ $(sha256sum "${loop}p4") == "$before_degraded_media" ]] \
        || fail "$bad_partition identity fallback changed the media partition"
    umount --recursive "$root"
    detach "$loop"
done

# A media UUID on another disk cannot redirect mutation away from the root disk.
image=$scratch/root-disk.img
other_image=$scratch/unrelated.img
root=$scratch/unrelated-root
other_root=$scratch/other-root
create_fixture "$image" "$root"
loop=$FIXTURE_LOOP
create_fixture "$other_image" "$other_root"
other_loop=$FIXTURE_LOOP
other_media_uuid=$(blkid -s UUID -o value "${other_loop}p4")
mount -o remount,rw "$root"
sed -i "s/^MEDIA_UUID=.*/MEDIA_UUID=$other_media_uuid/" "$root/etc/yonder-storage-prototype.conf"
sync
mount -o remount,ro "$root"
before_root=$(sha256sum "$image")
before_other=$(sha256sum "$other_image")
if run_growth "$root"; then fail 'unrelated media disk unexpectedly grew'; fi
sync
[[ $(sha256sum "$image") == "$before_root" ]] || fail 'root disk changed on unrelated-disk refusal'
[[ $(sha256sum "$other_image") == "$before_other" ]] || fail 'unrelated disk changed on refusal'
drop_fixture "$other_loop" "$other_root"
drop_fixture "$loop" "$root"

printf '%s\n' 'PASS: larger-disk growth, exact no-op, phase retries, one-copy GPT repair, both-copy refusal, mounted-media refusal, wrong-layout refusal, duplicate-UUID root selection/mounting, degraded log/media identity boot and unrelated-disk refusal.'
printf '%s\n' 'LIMIT: checkpoint injection cannot prove survival of arbitrary torn GPT/ext4 metadata writes or physical-media failure.'
