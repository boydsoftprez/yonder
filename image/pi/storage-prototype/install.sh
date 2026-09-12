#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Install the Pi-only storage prototype into an assembled target root.
set -eu
umask 022

die() {
    echo "Yonder Pi storage install: $*" >&2
    exit 1
}

[ "$#" -eq 0 ] && [ "$(id -u)" = 0 ] || exit 2
source_dir=/opt/yonder-src/image/pi/storage-prototype
[ -d "$source_dir" ] && [ -f /etc/rpi-issue ] || exit 2
install_mode=${YONDER_STORAGE_INSTALL_MODE:-prototype}
case "$install_mode" in
    prototype)
        [ -f /etc/yonder/bench-image ] || exit 2
        grep -qx 'target=rpi' /etc/yonder/bench-image || exit 2
        config=/etc/yonder-pi-storage-prototype.conf
        ;;
    production)
        config=/etc/yonder-storage-layout.conf
        ;;
    *) exit 2 ;;
esac
[ -f "$config" ] && [ ! -L "$config" ] ||
    die 'assembled layout configuration is missing'
for path in /boot/firmware /var/lib/yonder-state /var/log/journal \
        /var/lib/yonder/captures; do
    mountpoint -q "$path" || die "$path is not a construction mount"
done

# The runtime helper has no arbitrary-device interface and is static so its
# initramfs execution cannot depend on an untracked dynamic loader.
build_helper=/tmp/yonder-pi-mbr-layout.$$
maintenance_helper=/tmp/yonder-maintenance-token.$$
cleanup() {
    rm -f "$build_helper" "$maintenance_helper"
}
trap cleanup EXIT HUP INT TERM
if [ "$install_mode" = production ]; then
    for specification in \
            "$source_dir/yonder-pi-mbr-layout.arm64 $build_helper" \
            "/opt/yonder-src/image/storage/maintenance-token.arm64 $maintenance_helper"; do
        # shellcheck disable=SC2086 # fixed trusted source/destination pairs
        set -- $specification
        [ -f "$1" ] && [ ! -L "$1" ] \
            && [ "$(stat -c '%u:%g:%a' "$1")" = 0:0:755 ] \
            || die 'prebuilt storage helper metadata is invalid'
        [ -f "$1.sha256" ] && [ ! -L "$1.sha256" ] \
            && [ "$(stat -c '%u:%g:%a:%s' "$1.sha256")" = 0:0:600:65 ] \
            || die 'prebuilt storage helper hash metadata is invalid'
        expected_hash=$(cat "$1.sha256") \
            || die 'prebuilt storage helper hash is missing'
        printf '%s\n' "$expected_hash" | grep -Eq '^[a-f0-9]{64}$' \
            || die 'prebuilt storage helper hash is invalid'
        printf '%s  %s\n' "$expected_hash" "$1" | sha256sum -c - >/dev/null \
            || die 'prebuilt storage helper checksum failed'
        cp "$1" "$2"
    done
else
    cc -std=c11 -O2 -Wall -Wextra -Werror -static "$source_dir/mbr-layout.c" \
        -o "$build_helper"
    cc -std=c11 -O2 -Wall -Wextra -Werror -static \
        /opt/yonder-src/image/storage/maintenance-token.c -o "$maintenance_helper"
    if readelf -l "$build_helper" | grep -q 'Requesting program interpreter'; then
        die 'MBR layout helper is dynamically linked'
    fi
    if readelf -l "$maintenance_helper" | grep -q 'Requesting program interpreter'; then
        die 'maintenance token helper is dynamically linked'
    fi
fi

install -d -m 0755 /usr/lib/yonder/storage-prototype \
    /etc/initramfs-tools/hooks /etc/initramfs-tools/scripts/init-bottom \
    /usr/lib/systemd/system/dpkg-db-backup.service.d
install -m 0755 "$build_helper" \
    /usr/lib/yonder/storage-prototype/yonder-pi-mbr-layout
install -m 0755 "$maintenance_helper" \
    /usr/lib/yonder/storage-prototype/yonder-maintenance-token
install -m 0755 "$source_dir/mount-storage.sh" \
    /usr/lib/yonder/storage-prototype/mount-storage.sh
install -m 0755 "$source_dir/grow-media.sh" \
    /usr/lib/yonder/storage-prototype/grow-media.sh
install -m 0755 "$source_dir/initramfs-hook" \
    /etc/initramfs-tools/hooks/yonder-pi-storage-prototype
install -m 0755 "$source_dir/init-bottom" \
    /etc/initramfs-tools/scripts/init-bottom/99-yonder-pi-storage-prototype
install -m 0755 "$source_dir/status.sh" \
    /usr/local/sbin/yonder-storage-prototype-status
install -m 0644 "$source_dir/dpkg-db-backup.conf" \
    /usr/lib/systemd/system/dpkg-db-backup.service.d/70-yonder-protected-storage.conf

# Both the root filesystem and the independently loaded firmware filesystem are
# protected during ordinary boot. A future maintenance transaction must remount
# both explicitly before kernel/initramfs package work.
awk 'BEGIN { OFS="\t" }
    /^[[:space:]]*#/ { print; next }
    $2=="/" { $4="ro,noatime,data=ordered,commit=5,errors=remount-ro" }
    $2=="/boot/firmware" { $4="ro,noatime" }
    $2=="/tmp" { next }
    { print }
