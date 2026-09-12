#!/bin/bash
# Disposable ARM64 Linux integration tests for the Raspberry Pi image backend.
set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
image=debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1
container=yonder-pi-image-test-$$
cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null
[[ $(docker info --format '{{.OSType}}') == linux ]]
# Loop-backed filesystem mounts require the same unrestricted container
# boundary as the Radxa integration fixture on GitHub's Linux runners.
docker run -d --name "$container" --platform linux/arm64 --privileged \
    "$image" sleep infinity >/dev/null
docker exec "$container" mkdir -p /tmp/yonder-pi /tmp/bench
docker cp "$here/." "$container:/tmp/yonder-pi/"
docker cp "$here/../bench/first-boot.sh" "$container:/tmp/bench/first-boot.sh"
docker exec "$container" sh -c \
    'apt-get update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dosfstools e2fsprogs fdisk openssh-server passwd python3 sudo systemd util-linux >/dev/null'

docker exec -i "$container" /bin/bash -s <<'INTERFACE'
set -euo pipefail
if /tmp/yonder-pi/build-inside.sh unsupported >/tmp/pi-build-usage 2>&1; then
    printf '%s\n' 'FAIL: Pi builder accepted an unsupported mode' >&2
    exit 1
fi
grep -Fxq 'Usage: build-inside.sh private-test|storage-prototype|production' /tmp/pi-build-usage
INTERFACE

docker exec -i "$container" /bin/bash -s <<'LAYOUT'
set -euo pipefail
[[ $(uname -m) == aarch64 && -f /.dockerenv ]]
disk=/tmp/rpi-layout.img
truncate -s 192M "$disk"
sfdisk "$disk" >/dev/null <<'EOF'
label: dos
label-id: 0x1234abcd
unit: sectors

start=2048, size=131072, type=c
start=133120, size=260096, type=83
EOF
[[ -e /dev/loop-control ]] || mknod /dev/loop-control c 10 237
for index in {0..31}; do
    [[ -e /dev/loop$index ]] || mknod "/dev/loop$index" b 7 "$index"
done
attach_reserved_loop() {
    local loop=$1 backing=$2 offset=${3:-} size=${4:-}
    if losetup "$loop" >/dev/null 2>&1; then
        printf 'FAIL: reserved Pi test loop is already allocated: %s\n' "$loop" >&2
        return 1
    fi
    if [[ -n $offset && -n $size ]]; then
        losetup --offset "$offset" --sizelimit "$size" "$loop" "$backing"
    else
        losetup "$loop" "$backing"
    fi
    [[ $(losetup -n -O BACK-FILE "$loop") == "$backing" ]]
}
boot_loop=/dev/loop31
root_loop=/dev/loop30
attach_reserved_loop "$boot_loop" "$disk" $((2048 * 512)) $((131072 * 512))
attach_reserved_loop "$root_loop" "$disk" $((133120 * 512)) $((391168 * 512))
if [[ $boot_loop != /dev/loop31 || $root_loop != /dev/loop30 ]]; then
    printf '%s\n' 'FAIL: Pi layout fixture did not use its reserved high loop devices' >&2
    exit 1
