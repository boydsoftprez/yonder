#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Exercise the Pi MBR/EBR layout only in a disposable privileged ARM64 container.
set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
image=debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1
container=yonder-pi-storage-test-$$
cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null
[[ $(docker info --format '{{.OSType}}') == linux ]]
docker run -d --name "$container" --platform linux/arm64 --privileged \
    "$image" sleep infinity >/dev/null
docker exec "$container" mkdir -p /tmp/pi-storage
docker cp "$here/." "$container:/tmp/pi-storage/"
docker exec "$container" sh -c \
    'apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential dosfstools e2fsprogs fdisk python3 util-linux >/dev/null'

docker exec -i "$container" /bin/bash -s <<'TEST'
set -euo pipefail
mkdir -p /work /mnt/pi-root /usr/lib/yonder/initramfs-bin

cleanup_loops() {
    mountpoint -q /run/yonder-pi-prototype-ram-source && \
        umount /run/yonder-pi-prototype-ram-source || true
    mountpoint -q /mnt/pi-root && umount --recursive /mnt/pi-root || true
    for file in /work/base.img /work/grow.img /work/reject.img /work/foreign.img; do
        [[ -f $file ]] || continue
        while IFS=: read -r loop _; do
            [[ -n $loop ]] && losetup -d "$loop" 2>/dev/null || true
        done <<<"$(losetup --associated "$file" 2>/dev/null || true)"
    done
}
trap cleanup_loops EXIT
mount --make-rprivate /

for index in {0..63}; do
    [[ -e /dev/loop$index ]] || mknod "/dev/loop$index" b 7 "$index"
done
[[ -e /dev/loop-control ]] || mknod /dev/loop-control c 10 237

