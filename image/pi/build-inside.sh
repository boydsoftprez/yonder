#!/bin/bash
# Build an explicit private Raspberry Pi image in isolated ARM64 Linux.
set -euo pipefail
umask 077

usage() {
    printf '%s\n' 'Usage: build-inside.sh private-test|storage-prototype|production' >&2
    exit 2
}

[[ $# == 1 ]] || usage
mode=$1
case "$mode" in
    private-test) storage_prototype=0; production=0 ;;
    storage-prototype) storage_prototype=1; production=0 ;;
    production) storage_prototype=1; production=1 ;;
    *) usage ;;
esac
[[ -f /.dockerenv && $(uname -m) == aarch64 ]]
[[ -f /work/base.img.xz && ! -L /work/base.img.xz \
    && -f /work/target.json && ! -L /work/target.json \
    && -f /work/source.tar && ! -L /work/source.tar \
    && ! -e /work/disk.img && -d /work/result ]]
if [[ $production == 0 ]]; then
    [[ -f /work/input/password && ! -L /work/input/password \
        && -f /work/input/authorized_key && ! -L /work/input/authorized_key ]]
else
    [[ ! -e /work/input/password && ! -e /work/input/authorized_key ]]
fi

export DEBIAN_FRONTEND=noninteractive
if [[ $production == 1 ]]; then
    [[ ${YONDER_FROZEN_BUILD:-} == 1 && -d /work/apt-input && ! -L /work/apt-input ]]
    for tool in blkid cc dosfsck e2fsck fdisk findmnt losetup mount python3 readelf \
            resize2fs sfdisk sha256sum tar truncate xz; do
        command -v "$tool" >/dev/null
    done
else
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates dosfstools e2fsprogs \
        fdisk python3 util-linux xz-utils
    if [[ $storage_prototype == 1 ]]; then
        apt-get install -y --no-install-recommends build-essential binutils
    fi
fi

