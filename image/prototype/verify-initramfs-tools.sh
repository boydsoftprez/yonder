#!/bin/bash
# Exercise the tools from the generated initramfs, not their rootfs originals.
set -euo pipefail

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

namespace_test() {
    # EXIT traps run after `set -e` has unwound this function, so cleanup state
    # must outlive its local scope or the trap hides the original failure.
    initrd_root=$1
    fixture=/run/yonder-initramfs-tool-test
    tool_dir=/usr/lib/yonder/initramfs-bin
    mount_tool=$tool_dir/mount
    loop=''
    loop_backing=''
    script_loop=''
    script_loop_backing=''
    created_partition_nodes=()
    mounted_bind=0
    mounted_tmpfs=0
    mounted_ext4=0

    loop_is_backed_by() {
        local candidate=$1 backing=$2 associated
        associated=$(losetup --associated "$backing")
        while IFS=: read -r associated _; do
            [[ $associated != "$candidate" ]] || return 0
        done <<<"$associated"
        return 1
    }

    detach_owned_loop() {
        local candidate=$1 backing=$2 node
        [[ -n $candidate ]] || return 0
        if loop_is_backed_by "$candidate" "$backing"; then
            for node in "${created_partition_nodes[@]}"; do
                case "$node" in "$candidate"p[1-6]) rm -f "$node" ;; esac
            done
            losetup -d "$candidate"
        fi
    }

    cleanup_namespace() {
        set +e
        umount "$initrd_root$fixture/script-root/var/lib/yonder-state" 2>/dev/null || true
        umount "$initrd_root$fixture/script-root" 2>/dev/null || true
        (( mounted_ext4 == 0 )) || umount "$initrd_root$fixture/ext4"
        (( mounted_tmpfs == 0 )) || umount "$initrd_root$fixture/tmpfs"
        (( mounted_bind == 0 )) || umount "$initrd_root$fixture/bind"
        detach_owned_loop "$script_loop" "$script_loop_backing"
        detach_owned_loop "$loop" "$loop_backing"
        rm -rf "$initrd_root$fixture"
    }
    # shellcheck disable=SC2329 # invoked by the EXIT trap
    trap cleanup_namespace EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    # Nothing mounted by this test may propagate into the builder namespace.
    mount --make-rprivate /
    mkdir -p "$initrd_root/dev" "$initrd_root/proc" "$initrd_root/sys" \
        "$initrd_root$fixture/source" "$initrd_root$fixture/bind"
    mount --rbind /dev "$initrd_root/dev"
    mount --make-rslave "$initrd_root/dev"
    mount --rbind /proc "$initrd_root/proc"
    mount --make-rslave "$initrd_root/proc"
    # The target chroot deliberately has no host /sys mount. Early userspace
    # does have sysfs, and libblkid needs it to discover the test loop device.
    mount -t sysfs -o ro,nosuid,nodev,noexec sysfs "$initrd_root/sys"

    printf '%s\n' bind-mounted >"$initrd_root$fixture/source/probe"
    # Deliberately try the archive's normal /bin tool on an old archive. This
    # makes the regression fail for its actual reason instead of only noticing
    # that the new private directory is absent.
    if [[ ! -x $initrd_root$mount_tool ]]; then
        mount_tool=/bin/mount
    fi
    chroot "$initrd_root" "$mount_tool" --bind "$fixture/source" "$fixture/bind" || \
        fail 'the mount command selected in the generated initramfs cannot perform --bind'
    mounted_bind=1
    [[ $(<"$initrd_root$fixture/bind/probe") == bind-mounted ]] || \
        fail 'the extracted initramfs mount command did not create a working bind mount'

    local tool
    for tool in mount umount blkid blockdev findmnt lsblk partx sgdisk e2fsck resize2fs \
            dumpe2fs sed cat readlink cp mkdir rmdir mknod chmod tr sync mv grep sleep \
            wc yonder-maintenance-token; do
        [[ -x $initrd_root$tool_dir/$tool ]] || \
            fail "generated initramfs lacks executable $tool_dir/$tool"
    done

    initrd_tool() {
        chroot "$initrd_root" /bin/sh -c \
            'PATH=/usr/lib/yonder/initramfs-bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH; exec "$@"' \
            yonder-initramfs-tool "$@"
    }

    initrd_tool umount "$fixture/bind"
    mounted_bind=0

    local maintenance_fixture=$fixture/maintenance-root
    local maintenance_id=12345678-1234-4123-8123-123456789abc
    local generation=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
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
        fail 'the extracted maintenance helper did not consume its exact request'
    [[ -f $initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/consumed.json ]] ||
        fail 'the extracted maintenance helper did not publish its consumed marker'
    rm "$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/consumed.json"
    printf '%0513d' 0 \
        >"$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/pending.json"
    chmod 0600 "$initrd_root$maintenance_fixture/var/lib/yonder-state/maintenance/pending.json"
    set +e
    initrd_tool yonder-maintenance-token consume "$maintenance_fixture" >/dev/null 2>&1
    local token_status=$?
    set -e
    [[ $token_status == 20 ]] ||
        fail "the extracted maintenance helper returned $token_status for a 513-byte token"

    initrd_tool mkdir -p "$fixture/tmpfs" "$fixture/ext4" \
        "$fixture/copy-source/nested" "$fixture/copy-destination" "$fixture/empty"
    initrd_tool mount -t tmpfs -o size=1m,mode=0711,nosuid,nodev tmpfs "$fixture/tmpfs"
    mounted_tmpfs=1
    [[ $(stat -c %a "$initrd_root$fixture/tmpfs") == 711 ]] || \
        fail 'the extracted initramfs mount command did not apply tmpfs options'
    printf '%s\n' tmpfs-writable >"$initrd_root$fixture/tmpfs/probe"

    [[ -e /dev/loop-control ]] || mknod /dev/loop-control c 10 237
    local index
    for index in {0..63}; do
        [[ -e /dev/loop$index ]] || mknod "/dev/loop$index" b 7 "$index"
    done
    truncate -s 16M "$initrd_root$fixture/ext4.img"
    mkfs.ext4 -q -F "$initrd_root$fixture/ext4.img"
    loop_backing=$initrd_root$fixture/ext4.img
    loop=$(losetup --find --show "$loop_backing")
    local uuid resolved
    uuid=$(blkid -s UUID -o value "$loop")
    [[ $(initrd_tool blockdev --getsz "$loop") == 32768 ]]
    initrd_tool lsblk -dn -o NAME "$loop" | grep -Fxq "${loop##*/}"
    initrd_tool findmnt --version >/dev/null
    initrd_tool partx --version >/dev/null
    initrd_tool sgdisk --version >/dev/null
    initrd_tool dumpe2fs -h "$loop" >/dev/null 2>&1
    initrd_tool e2fsck -fn "$loop" >/dev/null
    initrd_tool resize2fs -P "$loop" >/dev/null

    resolved=$(initrd_tool blkid -U "$uuid")
    [[ $resolved == "$loop" ]] || \
        fail "the extracted initramfs blkid -U resolved '$resolved' instead of '$loop'"
    initrd_tool mount -t ext4 -o rw,noatime,data=ordered,commit=5 "$resolved" "$fixture/ext4"
    mounted_ext4=1
    printf '%s\n' ext4-mounted >"$initrd_root$fixture/ext4/probe"
    initrd_tool sync -f "$fixture/ext4/probe"
    initrd_tool sync -f "$fixture/ext4"
    initrd_tool umount "$fixture/ext4"
    mounted_ext4=0
    detach_owned_loop "$loop" "$loop_backing"
    loop=''
    loop_backing=''

    # Invoke the packaged mount script with its normal private PATH against a
    # real legacy five-partition root disk. A terrain partition is accepted
    # only by the explicit ZERO 3W bench marker; otherwise p2 must not mount.
    # With the marker it should identify p1's parent, mount p2, preserve p4,
    # and mount p5 without invoking the four-part grower.
    script_loop_backing=$initrd_root$fixture/script-disk.img
    truncate -s 96M "$script_loop_backing"
    initrd_tool sgdisk --clear \
        --new=1:2048:+16M --new=2:0:+16M --new=3:0:+16M --new=4:0:+16M --new=5:0:+16M --new=6:0:0 \
        "$fixture/script-disk.img" >/dev/null
    script_loop=$(losetup --find --show "$script_loop_backing")
    initrd_tool partx --add "$script_loop"
    local script_name=${script_loop##*/} partition device major minor
    for partition in {1..6}; do
        device=${script_loop}p$partition
        if [[ ! -b $device ]]; then
            IFS=: read -r major minor \
                <"$initrd_root/sys/class/block/${script_name}p${partition}/dev"
            mknod "$device" b "$major" "$minor"
            created_partition_nodes+=("$device")
        fi
        mkfs.ext4 -q -F "$device"
    done
    initrd_tool mkdir -p "$fixture/script-root"
    mount "${script_loop}p1" "$initrd_root$fixture/script-root"
    mkdir -p "$initrd_root$fixture/script-root/etc/yonder" \
        "$initrd_root$fixture/script-root/etc/ssh" \
        "$initrd_root$fixture/script-root/var/lib/yonder-state" \
        "$initrd_root$fixture/script-root/var/lib/yonder/captures" \
        "$initrd_root$fixture/script-root/var/lib/yonder/console" \
        "$initrd_root$fixture/script-root/var/lib/yonder/terrain" \
        "$initrd_root$fixture/script-root/var/lib/NetworkManager" \
        "$initrd_root$fixture/script-root/var/lib/zerotier-one" \
        "$initrd_root$fixture/script-root/var/lib/systemd" \
        "$initrd_root$fixture/script-root/var/lib/dbus" \
        "$initrd_root$fixture/script-root/var/log/journal" \
        "$initrd_root$fixture/script-root/home" \
        "$initrd_root$fixture/script-root/root" \
        "$initrd_root$fixture/script-root/run" \
        "$initrd_root$fixture/script-root/tmp" \
        "$initrd_root$fixture/script-root/var/tmp" \
        "$initrd_root$fixture/script-root/var/cache"
    local root_uuid state_uuid log_uuid media_uuid terrain_uuid
    root_uuid=$(blkid -s UUID -o value "${script_loop}p1")
    state_uuid=$(blkid -s UUID -o value "${script_loop}p2")
    log_uuid=$(blkid -s UUID -o value "${script_loop}p3")
    media_uuid=$(blkid -s UUID -o value "${script_loop}p4")
    terrain_uuid=$(blkid -s UUID -o value "${script_loop}p5")
    cat >"$initrd_root$fixture/script-root/etc/yonder-storage-prototype.conf" <<EOF
ROOT_UUID=$root_uuid
STATE_UUID=$state_uuid
LOG_UUID=$log_uuid
MEDIA_UUID=$media_uuid
TERRAIN_UUID=$terrain_uuid
EOF
    initrd_tool mkdir -p "$fixture/script-state"
    initrd_tool mount "${script_loop}p2" "$fixture/script-state"
    initrd_tool mkdir -p "$fixture/script-state/config" "$fixture/script-state/ssh" \
        "$fixture/script-state/app/console" "$fixture/script-state/app/captures" \
        "$fixture/script-state/app/terrain" "$fixture/script-state/networkmanager" \
        "$fixture/script-state/zerotier" "$fixture/script-state/systemd"
    : >"$initrd_root$fixture/script-state/seed-complete"
    initrd_tool umount "$fixture/script-state"
    local script_status
    # Even a trusted marker/configuration may not relax the exact p1–p5
    # topology. An extra p6 is rejected before state is touched.
    printf '%s\n' 'target=radxa-zero3w' >"$initrd_root$fixture/script-root/etc/yonder/bench-image"
    set +e
    # shellcheck disable=SC2016 # $1 is expanded by the initramfs shell
    chroot "$initrd_root" /bin/sh -c \
        'PATH=/run/yonder-initramfs-tool-test/empty-path; export PATH; exec /bin/sh /scripts/yonder-mount-storage "$1"' \
        yonder-initramfs-script "$fixture/script-root" \
        2>"$initrd_root$fixture/script-error"
    script_status=$?
    set -e
    [[ $script_status == 1 ]] || \
        fail "the packaged yonder mount script returned $script_status for legacy p6"
    if mountpoint -q "$initrd_root$fixture/script-root/var/lib/yonder-state"; then
        fail 'the packaged yonder mount script mounted state for legacy p6'
    fi
    initrd_tool sgdisk --delete=6 "$fixture/script-disk.img" >/dev/null
    initrd_tool partx --delete --nr 6 "$script_loop"
    rm -f "${script_loop}p6"
    # A terrain UUID is insufficient by itself: a non-bench image with p5
    # must also be rejected before the state filesystem is touched.
    rm "$initrd_root$fixture/script-root/etc/yonder/bench-image"
    set +e
    # shellcheck disable=SC2016 # $1 is expanded by the initramfs shell
    chroot "$initrd_root" /bin/sh -c \
        'PATH=/run/yonder-initramfs-tool-test/empty-path; export PATH; exec /bin/sh /scripts/yonder-mount-storage "$1"' \
        yonder-initramfs-script "$fixture/script-root" \
        2>"$initrd_root$fixture/script-error"
    script_status=$?
    set -e
    [[ $script_status == 1 ]] || \
        fail "the packaged yonder mount script returned $script_status for untrusted p5"
    if mountpoint -q "$initrd_root$fixture/script-root/var/lib/yonder-state"; then
        fail 'the packaged yonder mount script mounted state for an untrusted p5'
    fi
    printf '%s\n' 'target=radxa-zero3w' >"$initrd_root$fixture/script-root/etc/yonder/bench-image"
    sed -i 's/^TERRAIN_UUID=.*/TERRAIN_UUID=not-a-uuid/' \
        "$initrd_root$fixture/script-root/etc/yonder-storage-prototype.conf"
    set +e
    # shellcheck disable=SC2016 # $1 is expanded by the initramfs shell
    chroot "$initrd_root" /bin/sh -c \
        'PATH=/run/yonder-initramfs-tool-test/empty-path; export PATH; exec /bin/sh /scripts/yonder-mount-storage "$1"' \
        yonder-initramfs-script "$fixture/script-root" \
        2>"$initrd_root$fixture/script-error"
    script_status=$?
    set -e
    [[ $script_status == 1 ]] || \
        fail "the packaged yonder mount script returned $script_status for malformed terrain metadata"
    if mountpoint -q "$initrd_root$fixture/script-root/var/lib/yonder-state"; then
        fail 'the packaged yonder mount script mounted state for malformed terrain metadata'
    fi
    sed -i "s/^TERRAIN_UUID=.*/TERRAIN_UUID=$terrain_uuid/" \
        "$initrd_root$fixture/script-root/etc/yonder-storage-prototype.conf"
    cat >"$initrd_root/scripts/yonder-grow-media" <<'EOF'
#!/bin/sh
: >/run/yonder-initramfs-tool-test/grow-called
exit 99
EOF
    chmod 0755 "$initrd_root/scripts/yonder-grow-media"
    set +e
    # shellcheck disable=SC2016 # $1 is expanded by the initramfs shell
    chroot "$initrd_root" /bin/sh -c \
        'PATH=/run/yonder-initramfs-tool-test/empty-path; export PATH; exec /bin/sh /scripts/yonder-mount-storage "$1"' \
        yonder-initramfs-script "$fixture/script-root" \
        2>"$initrd_root$fixture/script-error"
    script_status=$?
    set -e
    [[ $script_status == 0 ]] || \
        fail "the packaged yonder mount script returned $script_status for the trusted legacy layout"
    [[ $(findmnt -n -T "$initrd_root$fixture/script-root/var/lib/yonder-state" -o SOURCE) == "${script_loop}p2" ]] || \
        fail 'the packaged yonder mount script did not select state from the root parent disk'
    [[ $(findmnt -n -T "$initrd_root$fixture/script-root/var/lib/yonder/terrain" -o SOURCE) == "${script_loop}p5" ]] || \
        fail 'the packaged yonder mount script did not mount UUID-bound terrain from p5'
    [[ ! -e $initrd_root$fixture/grow-called ]] || \
        fail 'the packaged yonder mount script invoked the four-part media grower for legacy p5'
    umount --recursive "$initrd_root$fixture/script-root"
    mount -o rw "${script_loop}p1" "$initrd_root$fixture/script-root"
    sed -i "s/^TERRAIN_UUID=.*/TERRAIN_UUID=$root_uuid/" \
        "$initrd_root$fixture/script-root/etc/yonder-storage-prototype.conf"
    set +e
    # shellcheck disable=SC2016 # $1 is expanded by the initramfs shell
    chroot "$initrd_root" /bin/sh -c \
        'PATH=/run/yonder-initramfs-tool-test/empty-path; export PATH; exec /bin/sh /scripts/yonder-mount-storage "$1"' \
        yonder-initramfs-script "$fixture/script-root" \
        2>"$initrd_root$fixture/script-error"
    script_status=$?
    set -e
    [[ $script_status == 0 ]] || \
        fail "the packaged yonder mount script returned $script_status for mismatched legacy terrain"
    [[ $(findmnt -n -T "$initrd_root$fixture/script-root/var/lib/yonder/terrain" -o FSTYPE) == tmpfs ]] || \
        fail 'the packaged yonder mount script did not hide mismatched terrain behind tmpfs'
    terrain_options=$(findmnt -n -T "$initrd_root$fixture/script-root/var/lib/yonder/terrain" -o OPTIONS)
    [[ ,$terrain_options, == *,ro,* ]] || \
        fail 'the mismatched terrain fallback is writable'
    [[ ! -e $initrd_root$fixture/grow-called ]] || \
        fail 'the packaged yonder mount script grew media for mismatched legacy terrain'
    umount --recursive "$initrd_root$fixture/script-root"
    detach_owned_loop "$script_loop" "$script_loop_backing"
    script_loop=''
    script_loop_backing=''

    printf '%s\n' archived >"$initrd_root$fixture/copy-source/nested/value"
    ln -s nested/value "$initrd_root$fixture/copy-source/link"
    initrd_tool chmod 0640 "$fixture/copy-source/nested/value"
    initrd_tool cp -a "$fixture/copy-source/." "$fixture/copy-destination/"
    [[ $(<"$initrd_root$fixture/copy-destination/nested/value") == archived \
        && $(stat -c %a "$initrd_root$fixture/copy-destination/nested/value") == 640 \
        && $(readlink "$initrd_root$fixture/copy-destination/link") == nested/value ]] || \
        fail 'the extracted initramfs cp -a did not preserve data, mode and symlink'
    initrd_tool mv "$fixture/copy-destination/nested/value" "$fixture/copy-destination/nested/moved"
    initrd_tool grep -Eq '^archived$' "$fixture/copy-destination/nested/moved"
    [[ $(printf '%s' aa-bb-cc | initrd_tool tr -d '-') == aabbcc ]] || \
        fail 'the extracted initramfs tr -d produced the wrong output'
    initrd_tool sleep 0
    initrd_tool rmdir "$fixture/empty"
    [[ ! -e $initrd_root$fixture/empty ]] || \
        fail 'the extracted initramfs rmdir did not remove an empty directory'
    initrd_tool umount "$fixture/tmpfs"
    mounted_tmpfs=0
    cleanup_namespace
    trap - EXIT INT TERM
}