attach_image() {
    loop=$(losetup --find --show --partscan "$1")
    base=${loop##*/}
    for sysfs in /sys/class/block/"$base"p*; do
        [[ -r $sysfs/dev ]] || continue
        name=${sysfs##*/}
        IFS=: read -r major minor <"$sysfs/dev"
        rm -f "/dev/$name"
        mknod "/dev/$name" b "$major" "$minor"
    done
    printf '%s\n' "$loop"
}

# Reproduce the locked base's exact MBR and filesystem boundaries with sparse
# disposable content. The expected SHA is computed before the mutator runs.
truncate -s 2977955840 /work/base.img
sfdisk /work/base.img >/dev/null <<'EOF'
label: dos
label-id: 0x041bba91
unit: sectors

start=16384, size=1048576, type=c
start=1064960, size=4751360, type=83
EOF
boot_loop=$(losetup --find --show --offset $((16384 * 512)) \
    --sizelimit $((1048576 * 512)) /work/base.img)
root_loop=$(losetup --find --show --offset $((1064960 * 512)) \
    --sizelimit $((4751360 * 512)) /work/base.img)
mkfs.vfat -F 32 -n bootfs -i B2F082D2 "$boot_loop" >/dev/null 2>&1
mkfs.ext4 -q -F -L rootfs -U 15f4c6be-1102-4331-9904-f78e78afd1fd "$root_loop"
mkdir -p /mnt/boot /mnt/root
mount "$boot_loop" /mnt/boot
mount "$root_loop" /mnt/root
printf '%s\n' firmware-boundary >/mnt/boot/config.txt
printf '%s\n' root-boundary >/mnt/root/root-probe
sync
umount /mnt/boot /mnt/root
losetup -d "$boot_loop" "$root_loop"
boot_before=$(dd if=/work/base.img bs=512 skip=16384 count=1048576 status=none | sha256sum | cut -d' ' -f1)
base_sha=$(sha256sum /work/base.img | cut -d' ' -f1)

! /tmp/pi-storage/assemble-layout.sh /work/base.img \
    0000000000000000000000000000000000000000000000000000000000000000
[[ $(sha256sum /work/base.img | cut -d' ' -f1) == "$base_sha" ]]
/tmp/pi-storage/assemble-layout.sh /work/base.img "$base_sha"
[[ $(stat -c %s /work/base.img) == 8589934592 ]]
[[ $(sfdisk --disk-id /work/base.img) == 0x041bba91 ]]
mapfile -t parts < <(sfdisk --json /work/base.img | python3 -I -c '
import json, sys
for p in json.load(sys.stdin)["partitiontable"]["partitions"]:
    print(p["start"], p["size"], p["type"])
')
[[ ${parts[*]} == '16384 1048576 c 1064960 12582912 83 13647872 1048576 83 14696448 2080768 f 14698496 524288 83 15224832 1552384 83' ]]
[[ $(dd if=/work/base.img bs=512 skip=16384 count=1048576 status=none | sha256sum | cut -d' ' -f1) == "$boot_before" ]]

whole=$(attach_image /work/base.img)
for pair in \
        "${whole}p1:B2F0-82D2" \
        "${whole}p2:15f4c6be-1102-4331-9904-f78e78afd1fd" \
        "${whole}p3:1b09abf7-4d55-4ec3-b480-0e503f6ad440" \
        "${whole}p5:80305cc3-c18e-4d6c-b14d-22f78a536c40" \
        "${whole}p6:e43b8b78-96ce-407a-817c-a36156158e6b"; do
    device=${pair%%:*}
    uuid=${pair#*:}
    [[ $(blkid -s UUID -o value "$device") == "$uuid" ]]
done
mount -o ro "${whole}p2" /mnt/pi-root
grep -qx root-boundary /mnt/pi-root/root-probe
grep -qx 'MEDIA_START=15224832' /mnt/pi-root/etc/yonder-pi-storage-prototype.conf
umount /mnt/pi-root
losetup -d "$whole"

cc -std=c11 -O2 -Wall -Wextra -Werror -static -DYONDER_TESTING \
    /tmp/pi-storage/mbr-layout.c \
    -o /usr/lib/yonder/initramfs-bin/yonder-pi-mbr-layout
! readelf -l /usr/lib/yonder/initramfs-bin/yonder-pi-mbr-layout |
    grep -q 'Requesting program interpreter'

cp --reflink=auto /work/base.img /work/grow.img
truncate -s 17179869184 /work/grow.img

table_hash() {
    python3 -I - "$1" <<'PY'
import hashlib, sys
path=sys.argv[1]
with open(path, 'rb') as f:
    sectors=[]
    for sector in (0, 14696448, 15222784):
        f.seek(sector * 512)
        sectors.append(bytearray(f.read(512)))
sectors[0][506:510]=b'\0'*4
sectors[1][474:478]=b'\0'*4
sectors[2][458:462]=b'\0'*4
print(hashlib.sha256(b''.join(sectors)).hexdigest())
PY
}
preserved_table=$(table_hash /work/grow.img)

run_grow() {
    stop=${1:-}
    whole=$(attach_image /work/grow.img)
    mount -o ro "${whole}p2" /mnt/pi-root
    if [[ -n $stop ]]; then
        if YONDER_GROW_STOP_AFTER=$stop /tmp/pi-storage/grow-media.sh /mnt/pi-root; then
            printf 'expected interruption after %s\n' "$stop" >&2
            exit 1
        fi
    else
        /tmp/pi-storage/grow-media.sh /mnt/pi-root
    fi
    umount /mnt/pi-root
    losetup -d "$whole"
}

run_grow container
run_grow link
run_grow media
run_grow
[[ $(table_hash /work/grow.img) == "$preserved_table" ]]

whole=$(attach_image /work/grow.img)
[[ $(cat "/sys/class/block/${whole##*/}p1/start") == 16384 ]]
[[ $(cat "/sys/class/block/${whole##*/}p2/size") == 12582912 ]]
[[ $(cat "/sys/class/block/${whole##*/}p3/size") == 1048576 ]]
[[ $(cat "/sys/class/block/${whole##*/}p5/size") == 524288 ]]
[[ $(cat "/sys/class/block/${whole##*/}p6/start") == 15224832 ]]
[[ $(cat "/sys/class/block/${whole##*/}p6/size") == 18329600 ]]
media_blocks=$(dumpe2fs -h "${whole}p6" 2>/dev/null | sed -n 's/^Block count:[[:space:]]*//p')
media_block_size=$(dumpe2fs -h "${whole}p6" 2>/dev/null | sed -n 's/^Block size:[[:space:]]*//p')
[[ $((media_blocks * media_block_size)) == $((18329600 * 512)) ]]
mount -o ro "${whole}p2" /mnt/pi-root
before_noop=$(sha256sum <(dd if=/work/grow.img bs=512 count=1 status=none) | cut -d' ' -f1)
/tmp/pi-storage/grow-media.sh /mnt/pi-root
after_noop=$(sha256sum <(dd if=/work/grow.img bs=512 count=1 status=none) | cut -d' ' -f1)
[[ $before_noop == "$after_noop" ]]
umount /mnt/pi-root
losetup -d "$whole"

# Exercise the actual Pi mount script on the full MBR/EBR fixture. The root is
# populated only with the path topology needed to prove protected boot/root,
# durable state, bounded logs and independent media.
whole=$(attach_image /work/grow.img)
mount "${whole}p2" /mnt/pi-root
mkdir -p /mnt/pi-root/boot/firmware /mnt/pi-root/etc/yonder \
    /mnt/pi-root/etc/ssh /mnt/pi-root/var/lib/yonder-state \
    /mnt/pi-root/var/lib/yonder/console /mnt/pi-root/var/lib/NetworkManager \
    /mnt/pi-root/var/lib/zerotier-one /mnt/pi-root/var/lib/systemd \
    /mnt/pi-root/var/lib/dbus /mnt/pi-root/var/log/journal \
    /mnt/pi-root/var/lib/yonder/captures /mnt/pi-root/home /mnt/pi-root/root \
    /mnt/pi-root/var/cache /mnt/pi-root/tmp /mnt/pi-root/var/tmp \
    /mnt/pi-root/usr/lib/yonder/storage-prototype
cp /tmp/pi-storage/grow-media.sh \
    /mnt/pi-root/usr/lib/yonder/storage-prototype/grow-media.sh
chmod 0755 /mnt/pi-root/usr/lib/yonder/storage-prototype/grow-media.sh
mount "${whole}p3" /mnt/pi-root/var/lib/yonder-state
mkdir -p /mnt/pi-root/var/lib/yonder-state/config \
    /mnt/pi-root/var/lib/yonder-state/ssh \
    /mnt/pi-root/var/lib/yonder-state/app/captures \
    /mnt/pi-root/var/lib/yonder-state/app/console \
    /mnt/pi-root/var/lib/yonder-state/networkmanager \
    /mnt/pi-root/var/lib/yonder-state/zerotier \
    /mnt/pi-root/var/lib/yonder-state/systemd
printf '%s\n' pi-prototype-v1 >/mnt/pi-root/var/lib/yonder-state/seed-complete
umount /mnt/pi-root/var/lib/yonder-state
umount /mnt/pi-root
mount "${whole}p2" /mnt/pi-root
/bin/sh /tmp/pi-storage/mount-storage.sh /mnt/pi-root
case ",$(findmnt -n -T /mnt/pi-root -o OPTIONS)," in *,ro,*) ;; *) exit 1 ;; esac
case ",$(findmnt -n -T /mnt/pi-root/boot/firmware -o OPTIONS)," in
    *,ro,*) ;; *) exit 1 ;;
