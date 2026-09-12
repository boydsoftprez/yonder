#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Explicit Radxa storage experiment, run only in the image target chroot.
set -eu
umask 022
[ "$#" -eq 22 ] && [ "$(id -u)" = 0 ] || exit 2
[ -d /opt/yonder-src/image/prototype ] || exit 2
install_mode=${YONDER_STORAGE_INSTALL_MODE:-prototype}
case "$install_mode" in
    prototype)
        [ -f /etc/yonder/bench-image ] || exit 2
        grep -Eq '^target=radxa-(zero3w|rock5c)$' /etc/yonder/bench-image
        config=/etc/yonder-storage-prototype.conf
        ;;
    production)
        [ -f /etc/yonder-storage-layout.conf ] && [ ! -L /etc/yonder-storage-layout.conf ] || exit 2
        config=/etc/yonder-storage-layout.conf
        ;;
    *) exit 2 ;;
esac
maintenance_helper=/tmp/yonder-maintenance-token.$$
cleanup() { rm -f "$maintenance_helper"; }
trap cleanup EXIT HUP INT TERM
if [ "$install_mode" = production ]; then
    prebuilt_helper=/opt/yonder-src/image/storage/maintenance-token.arm64
    prebuilt_hash=$prebuilt_helper.sha256
    [ -f "$prebuilt_helper" ] && [ ! -L "$prebuilt_helper" ] \
        && [ "$(stat -c '%u:%g:%a' "$prebuilt_helper")" = 0:0:755 ] \
        || exit 1
    [ -f "$prebuilt_hash" ] && [ ! -L "$prebuilt_hash" ] \
        && [ "$(stat -c '%u:%g:%a:%s' "$prebuilt_hash")" = 0:0:600:65 ] \
        || exit 1
    expected_hash=$(cat "$prebuilt_hash") || exit 1
    printf '%s\n' "$expected_hash" | grep -Eq '^[a-f0-9]{64}$' || exit 1
    printf '%s  %s\n' "$expected_hash" "$prebuilt_helper" | sha256sum -c - >/dev/null
    cp "$prebuilt_helper" "$maintenance_helper"
else
    cc -std=c11 -O2 -Wall -Wextra -Werror -static \
        /opt/yonder-src/image/storage/maintenance-token.c -o "$maintenance_helper"
    readelf -l "$maintenance_helper" | grep -q 'Requesting program interpreter' && exit 1
fi
argument=1
for uuid in "$@"; do
    [ "$argument" -le 13 ] || break
    printf '%s\n' "$uuid" | grep -Eq '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    argument=$((argument + 1))
done
for number in "${14}" "${15}" "${16}" "${17}" "${18}" "${19}" "${20}" "${21}"; do
    case "$number" in ''|*[!0-9]*) exit 2 ;; esac
done
[ "${22}" = yonder-media ] || exit 2
if [ "$install_mode" = prototype ]; then
cat >"$config" <<EOF
ROOT_UUID=$1
STATE_UUID=$2
LOG_UUID=$3
MEDIA_UUID=$4
DISK_GUID=$5
ROOT_PARTUUID=$6
STATE_PARTUUID=$7
LOG_PARTUUID=$8
MEDIA_PARTUUID=$9
ROOT_TYPE_GUID=${10}
STATE_TYPE_GUID=${11}
LOG_TYPE_GUID=${12}
MEDIA_TYPE_GUID=${13}
ROOT_START=${14}
ROOT_SIZE=${15}
STATE_START=${16}
STATE_SIZE=${17}
LOG_START=${18}
LOG_SIZE=${19}
MEDIA_START=${20}
MEDIA_MIN_SIZE=${21}
MEDIA_PARTLABEL=${22}
EOF
chmod 0644 "$config"
fi
install -d -m 0755 /usr/lib/yonder/storage-prototype /etc/initramfs-tools/hooks /etc/initramfs-tools/scripts/init-bottom
install -m 0755 /opt/yonder-src/image/prototype/mount-storage.sh /usr/lib/yonder/storage-prototype/mount-storage.sh
install -m 0755 /opt/yonder-src/image/prototype/grow-media.sh /usr/lib/yonder/storage-prototype/grow-media.sh
install -m 0755 "$maintenance_helper" /usr/lib/yonder/storage-prototype/yonder-maintenance-token
install -m 0755 /opt/yonder-src/image/prototype/initramfs-hook /etc/initramfs-tools/hooks/yonder-storage-prototype
install -m 0755 /opt/yonder-src/image/prototype/init-bottom /etc/initramfs-tools/scripts/init-bottom/99-yonder-storage-prototype
install -m 0755 /opt/yonder-src/image/prototype/status.sh /usr/local/sbin/yonder-storage-prototype-status
# This lives on the persistent system partition, not the RAM copy of /etc.
install -d -m 0755 /usr/lib/systemd/system/dpkg-db-backup.service.d
install -m 0644 /opt/yonder-src/image/prototype/dpkg-db-backup.conf \
    /usr/lib/systemd/system/dpkg-db-backup.service.d/70-yonder-protected-storage.conf