' /etc/fstab >/etc/fstab.yonder-pi-storage
mv /etc/fstab.yonder-pi-storage /etc/fstab
grep -Eq '^PARTUUID=041bba91-01[[:space:]]+/boot/firmware[[:space:]]+vfat[[:space:]]+ro,noatime' \
    /etc/fstab || die 'firmware fstab entry was not protected'
grep -Eq '^PARTUUID=041bba91-02[[:space:]]+/[[:space:]]+ext4[[:space:]]+ro,noatime' \
    /etc/fstab || die 'root fstab entry was not protected'

for unit in apt-daily.service apt-daily.timer apt-daily-upgrade.service \
        apt-daily-upgrade.timer logrotate.timer logrotate.service rsyslog.service \
        rpi-swap.service dphys-swapfile.service; do
    systemctl disable "$unit" >/dev/null 2>&1 || true
    if [ -f "/etc/systemd/system/$unit" ] && [ ! -L "/etc/systemd/system/$unit" ]; then
        install -d -m 0755 /usr/lib/yonder/storage-prototype/disabled-units
        mv "/etc/systemd/system/$unit" \
            "/usr/lib/yonder/storage-prototype/disabled-units/$unit"
    fi
    systemctl mask "$unit" >/dev/null
done
install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/70-yonder-storage-prototype.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=128M
SystemKeepFree=32M
SystemMaxFileSize=8M
RuntimeMaxUse=8M
SyncIntervalSec=10s
MaxLevelStore=info
EOF
chmod 0644 /etc/systemd/journald.conf.d/70-yonder-storage-prototype.conf

if [ "$install_mode" = prototype ]; then
    sed -i \
        's/^writable_root=true$/writable_root=false/;s/^protected_storage=false$/protected_storage=prototype/' \
        /etc/yonder/bench-image
    printf '%s\n' 'owner_recovery_implemented=false' >>/etc/yonder/bench-image
fi

state=/var/lib/yonder-state
[ ! -e "$state/seed-complete" ] || die 'state seed already exists'
chmod 0700 "$state"
mkdir -p /var/lib/dbus /var/lib/yonder/captures
chown root:systemd-journal /var/log/journal
chmod 2755 /var/log/journal
for mapping in 'config etc/yonder' 'ssh etc/ssh' 'app var/lib/yonder' \
        'networkmanager var/lib/NetworkManager' 'zerotier var/lib/zerotier-one' \
        'systemd var/lib/systemd'; do
    # shellcheck disable=SC2086 # fixed trusted source/destination pairs
    set -- $mapping
    mkdir -p "/$2"
    cp -a -x "/$2" "$state/$1"
done
mkdir -p "$state/app/captures"
printf '%s\n' 'pi-prototype-v1' >"$state/seed-complete"
chmod 0600 "$state/seed-complete"
sync -f "$state"

# The exact Pi pin supplies two independently booted kernel families. Storage
# filesystems are built into each kernel, and each generated archive must reach
# the FAT filename selected by auto_initramfs.
set -- /lib/modules/*-rpi-v8
[ "$#" -eq 1 ] && [ -d "$1" ] || die 'expected exactly one Pi v8 kernel'
kernel_v8=${1##*/}
set -- /lib/modules/*-rpi-2712
[ "$#" -eq 1 ] && [ -d "$1" ] || die 'expected exactly one Pi 2712 kernel'
kernel_2712=${1##*/}
for kernel in "$kernel_v8" "$kernel_2712"; do
    config=/boot/config-$kernel
    [ -f "$config" ] || die "kernel configuration is missing for $kernel"
    for option in CONFIG_EXT4_FS CONFIG_FAT_FS CONFIG_VFAT_FS \
            CONFIG_NLS_CODEPAGE_437 CONFIG_NLS_ASCII; do
        grep -qx "$option=y" "$config" ||
            die "$kernel does not build in $option"
    done
    update-initramfs -u -k "$kernel"
done

grep -Eq '^[[:space:]]*auto_initramfs=1([[:space:]]|$)' \
    /boot/firmware/config.txt || die 'firmware automatic initramfs loading is disabled'
for specification in \
        "$kernel_v8 initramfs8" \
        "$kernel_2712 initramfs_2712"; do
    # shellcheck disable=SC2086 # fixed trusted kernel/firmware pair
    set -- $specification
    archive=/boot/initrd.img-$1
    firmware=/boot/firmware/$2
    [ -s "$archive" ] && [ -s "$firmware" ] ||
        die "generated initramfs for $1 is missing"
    cmp "$archive" "$firmware" ||
        die "firmware initramfs $2 is stale"
    listing=$(lsinitramfs "$archive")
    printf '%s\n' "$listing" | grep -q '^scripts/yonder-pi-mount-storage$' ||
        die "$1 initramfs lacks the Pi mount script"
    printf '%s\n' "$listing" | grep -q '^scripts/yonder-pi-grow-media$' ||
        die "$1 initramfs lacks the Pi grow script"
    printf '%s\n' "$listing" |
        grep -q '^usr/lib/yonder/initramfs-bin/yonder-pi-mbr-layout$' ||
        die "$1 initramfs lacks the Pi MBR helper"
    printf '%s\n' "$listing" |
        grep -q '^usr/lib/yonder/initramfs-bin/yonder-maintenance-token$' ||
        die "$1 initramfs lacks the maintenance token helper"
done
cmp /boot/firmware/initramfs8 /boot/firmware/initramfs_2712 >/dev/null 2>&1 &&
    die 'Pi kernel variants unexpectedly share one initramfs'

cleanup
trap - EXIT HUP INT TERM
printf '%s\n' 'pi-storage-install: protected mounts and both firmware initramfs variants installed'