mapfile -t facts < <(python3 -I - <<'PY'
import json
import re

with open('/work/target.json', encoding='utf-8') as stream:
    facts = json.load(stream)
sha = re.compile(r'^[a-f0-9]{64}$')
uuid = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
fat_uuid = re.compile(r'^[A-F0-9]{4}-[A-F0-9]{4}$')
def require(condition, message):
    if not condition:
        raise SystemExit(message)
require(facts.get('target') == 'rpi', 'target must be rpi')
require(facts.get('partitionTable') == 'mbr', 'partition table must be mbr')
require(sha.fullmatch(facts.get('rawSha256', '')), 'invalid raw SHA256')
require(isinstance(facts.get('uncompressedBytes'), int) and facts['uncompressedBytes'] > 0,
        'invalid uncompressed byte count')
require(re.fullmatch(r'0x[0-9a-f]{8}', facts.get('mbrDiskId', '')), 'invalid DOS identifier')
for prefix in ('boot', 'root'):
    require(isinstance(facts.get(prefix + 'StartSector'), int) and facts[prefix + 'StartSector'] > 0,
            f'invalid {prefix} start sector')
    require(isinstance(facts.get(prefix + 'SectorCount'), int) and facts[prefix + 'SectorCount'] > 0,
            f'invalid {prefix} sector count')
    require(re.fullmatch(r'0x[0-9a-f]{2}', facts.get(prefix + 'Type', '')),
            f'invalid {prefix} partition type')
require(fat_uuid.fullmatch(facts.get('bootFilesystemUuid', '')), 'invalid boot filesystem UUID')
require(facts.get('bootFilesystemLabel') == 'bootfs', 'invalid boot filesystem label')
require(uuid.fullmatch(facts.get('rootFilesystemUuid', '')), 'invalid root filesystem UUID')
for field in (
    'rawSha256', 'uncompressedBytes', 'mbrDiskId',
    'bootStartSector', 'bootSectorCount', 'bootType',
    'bootFilesystemUuid', 'bootFilesystemLabel',
    'rootStartSector', 'rootSectorCount', 'rootType', 'rootFilesystemUuid',
):
    print(facts[field])
PY
)
[[ ${#facts[@]} == 12 ]]
raw_sha=${facts[0]}
original_bytes=${facts[1]}
mbr_id=${facts[2]}
boot_start=${facts[3]}
boot_count=${facts[4]}
boot_type=${facts[5]}
boot_uuid=${facts[6]}
boot_label=${facts[7]}
root_start=${facts[8]}
root_original_count=${facts[9]}
root_type=${facts[10]}
root_uuid=${facts[11]}

printf '%s  /work/base.img.xz\n' "$(cat /work/expected-sha)" | sha256sum -c -
xz -dc /work/base.img.xz >/work/disk.img
[[ $(stat -c %s /work/disk.img) == "$original_bytes" ]]
printf '%s  /work/disk.img\n' "$raw_sha" | sha256sum -c -

mbr_invariant_hash() {
    python3 -I - <<'PY'
import hashlib
with open('/work/disk.img', 'rb') as stream:
    mbr = bytearray(stream.read(512))
mbr[474:478] = b'\0' * 4
print(hashlib.sha256(mbr).hexdigest())
PY
}
new_bytes=$((8 * 1024 * 1024 * 1024))
mbr_before=
if [[ $storage_prototype == 1 ]]; then
    storage_source=/work/source-image-pi-storage
    mkdir "$storage_source"
    for source_file in assemble-layout.sh mbr-layout.c; do
        tar -xOf /work/source.tar "image/pi/storage-prototype/$source_file" \
            >"$storage_source/$source_file"
    done
    chmod 0755 "$storage_source/assemble-layout.sh"
    "$storage_source/assemble-layout.sh" /work/disk.img "$raw_sha"
    new_root_count=12582912
else
    mbr_before=$(mbr_invariant_hash)
    layout=/work/source-image-pi-layout.sh
    tar -xOf /work/source.tar image/pi/layout.sh >"$layout"
    chmod 0755 "$layout"
    new_root_count=$(
        "$layout" /work/disk.img "$new_bytes" "$mbr_id" \
            "$boot_start" "$boot_count" "$boot_type" \
            "$root_start" "$root_original_count" "$root_type"
    )
    [[ $new_root_count =~ ^[0-9]+$ ]]
    [[ $(mbr_invariant_hash) == "$mbr_before" ]]
fi
sfdisk --verify /work/disk.img

[[ -e /dev/loop-control ]] || mknod /dev/loop-control c 10 237
for index in {0..63}; do
    [[ -e /dev/loop$index ]] || mknod "/dev/loop$index" b 7 "$index"
done
boot_loop=$(losetup --find --show --offset "$((boot_start * 512))" \
    --sizelimit "$((boot_count * 512))" /work/disk.img)
root_loop=$(losetup --find --show --offset "$((root_start * 512))" \
    --sizelimit "$((new_root_count * 512))" /work/disk.img)
owned_loops=("$boot_loop" "$root_loop")
if [[ $storage_prototype == 1 ]]; then
    state_loop=$(losetup --find --show --offset $((13647872 * 512)) \
        --sizelimit $((1048576 * 512)) /work/disk.img)
    logs_loop=$(losetup --find --show --offset $((14698496 * 512)) \
        --sizelimit $((524288 * 512)) /work/disk.img)
    media_loop=$(losetup --find --show --offset $((15224832 * 512)) \
        --sizelimit $((1552384 * 512)) /work/disk.img)
    owned_loops+=("$state_loop" "$logs_loop" "$media_loop")
fi
printf '%s\n' "${owned_loops[@]}" >/work/pi-loops
for loop in "${owned_loops[@]}"; do
    [[ $(losetup -n -O BACK-FILE "$loop") == /work/disk.img ]]
done
[[ $(blkid -s UUID -o value "$boot_loop") == "$boot_uuid" ]]
[[ $(blkid -s LABEL -o value "$boot_loop") == "$boot_label" ]]
[[ $(blkid -s UUID -o value "$root_loop") == "$root_uuid" ]]
if [[ $storage_prototype == 1 ]]; then
    [[ $(blkid -s UUID -o value "$state_loop") == 1b09abf7-4d55-4ec3-b480-0e503f6ad440 ]]
    [[ $(blkid -s UUID -o value "$logs_loop") == 80305cc3-c18e-4d6c-b14d-22f78a536c40 ]]
    [[ $(blkid -s UUID -o value "$media_loop") == e43b8b78-96ce-407a-817c-a36156158e6b ]]
fi

set +e
e2fsck -fy "$root_loop"
fsck_status=$?
set -e
[[ $fsck_status -le 1 ]]
resize2fs "$root_loop"

mkdir -p /target
mount -o rw,noatime "$root_loop" /target
mkdir -p /target/boot/firmware /target/proc /target/dev /target/run /target/sys
mount "$boot_loop" /target/boot/firmware
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
    cp /work/input/password /work/input/authorized_key /target/run/yonder-bench-input/
    chmod 0600 /target/run/yonder-bench-input/*
fi
tar --no-same-owner -xf /work/source.tar -C /target/opt/yonder-src
if [[ $production == 1 ]]; then
    maintenance_helper=/target/opt/yonder-src/image/storage/maintenance-token.arm64
    mbr_helper=/target/opt/yonder-src/image/pi/storage-prototype/yonder-pi-mbr-layout.arm64
    cc -std=c11 -O2 -Wall -Wextra -Werror -static \
        /target/opt/yonder-src/image/storage/maintenance-token.c \
        -o "$maintenance_helper"
    cc -std=c11 -O2 -Wall -Wextra -Werror -static \
        /target/opt/yonder-src/image/pi/storage-prototype/mbr-layout.c \
        -o "$mbr_helper"
    for helper in "$maintenance_helper" "$mbr_helper"; do
        chmod 0755 "$helper"
        if readelf -l "$helper" | grep -q 'Requesting program interpreter'; then
            printf 'FAIL: production helper is dynamically linked: %s\n' "$helper" >&2
            exit 1
        fi
        readelf -h "$helper" | grep -Eq 'Machine:[[:space:]]+AArch64$'
        sha256sum "$helper" | cut -d' ' -f1 >"$helper.sha256"
    done
fi

for boot_file in bcm2710-rpi-3-b.dtb bcm2711-rpi-4-b.dtb \
        bcm2712-rpi-5-b.dtb kernel8.img kernel_2712.img; do
    [[ -s /target/boot/firmware/$boot_file ]]
    sha256sum "/target/boot/firmware/$boot_file"
done >/work/pi-boot-payload.sha256

resolv_kind=absent
if [[ -L /target/etc/resolv.conf ]]; then
    resolv_kind='link'
    readlink /target/etc/resolv.conf >/work/pi-resolv-link
elif [[ -f /target/etc/resolv.conf ]]; then
    resolv_kind='file'
    cp -a /target/etc/resolv.conf /work/pi-resolv-file
fi
rm -f /target/etc/resolv.conf
cp /etc/resolv.conf /target/etc/resolv.conf
chmod 0644 /target/etc/resolv.conf

installer=(/bin/sh /opt/yonder-src/installer/install.sh --image --target rpi)
if [[ $production == 1 ]]; then
    [[ $(findmnt -rn -T /work/apt-input -o TARGET) == /work/apt-input ]]
    case ",$(findmnt -rn -T /work/apt-input -o OPTIONS)," in *,ro,*) ;; *) exit 1 ;; esac
    [[ $(stat -c '%u:%g' /work/apt-input) == 0:0 ]]
    install -d -m 0755 /target/run/yonder-apt
    mount --bind /work/apt-input /target/run/yonder-apt
    mount -o remount,bind,ro /target/run/yonder-apt
    install_status=0
    chroot /target /bin/bash /opt/yonder-src/image/inputs/install-captured-apt.sh \
        --input /run/yonder-apt --target rpi -- \
        /bin/sh -c 'umask 022; exec "$@"' yonder-installer "${installer[@]}" \
        || install_status=$?
    umount /target/run/yonder-apt
    rmdir /target/run/yonder-apt
    [[ $install_status == 0 ]]
else
    [[ ! -e /target/usr/sbin/policy-rc.d ]]
    printf '#!/bin/sh\nexit 101\n' >/target/usr/sbin/policy-rc.d
    chmod 0755 /target/usr/sbin/policy-rc.d
    chroot /target apt-get -o APT::Update::Error-Mode=any update
    target_packages=(openssh-server sudo v4l-utils i2c-tools gpiod ffmpeg \
        gstreamer1.0-tools python3-serial picocom)
    if [[ $storage_prototype == 1 ]]; then
        target_packages+=(build-essential binutils dosfstools e2fsprogs fdisk \
            initramfs-tools util-linux)
    fi
    chroot /target apt-get install -y --no-install-recommends "${target_packages[@]}"
    rm /target/usr/sbin/policy-rc.d
    chroot /target /bin/sh -c 'umask 022; exec "$@"' yonder-installer "${installer[@]}"
fi
if [[ $production == 1 ]]; then
    chroot /target /bin/sh /opt/yonder-src/image/finalize.sh --target rpi
else
    chroot /target /bin/sh /opt/yonder-src/image/pi/prepare-rootfs.sh --private-test
fi

if [[ $storage_prototype == 1 ]]; then
    install -d -m 0700 /target/var/lib/yonder-state
    install -d -m 0755 /target/var/log/journal
    install -d -m 0755 /target/var/lib/yonder/captures
    mount -o rw,noatime,data=ordered,commit=5 "$state_loop" \
        /target/var/lib/yonder-state
    mount -o rw,noatime,data=ordered,commit=5 "$logs_loop" \
        /target/var/log/journal
    mount -o rw,noatime,data=ordered,commit=5 "$media_loop" \
        /target/var/lib/yonder/captures
    if [[ $production == 1 ]]; then
        install -d -m 0700 /target/run/yonder-image
        cat >/target/run/yonder-image/storage-layout.conf <<EOF
SCHEMA_VERSION=1
KIND=yonder-storage-layout
TARGET=rpi
PARTITION_TABLE=mbr
MBR_DISK_ID=${mbr_id#0x}
BOOT_UUID=$boot_uuid
ROOT_UUID=$root_uuid
STATE_UUID=1b09abf7-4d55-4ec3-b480-0e503f6ad440
LOG_UUID=80305cc3-c18e-4d6c-b14d-22f78a536c40
MEDIA_UUID=e43b8b78-96ce-407a-817c-a36156158e6b
BOOT_START=$boot_start
BOOT_SIZE=$boot_count
ROOT_START=$root_start
ROOT_SIZE=$new_root_count
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
        chmod 0600 /target/run/yonder-image/storage-layout.conf
        chroot /target /bin/sh /opt/yonder-src/installer/storage/install.sh \
            --target rpi --layout /run/yonder-image/storage-layout.conf
    else
        chroot /target /bin/sh /opt/yonder-src/image/pi/storage-prototype/install.sh
    fi
    kernel_v8=$(basename /target/lib/modules/*-rpi-v8)
    kernel_2712=$(basename /target/lib/modules/*-rpi-2712)
    chroot /target /bin/bash \
        /opt/yonder-src/image/pi/storage-prototype/verify-initramfs-tools.sh \
        "/boot/initrd.img-$kernel_v8" /boot/firmware/initramfs8 \
        "/boot/initrd.img-$kernel_2712" /boot/firmware/initramfs_2712
    install -m 0755 /target/opt/yonder-src/image/pi/storage-prototype/verify-mounts.sh \
        /work/pi-storage-verify-mounts.sh
    install -m 0755 /target/usr/lib/yonder/storage-prototype/yonder-pi-mbr-layout \
        /work/yonder-pi-mbr-layout
fi

sha256sum -c /work/pi-boot-payload.sha256
cmdline=$(< /target/boot/firmware/cmdline.txt)
[[ $cmdline =~ (^|[[:space:]])root=PARTUUID=([0-9a-f]{8})-02([[:space:]]|$) ]]
[[ ${BASH_REMATCH[2]} == "${mbr_id#0x}" ]]
if grep -Eq '(^|[[:space:]])resize([[:space:]]|$)|console=serial0' \
        /target/boot/firmware/cmdline.txt; then
    exit 1
fi
grep -qx '# yonder-uart' /target/boot/firmware/config.txt
grep -qx 'enable_uart=1' /target/boot/firmware/config.txt
grep -qx 'dtoverlay=disable-bt' /target/boot/firmware/config.txt
grep -Eq "^PARTUUID=${mbr_id#0x}-01[[:space:]]+/boot/firmware[[:space:]]+vfat" \
    /target/etc/fstab
grep -Eq "^PARTUUID=${mbr_id#0x}-02[[:space:]]+/[[:space:]]+ext4" /target/etc/fstab
grep -q '^[[:space:]]*ssid: yonder$' /target/etc/yonder/config.yaml
grep -q '^[[:space:]]*address: 192\.168\.77\.1/24$' /target/etc/yonder/config.yaml
grep -q 'setup-flows\.json' /target/var/lib/yonder/console/settings.js
for unit in yonder-core.service yonder-console.service NetworkManager.service \
        avahi-daemon.service ModemManager.service; do
    chroot /target systemctl is-enabled --quiet "$unit"
done
if [[ $production == 0 ]]; then
    chroot /target systemctl is-enabled --quiet ssh.service
    chroot /target systemctl is-enabled --quiet yonder-bench-first-boot.service
else
    if chroot /target systemctl is-enabled --quiet ssh.service; then
        printf 'FAIL: production image left ssh.service enabled\n' >&2
        exit 1
    fi
    chroot /target systemctl is-enabled --quiet yonder-owner-setup.service
fi
[[ ! -e /target/usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstrockchipmpp.so ]]
[[ ! -e /target/etc/modules-load.d/yonder-seekerhd.conf ]]
[[ ! -s /target/etc/machine-id ]]
[[ -f /target/etc/yonder/secrets.yaml && ! -s /target/etc/yonder/secrets.yaml \
    && $(stat -c %a /target/etc/yonder/secrets.yaml) == 600 ]]
[[ -u /target/usr/bin/sudo ]]
if [[ $production == 1 ]]; then
    [[ ! -e /target/etc/yonder/bench-image ]]
    [[ -f /target/etc/yonder-storage-layout.conf ]]
elif [[ $storage_prototype == 1 ]]; then
    grep -qx 'kind=private-rpi-test' /target/etc/yonder/bench-image
    grep -qx 'protected_storage=prototype' /target/etc/yonder/bench-image
    grep -qx 'writable_root=false' /target/etc/yonder/bench-image
else
    grep -qx 'kind=private-rpi-test' /target/etc/yonder/bench-image
    grep -qx 'protected_storage=false' /target/etc/yonder/bench-image
fi

# Restore the base's resolver topology after all networked build steps.
rm /target/etc/resolv.conf
case "$resolv_kind" in
    link) ln -s "$(cat /work/pi-resolv-link)" /target/etc/resolv.conf ;;
    file) cp -a /work/pi-resolv-file /target/etc/resolv.conf ;;
    absent) ;;
    *) exit 1 ;;
esac
# shellcheck disable=SC2016 # dpkg-query interprets these field placeholders
chroot /target dpkg-query -W '-f=${Package}\t${Version}\n' >/work/result/packages.tsv
if [[ $production == 0 ]]; then chroot /target apt-get clean; fi
rm -rf /target/tmp/* /target/var/tmp/*
rm -f /work/input/password /work/input/authorized_key /work/source-image-pi-layout.sh \
    /work/pi-resolv-link /work/pi-resolv-file
rm -rf /work/source-image-pi-storage
if [[ $production == 0 ]]; then rm -rf /target/opt/yonder-src; fi
sync

if [[ $storage_prototype == 1 ]]; then
    for path in /target/var/lib/yonder/captures /target/var/log/journal \
            /target/var/lib/yonder-state; do
        umount "$path"
    done
fi
for path in /target/dev/pts /target/dev /target/proc /target/run \
        /target/boot/firmware /target; do
    umount "$path"
done
if [[ $storage_prototype == 1 ]]; then
    # Avoid duplicate filesystem UUIDs through the construction offset loops;
    # the runtime proof must see only the whole-disk partition nodes it owns.
    losetup -d "${owned_loops[@]}"
    rm /work/pi-loops
    if [[ $production == 1 ]]; then
        /bin/bash /work/pi-storage-verify-mounts.sh /work/yonder-pi-mbr-layout production
    else
        /bin/bash /work/pi-storage-verify-mounts.sh /work/yonder-pi-mbr-layout
    fi
    rm /work/pi-storage-verify-mounts.sh /work/yonder-pi-mbr-layout
    boot_loop=$(losetup --find --show --offset "$((boot_start * 512))" \
        --sizelimit "$((boot_count * 512))" /work/disk.img)
    root_loop=$(losetup --find --show --offset "$((root_start * 512))" \
        --sizelimit "$((new_root_count * 512))" /work/disk.img)
    state_loop=$(losetup --find --show --offset $((13647872 * 512)) \
        --sizelimit $((1048576 * 512)) /work/disk.img)
    logs_loop=$(losetup --find --show --offset $((14698496 * 512)) \
        --sizelimit $((524288 * 512)) /work/disk.img)
    media_loop=$(losetup --find --show --offset $((15224832 * 512)) \
        --sizelimit $((1552384 * 512)) /work/disk.img)
    owned_loops=("$boot_loop" "$root_loop" "$state_loop" "$logs_loop" "$media_loop")
    if [[ $production == 1 ]]; then
        mount -o rw "$root_loop" /target
        mount -t proc proc /target/proc
        mount "$state_loop" /target/var/lib/yonder-state
        chroot /target /bin/sh /opt/yonder-src/image/verify-finalized.sh \
            --protected --target rpi
        umount /target/var/lib/yonder-state
        umount /target/proc
        rm -rf /target/opt/yonder-src
        umount /target
    fi
fi
e2fsck -fn "$root_loop"
dosfsck -n "$boot_loop"
if [[ $production == 1 ]]; then
    cat >/work/result/verification.txt <<EOF
Target: Raspberry Pi 3/4/5 family production protected image.
Pinned compressed and raw base hashes verified.
DOS identifier $mbr_id, FAT boot identity $boot_uuid and ext4 root identity $root_uuid preserved.
Fixed 6 GiB root, 512 MiB state and 256 MiB journal plus final growable media MBR/EBR layout verified.
Both generated kernel initramfs archives exactly match the firmware files selected by auto_initramfs and their packaged tools executed against a real six-partition fixture.
Actual namespace mounts verified read-only FAT boot/root, persistent state/log/media, volatile paths, bounded fallbacks and incomplete-state refusal.
Production finalization removed build identities and credentials and initialized an ownerless factory generation.
Pi 3/4/5 hardware boot, power-cut, radio, UART and camera qualification remain pending.
EOF
elif [[ $storage_prototype == 1 ]]; then
    e2fsck -fn "$state_loop"
    e2fsck -fn "$logs_loop"
    e2fsck -fn "$media_loop"
fi
losetup -d "${owned_loops[@]}"
rm -f /work/pi-loops

if [[ $storage_prototype == 0 ]]; then
    [[ $(mbr_invariant_hash) == "$mbr_before" ]]
fi
[[ $(sfdisk --disk-id /work/disk.img) == "$mbr_id" ]]
mapfile -t final_parts < <(sfdisk --json /work/disk.img | python3 -I -c '
import json, sys
for item in json.load(sys.stdin)["partitiontable"]["partitions"]:
    print(item["start"], item["size"], item["type"])
')
python3 -I - "$storage_prototype" "$boot_start" "$boot_count" "$boot_type" \
        "$root_start" "$new_root_count" "$root_type" "${final_parts[@]}" <<'PY'
import sys
prototype = int(sys.argv[1])
want = [(int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4], 16)),
        (int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7], 16))]
if prototype:
    want += [
        (13647872, 1048576, 0x83),
        (14696448, 2080768, 0x0f),
        (14698496, 524288, 0x83),
        (15224832, 1552384, 0x83),
    ]
have = []
for line in sys.argv[8:]:
    start, count, kind = line.split()
    have.append((int(start), int(count), int(kind, 16)))
if have != want:
    raise SystemExit('final DOS partition layout does not match requested image')
PY

if [[ $storage_prototype == 1 ]]; then
    cat >/work/result/verification.txt <<EOF
Target: Raspberry Pi 3/4/5 family private storage-prototype image.
Pinned compressed and raw base hashes verified.
DOS identifier $mbr_id, FAT boot identity $boot_uuid and ext4 root identity $root_uuid preserved.
Fixed 6 GiB root, 512 MiB state and 256 MiB journal plus final growable media MBR/EBR layout verified.
Both generated kernel initramfs archives exactly match the firmware files selected by auto_initramfs and their packaged tools executed against a real six-partition fixture.
Actual namespace mounts verified read-only FAT boot/root, persistent state/log/media, volatile paths, bounded fallbacks and incomplete-state refusal.
Complete Raspberry Pi application install, default access point and temporary password/key SSH account verified.
Owner recovery, maintenance, backup, Pi 3/4/5 hardware boot, power-cut, radio, UART and camera remain unqualified.
EOF
else
    cat >/work/result/verification.txt <<EOF
Target: Raspberry Pi 3/4/5 family private test image.
Pinned compressed and raw base hashes verified.
DOS identifier $mbr_id, boot partition and FAT identity $boot_uuid preserved.
Root partition grew offline to 8 GiB image capacity; ext4 identity $root_uuid preserved and fsck passed.
Complete Raspberry Pi application install and default access-point configuration verified.
Temporary password/key SSH account installed; remote root disabled and per-board identities prepared for first boot.
Writable root; protected storage, owner recovery, hardware boot, radio, UART and camera remain unqualified.
EOF
fi
xz -T2 -3 -c /work/disk.img >/work/result/image.img.xz
sha256sum /work/result/image.img.xz >/work/result/image.sha256
printf 'pi-build: %s image checks passed\n' "$mode"