# The initramfs mounts children before systemd; its root-remount unit must keep
# the underlying system read-only. Armbian /boot is part of this same filesystem.
awk 'BEGIN { OFS="\t" } /^[[:space:]]*#/ { print; next } $2=="/" { $4="ro,noatime,data=ordered,commit=5,errors=remount-ro" } $2=="/tmp" { next } { print }' /etc/fstab >/etc/fstab.prototype
mv /etc/fstab.prototype /etc/fstab
for unit in apt-daily.service apt-daily.timer apt-daily-upgrade.service apt-daily-upgrade.timer \
        armbian-zram-config.service logrotate.timer logrotate.service; do
    systemctl disable "$unit" >/dev/null 2>&1 || true
    if [ -f "/etc/systemd/system/$unit" ] && [ ! -L "/etc/systemd/system/$unit" ]; then
        install -d -m 0755 /usr/lib/yonder/storage-prototype/disabled-units
        mv "/etc/systemd/system/$unit" "/usr/lib/yonder/storage-prototype/disabled-units/$unit"
    fi
    systemctl mask "$unit" >/dev/null
done
# RAM-only swap is left off for the first 2 GiB ZERO3W experiment. Pi memory
# qualification is a separate gate; no SD-backed swap file is created.
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
    sed -i 's/^writable_root=true$/writable_root=false/;s/^protected_storage=false$/protected_storage=prototype/' /etc/yonder/bench-image
    printf '%s\n' 'owner_recovery_implemented=false' >>/etc/yonder/bench-image
fi
mkdir -p /var/lib/dbus /var/lib/yonder/captures
state=/var/lib/yonder-state
mountpoint -q "$state"
mountpoint -q /var/log/journal
mountpoint -q /var/lib/yonder/captures
chown root:systemd-journal /var/log/journal
chmod 2755 /var/log/journal
[ ! -e "$state/seed-complete" ]
chmod 0700 "$state"
for mapping in 'config etc/yonder' 'ssh etc/ssh' 'app var/lib/yonder' \
        'networkmanager var/lib/NetworkManager' 'zerotier var/lib/zerotier-one' \
        'systemd var/lib/systemd'; do
    # These are fixed, space-delimited mappings from trusted source.
    # shellcheck disable=SC2086
    set -- $mapping
    mkdir -p "/$2"
    # Never recurse through the nested state/media mounts during the app copy.
    cp -a -x "/$2" "$state/$1"
done
# cp -x preserves mount-point directories but not their contents.
mkdir -p "$state/app/captures"
printf '%s\n' 'prototype-v1' >"$state/seed-complete"
chmod 0600 "$state/seed-complete"
sync -f "$state"
kernel=6.1.115-vendor-rk35xx
[ -d "/lib/modules/$kernel" ]
update-initramfs -u -k "$kernel"
# U-Boot loads uInitrd, not initrd.img. Verify its real payload rather than
# accepting an old, nonempty wrapper left behind by a failed update hook.
archive=/boot/initrd.img-$kernel
[ -s "$archive" ]
listing=$(lsinitramfs "$archive")
printf '%s\n' "$listing" | grep -q '^scripts/yonder-mount-storage$'
printf '%s\n' "$listing" | grep -q '^scripts/init-bottom/99-yonder-storage-prototype$'
printf '%s\n' "$listing" | grep -q '^usr/lib/yonder/initramfs-bin/yonder-maintenance-token$'
python3 /opt/yonder-src/image/prototype/verify_uinitrd.py /boot/uInitrd "$archive" /boot/boot.scr
cleanup
trap - EXIT HUP INT TERM
