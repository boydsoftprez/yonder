#!/bin/bash
# Build only inside an isolated Linux Docker container, never on a host disk.
set -euo pipefail
umask 077
[[ $# == 2 ]]
target=$1
mode=$2
case "$target" in
    radxa-zero3w|radxa-rock5c) ;;
    *) printf 'error: unsupported bench target: %s\n' "$target" >&2; exit 2 ;;
esac
case "$mode" in bench|storage-prototype|production) ;; *) printf 'error: unsupported image mode: %s\n' "$mode" >&2; exit 2 ;; esac
storage_prototype=0
production=0
if [[ $mode == storage-prototype ]]; then storage_prototype=1; fi
if [[ $mode == production ]]; then storage_prototype=1; production=1; fi
[[ -f /.dockerenv && $(uname -m) == aarch64 ]]
[[ -f /work/base.img.xz && ! -L /work/base.img.xz && -f /work/target.json \
    && ! -L /work/target.json && -f /work/source.tar && ! -L /work/source.tar \
    && ! -e /work/disk.img && -d /work/result ]]
export DEBIAN_FRONTEND=noninteractive
if [[ $production == 1 ]]; then
    # Production consumes only the read-only captured repository. The outer
    # frozen builder image already contains every host-side image tool.
    [[ ${YONDER_FROZEN_BUILD:-} == 1 && -d /work/apt-input && ! -L /work/apt-input ]]
    for tool in blkid cc e2fsck fdisk findmnt losetup mount python3 readelf resize2fs \
            sfdisk sgdisk sha256sum tar truncate xz; do
        command -v "$tool" >/dev/null
    done
else
    apt-get update
    apt-get install -y --no-install-recommends e2fsprogs gdisk fdisk util-linux \
        xz-utils python3 ca-certificates