if [[ ${1:-} == --namespace ]]; then
    [[ $# == 2 && -d $2 ]] || exit 2
    namespace_test "$2"
    exit
fi

[[ $# == 1 && -f $1 && ! -L $1 && $(id -u) == 0 ]] || exit 2
command -v unmkinitramfs >/dev/null
command -v unshare >/dev/null
archive=$1
scratch=$(mktemp -d /tmp/yonder-initramfs-tools.XXXXXX)
trap 'rm -rf "$scratch"' EXIT INT TERM
mkdir "$scratch/extracted"
unmkinitramfs "$archive" "$scratch/extracted"
mapfile -t mount_scripts < <(find "$scratch/extracted" -type f -path '*/scripts/yonder-mount-storage' -print)
[[ ${#mount_scripts[@]} == 1 ]] || fail 'generated initramfs does not contain exactly one yonder mount script'
initrd_root=${mount_scripts[0]%/scripts/yonder-mount-storage}
[[ -x $initrd_root/scripts/yonder-grow-media ]] || fail 'generated initramfs lacks the media grow script'
unshare --mount --fork /bin/bash "$0" --namespace "$initrd_root"
printf '%s\n' 'PASS: generated initramfs full tools performed bind, tmpfs and ext4 mounts, UUID lookup, archive copy, durable sync, rename and text operations; packaged storage script rejected untrusted p5 and selected p2 from an explicit legacy ZERO 3W p1-p5 root disk.'