esac
[[ $(findmnt -n -T /mnt/pi-root/boot/firmware -o SOURCE) == "${whole}p1" ]]
state_source=$(findmnt -n -T /mnt/pi-root/etc/yonder -o SOURCE)
state_source=${state_source%%\[*}
[[ $state_source == "${whole}p3" ]]
[[ $(findmnt -n -T /mnt/pi-root/var/log/journal -o SOURCE) == "${whole}p5" ]]
[[ $(findmnt -n -T /mnt/pi-root/var/lib/yonder/captures -o SOURCE) == "${whole}p6" ]]
umount --recursive /mnt/pi-root
losetup -d "$whole"

# A wrong disk identifier must fail without changing any table sector.
cp --reflink=auto /work/base.img /work/reject.img
truncate -s 17179869184 /work/reject.img
printf '\220' | dd of=/work/reject.img bs=1 seek=440 conv=notrunc status=none
reject_before=$(sha256sum <(dd if=/work/reject.img bs=512 count=1 status=none) | cut -d' ' -f1)
whole=$(attach_image /work/reject.img)
mount -o ro "${whole}p2" /mnt/pi-root
! /tmp/pi-storage/grow-media.sh /mnt/pi-root
reject_after=$(sha256sum <(dd if=/work/reject.img bs=512 count=1 status=none) | cut -d' ' -f1)
[[ $reject_before == "$reject_after" ]]
umount /mnt/pi-root
losetup -d "$whole"

# A duplicate media UUID on another device must fail before table mutation.
printf '\221\272\033\004' | dd of=/work/reject.img bs=1 seek=440 conv=notrunc status=none
whole=$(attach_image /work/reject.img)
truncate -s 32M /work/foreign.img
foreign=$(losetup --find --show /work/foreign.img)
mkfs.ext4 -q -F -U e43b8b78-96ce-407a-817c-a36156158e6b "$foreign"
mount -o ro "${whole}p2" /mnt/pi-root
reject_before=$(table_hash /work/reject.img)
! /tmp/pi-storage/grow-media.sh /mnt/pi-root
[[ $(table_hash /work/reject.img) == "$reject_before" ]]
umount /mnt/pi-root
losetup -d "$foreign" "$whole"

cleanup_loops
trap - EXIT
printf '%s\n' 'PASS: Pi MBR/EBR growth is prefix-retryable, protected mounts use the real six-partition image, and foreign geometry/identity is rejected.'
TEST