fi
boot_loop_diskseq=$(<"/sys/class/block/${boot_loop##*/}/diskseq")
root_loop_diskseq=$(<"/sys/class/block/${root_loop##*/}/diskseq")
unmount_layout_path() {
    local path=$1 attempt
    for attempt in {1..20}; do
        if ! mountpoint -q "$path"; then
            return 0
        fi
        umount "$path" 2>/dev/null || true
        sleep 0.05
    done
    printf 'FAIL: Pi layout cleanup could not unmount %s\n' "$path" >&2
    return 1
}
cleanup_layout() {
    local cleanup_status=0 loop
    unmount_layout_path /mnt/layout/boot || cleanup_status=1
    unmount_layout_path /mnt/layout/root || cleanup_status=1
    for loop in "$boot_loop" "$root_loop"; do
        if losetup "$loop" >/dev/null 2>&1 && ! losetup -d "$loop"; then
            cleanup_status=1
        fi
    done
    return "$cleanup_status"
}
trap cleanup_layout EXIT
mkfs.vfat -F 32 -n bootfs -i B2F082D2 "$boot_loop" >/dev/null 2>&1
mkfs.ext4 -q -F -L rootfs -U 15f4c6be-1102-4331-9904-f78e78afd1fd "$root_loop"
mkdir -p /mnt/layout/boot /mnt/layout/root
mount "$boot_loop" /mnt/layout/boot
mount "$root_loop" /mnt/layout/root
printf '%s\n' firmware-preserved >/mnt/layout/boot/config.txt
printf '%s\n' root-preserved >/mnt/layout/root/probe
sync
(
    cd /mnt/layout/boot
    sleep 0.2
) &
layout_holder=$!
unmount_layout_path /mnt/layout/boot
unmount_layout_path /mnt/layout/root
wait "$layout_holder"
if mountpoint -q /mnt/layout/boot || mountpoint -q /mnt/layout/root; then
    printf '%s\n' 'FAIL: Pi layout cleanup accepted a busy mount and left it behind' >&2
    exit 1
fi
boot_hash=$(dd if="$disk" bs=512 skip=2048 count=131072 status=none | sha256sum | cut -d' ' -f1)

/tmp/yonder-pi/layout.sh "$disk" 268435456 0x1234abcd \
    2048 131072 0x0c 133120 260096 0x83 >/dev/null

