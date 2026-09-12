#!/bin/bash
# Execute both generated Pi initramfs variants and their packaged full tools.
set -euo pipefail

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

namespace_test() {
    # These globals deliberately outlive this function if set -e unwinds it;
    # the EXIT trap must preserve the original failure and still own cleanup.
    initrd_root=$1
    variant=$2
    fixture=/run/yonder-pi-initramfs-test-$variant
    tool_dir=/usr/lib/yonder/initramfs-bin
    disk_loop=
    disk_backing=
    uuid_loop=
    uuid_backing=
    created_nodes=()
    mounted_bind=0
    mounted_tmpfs=0
    mounted_ext4=0
    mounted_vfat=0

    loop_is_backed_by() {
        local candidate=$1 backing=$2 associated
        associated=$(losetup --associated "$backing" 2>/dev/null || true)
        while IFS=: read -r associated _; do
            [[ $associated != "$candidate" ]] || return 0
        done <<<"$associated"
        return 1
    }

    cleanup_namespace() {
        set +e
        umount --recursive "$initrd_root$fixture/script-root" 2>/dev/null || true
        (( mounted_vfat == 0 )) || umount "$initrd_root$fixture/vfat"
        (( mounted_ext4 == 0 )) || umount "$initrd_root$fixture/ext4"
        (( mounted_tmpfs == 0 )) || umount "$initrd_root$fixture/tmpfs"
        (( mounted_bind == 0 )) || umount "$initrd_root$fixture/bind"
        if [[ -n $disk_loop && -n $disk_backing ]] &&
                loop_is_backed_by "$disk_loop" "$disk_backing"; then
            losetup -d "$disk_loop" 2>/dev/null || true
        fi
        if [[ -n $uuid_loop && -n $uuid_backing ]] &&
                loop_is_backed_by "$uuid_loop" "$uuid_backing"; then
            losetup -d "$uuid_loop" 2>/dev/null || true
        fi
        for node in "${created_nodes[@]}"; do
            rm -f "$node"
        done
        rm -rf "$initrd_root$fixture"
    }
    # shellcheck disable=SC2329 # invoked by EXIT trap
    trap cleanup_namespace EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    mount --make-rprivate /
    mkdir -p "$initrd_root/dev" "$initrd_root/proc" "$initrd_root/sys" \
        "$initrd_root$fixture/source" "$initrd_root$fixture/bind"
    mount --rbind /dev "$initrd_root/dev"
    mount --make-rslave "$initrd_root/dev"
    mount --rbind /proc "$initrd_root/proc"
    mount --make-rslave "$initrd_root/proc"
    # The builder chroot intentionally has no /sys. Real early userspace does,
    # and both lsblk and blkid need it to constrain discovery to the root disk.
    mount -t sysfs -o ro,nosuid,nodev,noexec sysfs "$initrd_root/sys"

    for tool in mount umount blkid blockdev findmnt lsblk partx e2fsck \
            resize2fs dumpe2fs sed cat readlink cp mkdir rmdir mknod chmod \
            tr sync mv grep sleep wc yonder-pi-mbr-layout yonder-maintenance-token; do
        [[ -x $initrd_root$tool_dir/$tool ]] ||
            fail "$variant initramfs lacks executable $tool_dir/$tool"
    done
    initrd_tool() {
        chroot "$initrd_root" /bin/sh -c \
            'PATH=/usr/lib/yonder/initramfs-bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; exec "$@"' \
            yonder-pi-initramfs-tool "$@"
    }

    printf '%s\n' bind-ok >"$initrd_root$fixture/source/probe"
    initrd_tool mount --bind "$fixture/source" "$fixture/bind"
    mounted_bind=1
    [[ $(<"$initrd_root$fixture/bind/probe") == bind-ok ]] ||
        fail "$variant packaged mount did not create a working bind mount"
    initrd_tool umount "$fixture/bind"
    mounted_bind=0

    maintenance_fixture=$fixture/maintenance-root
    maintenance_id=12345678-1234-4123-8123-123456789abc
    generation=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
    mkdir -p "$initrd_root$maintenance_fixture/var/lib/yonder-state/transactions" \
        "$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance"
    chmod 0700 "$initrd_root$maintenance_fixture/var/lib/yonder-state/transactions" \
        "$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance"
    printf '{"schemaVersion":1,"id":"%s","kind":"maintenance","phase":"awaiting-maintenance-reboot","previousGeneration":"%s","maintenance":{"schemaVersion":1,"mode":"writable-next-boot"},"startedAt":1789160000000}\n' \
        "$maintenance_id" "$generation" \
        >"$initrd_root$maintenance_fixture/var/lib/yonder-state/transactions/operation.json"
    printf '{"schemaVersion":1,"kind":"yonder-maintenance-boot","operationId":"%s"}\n' \
        "$maintenance_id" \
        >"$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/pending.json"
    chmod 0600 "$initrd_root$maintenance_fixture/var/lib/yonder-state/transactions/operation.json" \
        "$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/pending.json"
    [[ $(initrd_tool yonder-maintenance-token consume "$maintenance_fixture") == maintenance ]] ||
        fail "$variant extracted maintenance helper did not consume its exact request"
    [[ -f $initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/consumed.json ]] ||
        fail "$variant extracted maintenance helper did not publish its consumed marker"
    rm "$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/consumed.json"
    printf '%0513d' 0 \
        >"$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/pending.json"
    chmod 0600 "$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/pending.json"
    set +e
    initrd_tool yonder-maintenance-token consume "$maintenance_fixture" >/dev/null 2>&1
    token_status=$?
    set -e
    [[ $token_status == 20 ]] ||
        fail "$variant extracted maintenance helper returned $token_status for a 513-byte token"

    initrd_tool mkdir -p "$fixture/tmpfs" "$fixture/ext4" "$fixture/vfat" \
        "$fixture/copy-source/nested" "$fixture/copy-target"
    initrd_tool mount -t tmpfs -o size=1m,mode=0711,nosuid,nodev tmpfs "$fixture/tmpfs"
    mounted_tmpfs=1
    [[ $(stat -c %a "$initrd_root$fixture/tmpfs") == 711 ]] ||
        fail "$variant packaged mount lost tmpfs options"

    truncate -s 16M "$initrd_root$fixture/uuid.img"
    uuid_backing=$initrd_root$fixture/uuid.img
    uuid_loop=$(losetup --find --show "$uuid_backing")
    mkfs.ext4 -q -F "$uuid_loop"
    unique_uuid=$(blkid -s UUID -o value "$uuid_loop")
    [[ $(initrd_tool blkid -U "$unique_uuid") == "$uuid_loop" ]] ||
        fail "$variant packaged blkid -U did not resolve its unique fixture"

    truncate -s 2977955840 "$initrd_root$fixture/disk.img"
    disk_backing=$initrd_root$fixture/disk.img
    sfdisk "$disk_backing" >/dev/null <<'EOF'
label: dos
label-id: 0x041bba91
unit: sectors

start=16384, size=1048576, type=c
start=1064960, size=4751360, type=83
EOF
    /usr/lib/yonder/storage-prototype/yonder-pi-mbr-layout assemble "$disk_backing"
    disk_loop=$(losetup --find --show --partscan "$disk_backing")
    disk_name=${disk_loop##*/}
    for partition in {1..6}; do
        sysfs=/sys/class/block/${disk_name}p$partition
        [[ -r $sysfs/dev ]] || fail "$variant fixture lacks partition $partition in sysfs"
        node=/dev/${disk_name}p$partition
        if [[ ! -b $node ]]; then
            IFS=: read -r major minor <"$sysfs/dev"
            mknod "$node" b "$major" "$minor"
            created_nodes+=("$node")
        fi
    done
    mkfs.vfat -F 32 -n bootfs -i B2F082D2 "${disk_loop}p1" >/dev/null 2>&1
    mkfs.ext4 -q -F -U 15f4c6be-1102-4331-9904-f78e78afd1fd "${disk_loop}p2"
    mkfs.ext4 -q -F -U 1b09abf7-4d55-4ec3-b480-0e503f6ad440 "${disk_loop}p3"
    mkfs.ext4 -q -F -U 80305cc3-c18e-4d6c-b14d-22f78a536c40 "${disk_loop}p5"
    mkfs.ext4 -q -F -U e43b8b78-96ce-407a-817c-a36156158e6b "${disk_loop}p6"

    initrd_tool blockdev --getss "$disk_loop" | grep -Fxq 512
    initrd_tool lsblk -dn -o NAME "$disk_loop" | grep -Fxq "$disk_name"
    initrd_tool findmnt --version >/dev/null
    initrd_tool partx --show "$disk_loop" >/dev/null
    initrd_tool e2fsck -fn "${disk_loop}p3" >/dev/null
    initrd_tool dumpe2fs -h "${disk_loop}p6" >/dev/null 2>&1
    initrd_tool resize2fs -P "${disk_loop}p6" >/dev/null
    [[ $(initrd_tool yonder-pi-mbr-layout grow "$disk_loop") == 1552384 ]] ||
        fail "$variant packaged MBR helper rejected the exact no-op layout"

    initrd_tool mount -t ext4 -o rw,noatime,data=ordered,commit=5 \
        "${disk_loop}p6" "$fixture/ext4"
    mounted_ext4=1
    initrd_tool mount -t vfat -o ro,noatime "${disk_loop}p1" "$fixture/vfat"
    mounted_vfat=1
    printf '%s\n' preserved >"$initrd_root$fixture/copy-source/nested/value"
    chmod 0640 "$initrd_root$fixture/copy-source/nested/value"
    ln -s nested/value "$initrd_root$fixture/copy-source/link"
    initrd_tool cp -a "$fixture/copy-source/." "$fixture/copy-target/"
    [[ $(stat -c %a "$initrd_root$fixture/copy-target/nested/value") == 640 ]]
    [[ $(readlink "$initrd_root$fixture/copy-target/link") == nested/value ]]
    initrd_tool sync -f "$fixture/ext4"
    initrd_tool umount "$fixture/vfat"
    mounted_vfat=0
    initrd_tool umount "$fixture/ext4"
    mounted_ext4=0

    mkdir -p "$initrd_root$fixture/script-root"
    mount -o rw "${disk_loop}p2" "$initrd_root$fixture/script-root"
    mkdir -p "$initrd_root$fixture/script-root/etc" \
        "$initrd_root$fixture/script-root/boot/firmware" \
        "$initrd_root$fixture/script-root/var/lib/yonder-state"
    cat >"$initrd_root$fixture/script-root/etc/yonder-pi-storage-prototype.conf" <<'EOF'
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
    umount "$initrd_root$fixture/script-root"
    mount -o ro "${disk_loop}p2" "$initrd_root$fixture/script-root"
    set +e
    # shellcheck disable=SC2016 # $1 is expanded by the initramfs shell
    chroot "$initrd_root" /bin/sh -c \
        'PATH=/run/yonder-pi-initramfs-test-empty; export PATH; exec /bin/sh /scripts/yonder-pi-mount-storage "$1"' \
        yonder-pi-script "$fixture/script-root" \
        2>"$initrd_root$fixture/script-error"
    script_status=$?
    set -e
    [[ $script_status == 1 ]] ||
        fail "$variant mount script returned $script_status in the incomplete-state probe"
    grep -Fxq 'Yonder Pi storage prototype: incomplete state seed; refusing fresh setup' \
        "$initrd_root$fixture/script-error" || {
            cat "$initrd_root$fixture/script-error" >&2
            fail "$variant mount script did not reach bounded incomplete-state refusal"
        }
    [[ $(findmnt -n -T "$initrd_root$fixture/script-root/var/lib/yonder-state" -o SOURCE) == "${disk_loop}p3" ]] ||
        fail "$variant mount script selected state from the wrong device"

    cleanup_namespace
    trap - EXIT INT TERM
}

if [[ ${1:-} == --namespace ]]; then
    [[ $# == 3 && -d $2 && $3 =~ ^(v8|2712)$ ]] || exit 2
    namespace_test "$2" "$3"
    exit
fi

[[ $# == 4 && $(id -u) == 0 ]] || exit 2
for path in "$@"; do
    [[ -f $path && ! -L $path && -s $path ]] || exit 2
done
command -v unmkinitramfs >/dev/null
command -v unshare >/dev/null
[[ -e /dev/loop-control ]] || mknod /dev/loop-control c 10 237
for index in {0..63}; do
    [[ -e /dev/loop$index ]] || mknod "/dev/loop$index" b 7 "$index"
done

verify_variant() {
    local archive=$1 firmware=$2 variant=$3 scratch mount_script initrd_root
    cmp "$archive" "$firmware" || fail "$variant root and firmware initramfs differ"
    scratch=$(mktemp -d "/tmp/yonder-pi-initramfs-$variant.XXXXXX")
    # shellcheck disable=SC2064 # expand this function-local path now
    trap "rm -rf '$scratch'" RETURN
    mkdir "$scratch/extracted"
    unmkinitramfs "$archive" "$scratch/extracted"
    mapfile -t scripts < <(find "$scratch/extracted" -type f \
        -path '*/scripts/yonder-pi-mount-storage' -print)
    [[ ${#scripts[@]} == 1 ]] || fail "$variant archive has an ambiguous Pi mount script"
    mount_script=${scripts[0]}
    initrd_root=${mount_script%/scripts/yonder-pi-mount-storage}
    [[ -x $initrd_root/scripts/yonder-pi-grow-media ]]
    [[ -x $initrd_root/usr/lib/yonder/initramfs-bin/yonder-pi-mbr-layout ]]
    [[ -x $initrd_root/usr/lib/yonder/initramfs-bin/yonder-maintenance-token ]]
    unshare --mount --fork /bin/bash "$0" --namespace "$initrd_root" "$variant"
    rm -rf "$scratch"
    trap - RETURN
}

verify_variant "$1" "$2" v8
verify_variant "$3" "$4" 2712
cmp "$1" "$3" >/dev/null 2>&1 && fail 'v8 and 2712 initramfs variants are identical'
printf '%s\n' 'PASS: both Pi initramfs variants copied exactly to firmware and executed full bind/tmpfs/ext4/vfat, discovery, resize, sync, archive and MBR-helper behavior against an exact six-partition fixture.'