fi
mapfile -t facts < <(python3 -I - "$target" "$mode" <<'PY'
import json
import re
import sys

with open('/work/target.json', encoding='utf-8') as stream:
    facts = json.load(stream)
target = sys.argv[1]
sha = re.compile(r'^[a-f0-9]{64}$')
uuid = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
assert facts.get('target') == target
assert sha.fullmatch(facts.get('rawSha256', ''))
assert sha.fullmatch(facts.get('opaqueGapSha256', ''))
assert isinstance(facts.get('rootStartSector'), int) and facts['rootStartSector'] > 34
assert uuid.fullmatch(facts.get('rootPartitionUuid', ''))
assert uuid.fullmatch(facts.get('rootTypeGuid', ''))
assert uuid.fullmatch(facts.get('rootFilesystemUuid', ''))
assert isinstance(facts.get('storagePrototype'), bool)
assert facts['storagePrototype'] == (len(sys.argv) == 3 and sys.argv[2] != 'bench')
for field in ('rawSha256', 'opaqueGapSha256', 'rootStartSector',
              'rootPartitionUuid', 'rootTypeGuid', 'rootFilesystemUuid'):
    print(facts[field])
PY
)
[[ ${#facts[@]} == 6 ]]
raw_sha=${facts[0]}
opaque_gap_sha=${facts[1]}
root_start=${facts[2]}
root_partition_uuid=${facts[3]}
root_type_guid=${facts[4]}
root_filesystem_uuid=${facts[5]}
printf '%s  /work/base.img.xz\n' "$(cat /work/expected-sha)" | sha256sum -c -
xz -dc /work/base.img.xz > /work/disk.img
printf '%s  /work/disk.img\n' "$raw_sha" | sha256sum -c -
opaque_gap_hash() { dd if=/work/disk.img bs=512 skip=34 count="$((root_start - 34))" status=none | sha256sum | cut -d' ' -f1; }
[[ $(opaque_gap_hash) == "$opaque_gap_sha" ]]
truncate -s 8G /work/disk.img
sgdisk -e /work/disk.img
if [[ $storage_prototype == 1 ]]; then
    # The distributable image has a fixed initial size. Its initramfs validates
    # this exact layout before growing only p4 on a larger physical card.
    sgdisk --delete=1 --new="1:${root_start}:+6G" --typecode="1:${root_type_guid}" \
        --partition-guid="1:${root_partition_uuid}" \
        --new='2:0:+512M' --change-name='2:yonder-state' \
        --new='3:0:+256M' --change-name='3:yonder-logs' \
        --new='4:0:0' --change-name='4:yonder-media' /work/disk.img
else
    sgdisk --delete=1 --new="1:${root_start}:0" --typecode="1:${root_type_guid}" \
        --partition-guid="1:${root_partition_uuid}" /work/disk.img
fi
sgdisk -v /work/disk.img
sfdisk --json /work/disk.img > /work/partition.json
root_size=$(python3 -I - "$root_start" "$root_partition_uuid" "$root_type_guid" "$storage_prototype" <<'PY'
import json
import sys
p=json.load(open('/work/partition.json'))['partitiontable']
prototype = sys.argv[4] == '1'
assert p['label']=='gpt' and p['sectorsize']==512
assert len(p['partitions']) == (4 if prototype else 1)
r=p['partitions'][0]
assert r['start']==int(sys.argv[1]) and r['uuid'].lower()==sys.argv[2]
assert r['type'].lower()==sys.argv[3]
if prototype:
    assert r['size'] == 6 * 1024 * 1024 * 1024 // 512
    assert p['partitions'][1]['size'] == 512 * 1024 * 1024 // 512
    assert p['partitions'][2]['size'] == 256 * 1024 * 1024 // 512
    assert p['partitions'][3]['start'] + p['partitions'][3]['size'] == p['lastlba'] + 1
else:
    assert r['start']+r['size']==p['lastlba']+1
print(r['size']*512)
PY
)
[[ -e /dev/loop-control ]] || mknod /dev/loop-control c 10 237
for n in {0..63}; do [[ -e /dev/loop$n ]] || mknod "/dev/loop$n" b 7 "$n"; done
loop=$(losetup --find --show --offset "$((root_start * 512))" --sizelimit "$root_size" /work/disk.img)
printf '%s\n' "$loop" >/work/root-loop
[[ $(losetup -n -O BACK-FILE "$loop") == /work/disk.img ]]
if [[ $storage_prototype == 1 ]]; then
    partition_range() {
        python3 -I - "$1" <<'PY'
import json
import sys
p = json.load(open('/work/partition.json'))['partitiontable']['partitions'][int(sys.argv[1]) - 1]
print(p['start'], p['size'])
PY
    }
    read -r state_start state_size < <(partition_range 2)
    read -r logs_start logs_size < <(partition_range 3)
    read -r media_start media_size < <(partition_range 4)
    mapfile -t storage_partition_metadata < <(python3 -I <<'PY'
import json

table = json.load(open('/work/partition.json', encoding='utf-8'))['partitiontable']
print(table['id'].lower())
for partition in table['partitions']:
    print(partition['uuid'].lower())
for partition in table['partitions']:
    print(partition['type'].lower())
PY
    )
    [[ ${#storage_partition_metadata[@]} == 9 ]]
    disk_guid=${storage_partition_metadata[0]}
    root_partuuid=${storage_partition_metadata[1]}
    state_partuuid=${storage_partition_metadata[2]}
    log_partuuid=${storage_partition_metadata[3]}
    media_partuuid=${storage_partition_metadata[4]}
    root_parttype=${storage_partition_metadata[5]}
    state_parttype=${storage_partition_metadata[6]}
    log_parttype=${storage_partition_metadata[7]}
    media_parttype=${storage_partition_metadata[8]}
    state_loop=$(losetup --find --show --offset "$((state_start * 512))" --sizelimit "$((state_size * 512))" /work/disk.img)
    logs_loop=$(losetup --find --show --offset "$((logs_start * 512))" --sizelimit "$((logs_size * 512))" /work/disk.img)
    media_loop=$(losetup --find --show --offset "$((media_start * 512))" --sizelimit "$((media_size * 512))" /work/disk.img)
    for extra_loop in "$state_loop" "$logs_loop" "$media_loop"; do
        [[ $(losetup -n -O BACK-FILE "$extra_loop") == /work/disk.img ]]
    done
    mkfs.ext4 -F -L yonder-state "$state_loop" >/dev/null
    mkfs.ext4 -F -L yonder-logs "$logs_loop" >/dev/null
    mkfs.ext4 -F -L yonder-media "$media_loop" >/dev/null
    state_uuid=$(blkid -s UUID -o value "$state_loop")
    logs_uuid=$(blkid -s UUID -o value "$logs_loop")
    media_uuid=$(blkid -s UUID -o value "$media_loop")
fi
set +e
e2fsck -fy "$loop"
rc=$?
set -e
[[ $rc -le 1 ]]
resize2fs "$loop"
tune2fs -o ^journal_data_writeback,journal_data_ordered "$loop"
mkdir -p /target
mount -o rw,data=ordered,commit=5 "$loop" /target
mkdir -p /target/{proc,dev,run}
mount -t proc proc /target/proc
mount -t tmpfs -o mode=755 tmpfs /target/dev
for spec in 'null 1 3' 'zero 1 5' 'random 1 8' 'urandom 1 9' 'tty 5 0'; do
    read -r name major minor <<<"$spec"
    mknod -m 666 "/target/dev/$name" c "$major" "$minor"
done
mkdir /target/dev/pts
mount -t devpts -o newinstance,ptmxmode=0666 devpts /target/dev/pts
ln -s pts/ptmx /target/dev/ptmx
ln -s /proc/self/fd /target/dev/fd
ln -s /proc/self/fd/0 /target/dev/stdin
ln -s /proc/self/fd/1 /target/dev/stdout
ln -s /proc/self/fd/2 /target/dev/stderr
mount -t tmpfs -o mode=755 tmpfs /target/run
mkdir -p /target/run/sshd /target/opt/yonder-src
if [[ $production == 0 ]]; then
    mkdir -p /target/run/yonder-bench-input
    cp /work/input/* /target/run/yonder-bench-input/
    chmod 600 /target/run/yonder-bench-input/*
else
    [[ ! -e /work/input/password && ! -e /work/input/authorized_key ]]
fi
rm -f /target/etc/resolv.conf
cp /etc/resolv.conf /target/etc/resolv.conf
chmod 0644 /target/etc/resolv.conf
tar --no-same-owner -xf /work/source.tar -C /target/opt/yonder-src
if [[ $production == 1 ]]; then
    helper=/target/opt/yonder-src/image/storage/maintenance-token.arm64
    cc -std=c11 -O2 -Wall -Wextra -Werror -static \
        /target/opt/yonder-src/image/storage/maintenance-token.c -o "$helper"
    chmod 0755 "$helper"
    if readelf -l "$helper" | grep -q 'Requesting program interpreter'; then
        printf 'FAIL: production maintenance helper is dynamically linked\n' >&2
        exit 1
    fi
    readelf -h "$helper" | grep -Eq 'Machine:[[:space:]]+AArch64$'
    sha256sum "$helper" | cut -d' ' -f1 >"$helper.sha256"
fi
if [[ $target == radxa-rock5c ]]; then
    installer=(/bin/sh /opt/yonder-src/installer/install.sh --image --target radxa-rock5c --hardware-test)
else
    installer=(/bin/sh /opt/yonder-src/installer/install.sh --image --target radxa-zero3w)
fi
if [[ $production == 1 ]]; then
    [[ $(findmnt -rn -T /work/apt-input -o TARGET) == /work/apt-input ]]
    case ",$(findmnt -rn -T /work/apt-input -o OPTIONS)," in *,ro,*) ;; *) exit 1 ;; esac
    [[ $(stat -c '%u:%g' /work/apt-input) == 0:0 ]]
    install -d -m 0755 /target/run/yonder-apt
    mount --bind /work/apt-input /target/run/yonder-apt
    mount -o remount,bind,ro /target/run/yonder-apt
    install_status=0
    chroot /target /bin/bash /opt/yonder-src/image/inputs/install-captured-apt.sh \
        --input /run/yonder-apt --target "$target" -- \
        /bin/sh -c 'umask 022; exec "$@"' yonder-installer "${installer[@]}" \
        || install_status=$?
    umount /target/run/yonder-apt
    rmdir /target/run/yonder-apt
    [[ $install_status == 0 ]]
else
    # Suppress any package postinst service startup inside the target.
    [[ ! -e /target/usr/sbin/policy-rc.d ]]
    printf '#!/bin/sh\nexit 101\n' >/target/usr/sbin/policy-rc.d
    chmod 755 /target/usr/sbin/policy-rc.d
    chroot /target apt-get -o APT::Update::Error-Mode=any update
    target_packages=(openssh-server sudo v4l-utils i2c-tools gpiod ffmpeg gstreamer1.0-tools python3-serial picocom device-tree-compiler)
    if [[ $storage_prototype == 1 ]]; then
        target_packages+=(initramfs-tools gdisk util-linux e2fsprogs)
    fi
    chroot /target apt-get install -y --no-install-recommends "${target_packages[@]}"
    rm /target/usr/sbin/policy-rc.d
    chroot /target /bin/sh -c 'umask 022; exec "$@"' yonder-installer "${installer[@]}"
fi

if [[ $production == 1 ]]; then
    chroot /target /bin/sh /opt/yonder-src/image/finalize.sh --target "$target"
else
    chroot /target /bin/sh /opt/yonder-src/image/bench/prepare-rootfs.sh --bench --target "$target"
fi
if [[ $target == radxa-zero3w ]]; then
    # Check the assembled filesystem after all preparation, not merely the
    # source archive. A camera-capable image must not omit its board stack.
    # shellcheck disable=SC2016 # These paths expand inside the target chroot.
    chroot /target /bin/sh -c 'export YONDER_SRC=/opt/yonder-src IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w DRY_RUN=0; . "$YONDER_SRC/installer/lib/common.sh"; . "$YONDER_SRC/installer/lib/seekerhd.sh"; seekerhd_verify_install'
    if [[ $production == 0 ]]; then
        printf '%s\n' 'camera_stack=seekerhd-imx462-isp21' >> /target/etc/yonder/bench-image
    fi
fi
# Preserve the pinned root identifier; shorten the inherited 120-second commit interval.
sed -i 's/commit=120/commit=5/g' /target/etc/fstab
if [[ $storage_prototype == 1 ]]; then
    # Mount only loop devices whose offsets and sizes were derived from this
    # private disk.  The hook receives UUIDs, never host device names.
    install -d -m 0750 /target/var/lib/yonder-state /target/var/log/journal /target/var/lib/yonder/captures
    mount "$state_loop" /target/var/lib/yonder-state
    mount "$logs_loop" /target/var/log/journal
    mount "$media_loop" /target/var/lib/yonder/captures
    if [[ $production == 1 ]]; then
        install -d -m 0700 /target/run/yonder-image
        cat >/target/run/yonder-image/storage-layout.conf <<EOF
SCHEMA_VERSION=1
KIND=yonder-storage-layout
TARGET=$target
PARTITION_TABLE=gpt
ROOT_UUID=$root_filesystem_uuid
STATE_UUID=$state_uuid
LOG_UUID=$logs_uuid
MEDIA_UUID=$media_uuid
DISK_GUID=$disk_guid
ROOT_PARTUUID=$root_partuuid
STATE_PARTUUID=$state_partuuid
LOG_PARTUUID=$log_partuuid
MEDIA_PARTUUID=$media_partuuid
ROOT_TYPE_GUID=$root_parttype
STATE_TYPE_GUID=$state_parttype
LOG_TYPE_GUID=$log_parttype
MEDIA_TYPE_GUID=$media_parttype
ROOT_START=$root_start
ROOT_SIZE=$((root_size / 512))
STATE_START=$state_start
STATE_SIZE=$state_size
LOG_START=$logs_start
LOG_SIZE=$logs_size
MEDIA_START=$media_start
MEDIA_MIN_SIZE=$media_size
MEDIA_PARTLABEL=yonder-media
EOF
        chmod 0600 /target/run/yonder-image/storage-layout.conf
        chroot /target /bin/sh /opt/yonder-src/installer/storage/install.sh \
            --target "$target" --layout /run/yonder-image/storage-layout.conf
    else
        [[ -x /target/opt/yonder-src/image/prototype/install.sh ]]
        chroot /target /bin/sh /opt/yonder-src/image/prototype/install.sh \
            "$root_filesystem_uuid" "$state_uuid" "$logs_uuid" "$media_uuid" "$disk_guid" \
            "$root_partuuid" "$state_partuuid" "$log_partuuid" "$media_partuuid" \
            "$root_parttype" "$state_parttype" "$log_parttype" "$media_parttype" \
            "$root_start" "$((root_size / 512))" "$state_start" "$state_size" \
            "$logs_start" "$logs_size" "$media_start" "$media_size" yonder-media
    fi
    # Exercise commands from the generated boot archive, not the build host or
    # target rootfs. The latter cannot detect klibc tool substitution in initrd.
    chroot /target /bin/bash /opt/yonder-src/image/prototype/verify-initramfs-tools.sh \
        /boot/initrd.img-6.1.115-vendor-rk35xx

    # The installed application must be the source snapshot that this image
    # archives.  Verify the camera decoder output and the dashboard files at
    # the paths the installer actually copies, then retain installed hashes.
    cmp /target/opt/yonder-src/packages/yonder-core/dist/video/pipeline.js \
        /target/opt/yonder/packages/yonder-core/dist/video/pipeline.js
    cmp /target/opt/yonder-src/packages/yonder-core/dist/video/probe/encoder.js \
        /target/opt/yonder/packages/yonder-core/dist/video/probe/encoder.js
    dashboard_source=/target/opt/yonder-src/packages/node-red-dashboard-2-yonder
    dashboard_installed=/target/opt/yonder/console/node_modules/node-red-dashboard-2-yonder
    while IFS= read -r -d '' dashboard_file; do
        cmp "$dashboard_source/$dashboard_file" "$dashboard_installed/$dashboard_file"
    done < <(cd "$dashboard_source" && find dist resources -type f -print0 | sort -z)
    {
        sha256sum /target/opt/yonder/packages/yonder-core/dist/video/pipeline.js
        sha256sum /target/opt/yonder/packages/yonder-core/dist/video/probe/encoder.js
        while IFS= read -r -d '' dashboard_file; do
            sha256sum "$dashboard_installed/$dashboard_file"
        done < <(cd "$dashboard_source" && find dist resources -type f -print0 | sort -z)
    } >/work/result/app-artifacts.sha256
    python3 -I - "$root_filesystem_uuid" "$state_uuid" "$logs_uuid" "$media_uuid" <<'PY'
import json
import sys

layout = json.load(open('/work/partition.json', encoding='utf-8'))
filesystems = dict(zip(('root', 'state', 'logs', 'media'), sys.argv[1:]))
layout['storagePrototype'] = {
    'initialImageCapacityBytes': 8 * 1024 * 1024 * 1024,
    'rootBytes': 6 * 1024 * 1024 * 1024,
    'stateBytes': 512 * 1024 * 1024,
    'logsBytes': 256 * 1024 * 1024,
    'mediaBytes': layout['partitiontable']['partitions'][3]['size'] * 512,
    'mediaGrowsToPhysicalDisk': True,
    'filesystemUuids': filesystems,
    'ownerRecoveryQualified': False,
    'backupQualified': False,
    'powerCutQualified': False,
}
with open('/work/result/layout.json', 'w', encoding='utf-8') as stream:
    json.dump(layout, stream, indent=2)
    stream.write('\n')
PY
    install -m 0755 /target/opt/yonder-src/image/prototype/verify-mounts.sh /work/prototype-verify.sh
fi
rm -f /target/etc/resolv.conf
ln -s /run/NetworkManager/resolv.conf /target/etc/resolv.conf
# shellcheck disable=SC2016 # dpkg-query interprets these field placeholders
chroot /target dpkg-query -W '-f=${Package}\t${Version}\n' >/work/result/packages.tsv
if [[ $production == 0 ]]; then chroot /target apt-get clean; fi
rm -rf /target/tmp/* /target/var/tmp/*
rm -f /work/input/*
if [[ $production == 0 ]]; then rm -rf /target/opt/yonder-src; fi
[[ ! -s /target/etc/machine-id && -f /target/etc/yonder/secrets.yaml \
    && ! -s /target/etc/yonder/secrets.yaml ]]
[[ -u /target/usr/bin/sudo ]]
[[ $(stat -c %a /target/tmp) == 1777 ]]
[[ $(readlink /target/etc/systemd/system/armbian-firstrun.service) == /dev/null ]]
[[ $(blkid -s UUID -o value "$loop") == "$root_filesystem_uuid" ]]
sync
if [[ $storage_prototype == 1 ]]; then
    for path in /target/var/lib/yonder/captures /target/var/log/journal /target/var/lib/yonder-state; do umount "$path"; done
fi
for path in /target/dev/pts /target/dev /target/proc /target/run /target; do umount "$path"; done
if [[ $storage_prototype == 1 ]]; then
    # The verifier performs two simulated boots against the same private loop
    # devices.  It must run before fsck, while those loops remain attached.
    if [[ $production == 1 ]]; then
        /bin/bash /work/prototype-verify.sh "$loop" production
        mount -o rw "$loop" /target
        mount -t proc proc /target/proc
        mount "$state_loop" /target/var/lib/yonder-state
        chroot /target /bin/sh /opt/yonder-src/image/verify-finalized.sh \
            --protected --target "$target"
        umount /target/var/lib/yonder-state
        umount /target/proc
        rm -rf /target/opt/yonder-src
        umount /target
    else
        /bin/bash /work/prototype-verify.sh "$loop"
    fi
fi
e2fsck -fn "$loop"
if [[ $storage_prototype == 1 ]]; then
    e2fsck -fn "$state_loop"
    e2fsck -fn "$logs_loop"
    e2fsck -fn "$media_loop"
fi
losetup -d "$loop"
if [[ $storage_prototype == 1 ]]; then
    losetup -d "$state_loop"
    losetup -d "$logs_loop"
    losetup -d "$media_loop"
fi
rm /work/root-loop
sgdisk -v /work/disk.img
[[ $(opaque_gap_hash) == "$opaque_gap_sha" ]]
printf '%s\n' "Target: $target." 'Pinned input hashes verified.' 'Original pre-root opaque bytes, partition identity and root UUID preserved.' 'GPT validated; ext4 offline check passed after installation.' 'Hardware boot, AP, UART and camera remain unqualified.' >/work/result/verification.txt
if [[ $storage_prototype == 1 ]]; then
    {
        printf '%s\n' 'Packaged initramfs tools executed successfully in an isolated mount namespace.'
        printf '%s\n' 'Protected root/boot write refusal and mount-persistence probes passed; physical qualification pending.'
        printf '%s\n' 'Radxa protected layout: root 6 GiB, state 512 MiB and logs 256 MiB remain fixed; final media grows to the physical disk.' 'Installed core and dashboard artifacts match the archived source snapshot.'
        if [[ $production == 1 ]]; then
            printf '%s\n' 'Production finalization removed build identities and credentials and initialized an ownerless factory generation.'
        else
            printf '%s\n' 'Private storage prototype; owner recovery, backup and power-cut qualification remain pending.'
        fi
    } >>/work/result/verification.txt
else
    printf '%s\n' 'Writable bench root; no protected-storage claim.' >>/work/result/verification.txt
fi
if [[ $target == radxa-zero3w ]]; then
    printf '%s\n' 'SeekerHD IMX462/ISP21 installation verified in the assembled root filesystem; physical camera operation requires hardware testing.' >>/work/result/verification.txt
fi
printf 'bench-build: final raw image checks passed for %s; compression starting\n' "$target"
xz -T2 -3 -c /work/disk.img >/work/result/image.img.xz
sha256sum /work/result/image.img.xz >/work/result/image.sha256