[[ $(stat -c %s "$disk") == 268435456 ]]
[[ $(sfdisk --disk-id "$disk") == 0x1234abcd ]]
mapfile -t partition_facts < <(sfdisk --json "$disk" | python3 -I -c '
import json, sys
p=json.load(sys.stdin)["partitiontable"]["partitions"]
for item in p: print(item["start"], item["size"], item["type"])
')
[[ ${partition_facts[0]} == '2048 131072 c' ]]
[[ ${partition_facts[1]} == '133120 391168 83' ]]
[[ $(dd if="$disk" bs=512 skip=2048 count=131072 status=none | sha256sum | cut -d' ' -f1) == "$boot_hash" ]]

if [[ $(<"/sys/class/block/${boot_loop##*/}/diskseq") != "$boot_loop_diskseq" \
    || $(<"/sys/class/block/${root_loop##*/}/diskseq") != "$root_loop_diskseq" ]]; then
    printf '%s\n' 'FAIL: Pi layout test recycled lazy-detached loop devices between phases' >&2
    exit 1
fi
losetup -c "$root_loop"
e2fsck -fy "$root_loop" >/dev/null 2>&1
resize2fs "$root_loop" >/dev/null 2>&1
mount "$boot_loop" /mnt/layout/boot
mount "$root_loop" /mnt/layout/root
[[ $(cat /mnt/layout/boot/config.txt) == firmware-preserved ]]
[[ $(cat /mnt/layout/root/probe) == root-preserved ]]
[[ $(blkid -s UUID -o value "$boot_loop") == B2F0-82D2 ]]
[[ $(blkid -s UUID -o value "$root_loop") == 15f4c6be-1102-4331-9904-f78e78afd1fd ]]
umount /mnt/layout/boot
umount /mnt/layout/root
dosfsck -n "$boot_loop" >/dev/null 2>&1
e2fsck -fn "$root_loop" >/dev/null 2>&1
losetup -d "$boot_loop"
losetup -d "$root_loop"
trap - EXIT

# Cleanup must detach only loops backed by its private disk and unmount the
# actual nested boot/root topology used by the builder.
mkdir -p /work /target
cp "$disk" /work/disk.img
boot_loop=/dev/loop29
root_loop=/dev/loop28
attach_reserved_loop "$boot_loop" /work/disk.img $((2048 * 512)) $((131072 * 512))
attach_reserved_loop "$root_loop" /work/disk.img $((133120 * 512)) $((391168 * 512))
printf '%s\n%s\n' "$boot_loop" "$root_loop" >/work/pi-loops
mount "$root_loop" /target
mkdir -p /target/boot/firmware /target/proc /target/dev /target/run \
    /target/var/lib/yonder/captures /target/var/log/journal \
    /target/var/lib/yonder-state
mount "$boot_loop" /target/boot/firmware
mount -t tmpfs tmpfs /target/var/lib/yonder/captures
mount -t tmpfs tmpfs /target/var/log/journal
mount -t tmpfs tmpfs /target/var/lib/yonder-state
mount -t proc proc /target/proc
mount -t tmpfs tmpfs /target/dev
mount -t tmpfs tmpfs /target/run
mkdir /target/run/yonder-apt
mount -t tmpfs -o ro tmpfs /target/run/yonder-apt
/tmp/yonder-pi/cleanup.sh
! mountpoint -q /target/run/yonder-apt
! mountpoint -q /target
! losetup "$boot_loop" >/dev/null 2>&1
! losetup "$root_loop" >/dev/null 2>&1
[[ ! -e /work/pi-loops ]]

# Cancellation can arrive after allocating a loop but before the marker exists.
truncate -s 8M /work/disk.img
early_loop=/dev/loop27
attach_reserved_loop "$early_loop" /work/disk.img
[[ ! -e /work/pi-loops ]]
/tmp/yonder-pi/cleanup.sh
! losetup "$early_loop" >/dev/null 2>&1

# A detached marker loop may be reused for an unrelated backing file. Cleanup
# must use the copied image's file identity and leave that reused loop alone.
stale_loop=/dev/loop26
attach_reserved_loop "$stale_loop" /work/disk.img
printf '%s\n' "$stale_loop" >/work/pi-loops
losetup -d "$stale_loop"
truncate -s 8M /tmp/unrelated.img
attach_reserved_loop "$stale_loop" /tmp/unrelated.img
private_loop=/dev/loop25
attach_reserved_loop "$private_loop" /work/disk.img
/tmp/yonder-pi/cleanup.sh
! losetup "$private_loop" >/dev/null 2>&1
[[ $(losetup -n -O BACK-FILE "$stale_loop") == /tmp/unrelated.img ]]
[[ ! -e /work/pi-loops ]]
losetup -d "$stale_loop"
printf '%s\n' 'PASS: Pi layout growth preserved the real FAT/ext4 boundary, data and identifiers.'
LAYOUT

docker exec -i "$container" /bin/bash -s <<'PREPARE'
set -euo pipefail
install -d -m 0755 /boot/firmware /etc/yonder /var/lib/yonder/console \
    /var/lib/zerotier-one /root/.ssh /run/yonder-bench-input /run/sshd \
    /etc/cloud /usr/lib/systemd/system /etc/systemd/system/multi-user.target.wants \
    /etc/systemd/system/sysinit.target.wants
chmod 0700 /run/yonder-bench-input
printf '%s\n' 'Raspberry Pi reference 2026-06-18' >/etc/rpi-issue
printf '%s\n' '[all]' 'arm_64bit=1' >/boot/firmware/config.txt
for file in bcm2710-rpi-3-b.dtb bcm2711-rpi-4-b.dtb bcm2712-rpi-5-b.dtb kernel8.img kernel_2712.img; do
    : >"/boot/firmware/$file"
done
printf '%s\n' 'console=serial0,115200 console=tty1 root=PARTUUID=1234abcd-02 rootwait resize' \
    >/boot/firmware/cmdline.txt
printf '%s\n' 'network:' '  access_point:' '    ssid: yonder' '    address: 192.168.77.1/24' \
    'console:' '  port: 3000' >/etc/yonder/config.yaml
printf '%s\n' "module.exports = { flowFile: 'setup-flows.json' }" >/var/lib/yonder/console/settings.js
groupadd --system yonder
install -d -m 0750 -o root -g yonder /var/lib/yonder
for unit in userconfig.service rpi-resize.service sshswitch.service regenerate_ssh_host_keys.service; do
    printf '[Unit]\nDescription=fixture %s\n[Service]\nType=oneshot\nExecStart=/bin/true\n[Install]\nWantedBy=multi-user.target\n' "$unit" \
        >"/usr/lib/systemd/system/$unit"
    ln -s "/usr/lib/systemd/system/$unit" "/etc/systemd/system/multi-user.target.wants/$unit"
done
printf '%s\n' '#cloud-config' >/boot/firmware/user-data
printf '%s\n' 'instance_id: rpios-image' >/boot/firmware/meta-data
printf '%s\n' old-machine >/etc/machine-id
printf '%s\n' old-secret >/etc/yonder/secrets.yaml
printf '%s\n' old-identity >/var/lib/zerotier-one/identity.secret
ssh-keygen -q -t ed25519 -N '' -f /run/yonder-test-key
cp /run/yonder-test-key.pub /run/yonder-bench-input/authorized_key
printf '%s\n' bench-test-password >/run/yonder-bench-input/password
chmod 0600 /run/yonder-bench-input/password /run/yonder-bench-input/authorized_key
rm -f /etc/ssh/ssh_host_*

/tmp/yonder-pi/prepare-rootfs.sh --private-test

record=$(getent passwd yonder-bench)
[[ $(cut -d: -f6 <<<"$record") == /home/yonder-bench ]]
[[ $(cut -d: -f7 <<<"$record") == /bin/bash ]]
id -nG yonder-bench | tr ' ' '\n' | grep -qx sudo
[[ $(getent shadow root | cut -d: -f2) == '!'* ]]
[[ $(stat -c %a /etc/sudoers.d/zz-yonder-bench) == 440 ]]
grep -qx 'yonder-bench ALL=(ALL:ALL) PASSWD: ALL' /etc/sudoers.d/zz-yonder-bench
grep -qx 'PermitRootLogin no' /etc/ssh/sshd_config
grep -qx 'PasswordAuthentication yes' /etc/ssh/sshd_config
grep -qx 'AllowUsers yonder-bench' /etc/ssh/sshd_config
cmp /run/yonder-test-key.pub /home/yonder-bench/.ssh/authorized_keys
[[ -e /etc/cloud/cloud-init.disabled ]]
for unit in userconfig.service rpi-resize.service sshswitch.service regenerate_ssh_host_keys.service; do
    [[ $(readlink "/etc/systemd/system/$unit") == /dev/null ]]
done
grep -Eq '(^| )root=PARTUUID=1234abcd-02( |$)' /boot/firmware/cmdline.txt
! grep -Eq '(^| )resize( |$)|console=serial0' /boot/firmware/cmdline.txt
grep -qx 'kind=private-rpi-test' /etc/yonder/bench-image
grep -qx 'target=rpi' /etc/yonder/bench-image
grep -qx 'writable_root=true' /etc/yonder/bench-image
grep -qx 'protected_storage=false' /etc/yonder/bench-image
grep -qx 'hardware_qualified=false' /etc/yonder/bench-image
[[ ! -s /etc/machine-id ]]
[[ -f /etc/yonder/secrets.yaml && ! -s /etc/yonder/secrets.yaml \
    && $(stat -c %a /etc/yonder/secrets.yaml) == 600 ]]
[[ ! -e /var/lib/zerotier-one/identity.secret ]]
[[ ! -e /run/yonder-bench-input/password && ! -e /run/yonder-bench-input/authorized_key ]]
[[ ! -e /run/yonder-sshd-config-test-key && ! -e /run/yonder-sshd-config-test-key.pub ]]
[[ -x /usr/local/sbin/yonder-bench-first-boot ]]
[[ -L /etc/systemd/system/multi-user.target.wants/yonder-bench-first-boot.service ]]
[[ -L /etc/systemd/system/multi-user.target.wants/ssh.service ]]
printf '%s\n' 'PASS: Pi private-test preparation retired upstream first-use paths and installed bounded access.'
PREPARE

printf '%s\n' 'PASS: Raspberry Pi image backend Linux integration fixtures.'
