#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Remove build and upstream identities before protected storage is seeded.
set +x
set -eu
umask 077

die() { printf 'image-finalize: %s\n' "$*" >&2; exit 1; }
usage() { printf '%s\n' 'Usage: finalize.sh --target rpi|radxa-zero3w|radxa-rock5c' >&2; exit 2; }

[ "$#" -eq 2 ] && [ "$1" = --target ] || usage
target=$2
case "$target" in rpi|radxa-zero3w|radxa-rock5c) ;; *) usage ;; esac
[ "$(id -u)" = 0 ] || die 'root is required'
[ "$(dpkg --print-architecture)" = arm64 ] || die 'target rootfs is not Debian ARM64'
[ -f /opt/yonder-src/config/defaults/config.yaml ] || die 'factory configuration source is missing'
[ -x /usr/bin/systemctl ] && [ -x /usr/sbin/usermod ] || die 'required target tools are missing'
cmp /opt/yonder-src/config/defaults/config.yaml /etc/yonder/config.yaml \
    || die 'installed configuration is not the factory default'

empty_directory() {
    directory=$1
    [ ! -e "$directory" ] && return 0
    [ -d "$directory" ] && [ ! -L "$directory" ] || die "$directory is not a directory"
    find "$directory" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
}

disable_and_mask() {
    for unit in "$@"; do
        systemctl disable "$unit" >/dev/null 2>&1 || true
        systemctl mask "$unit" >/dev/null 2>&1 || die "could not mask $unit"
    done
}

# A release build never needs or creates this account. Remove it if the
# finalizer is deliberately exercised against a dirty private-test fixture;
# every other ordinary login account remains a hard failure below.
if getent passwd yonder-bench >/dev/null 2>&1; then
    /usr/sbin/userdel --remove yonder-bench >/dev/null 2>&1 \
        || die 'could not remove the private-test account'
fi
if getent group yonder-bench >/dev/null 2>&1; then
    /usr/sbin/groupdel yonder-bench >/dev/null 2>&1 \
        || die 'could not remove the private-test group'
fi
if awk -F: '$3 >= 1000 && $3 < 60000 { print $1 }' /etc/passwd | grep -q .; then
    die 'an ordinary login account remains in the factory image'
fi

systemctl disable yonder-bench-first-boot.service >/dev/null 2>&1 || true
rm -f /etc/yonder/bench-image /usr/local/sbin/yonder-bench-first-boot \
    /etc/systemd/system/yonder-bench-first-boot.service \
    /etc/systemd/system/multi-user.target.wants/yonder-bench-first-boot.service \
    /etc/systemd/system/ssh.service.d/yonder-bench-first-boot.conf \
    /etc/sudoers.d/zz-yonder-bench
rm -rf /run/yonder-bench-input

# SSH is projected from the durable owner record. The ownerless generation
# disables the service on first boot; keep it closed before that projection as
# well, and prevent socket activation from reopening it.
systemctl disable ssh.service >/dev/null 2>&1 || true
disable_and_mask ssh.socket
/usr/sbin/usermod --lock root
root_shadow=$(getent shadow root | cut -d: -f2)
case "$root_shadow" in '!'*|'*'*) ;; *) die 'root login is not locked' ;; esac
rm -f /etc/ssh/ssh_host_* /root/.ssh/authorized_keys \
    /etc/ssh/sshd_config.d/00-yonder-owner.conf \
    /etc/sudoers.d/yonder-owner
rm -rf /etc/ssh/yonder_authorized_keys
if [ -d /home ]; then
    find /home -type f \( -name authorized_keys -o -name .bash_history \) -delete
fi

rm -f /var/lib/systemd/random-seed /var/lib/dbus/machine-id \
    /root/.bash_history /root/.lesshst /root/.wget-hsts
: >/etc/machine-id
chmod 0444 /etc/machine-id

# No device-specific Yonder, mesh, network or cloud state may be copied into
# the durable state filesystem by the storage installer.
empty_directory /var/lib/yonder-state
rm -f /var/lib/yonder/apply.json /var/lib/yonder/mavlink-link.json
rm -rf /var/lib/yonder/console/context \
    /var/lib/yonder/console/.sessions.json \
    /var/lib/yonder/console/flows_cred.json
empty_directory /etc/NetworkManager/system-connections
empty_directory /var/lib/NetworkManager
rm -f /var/lib/zerotier-one/identity.public \
    /var/lib/zerotier-one/identity.secret \
    /var/lib/zerotier-one/authtoken.secret
rm -rf /var/lib/zerotier-one/networks.d /var/lib/zerotier-one/peers.d
empty_directory /var/lib/cloud

case "$target" in
    rpi)
        [ -f /etc/rpi-issue ] && [ -f /boot/firmware/cmdline.txt ] \
            || die 'Raspberry Pi base markers are missing'
        disable_and_mask userconfig.service rpi-resize.service sshswitch.service \
            regenerate_ssh_host_keys.service
        install -d -m 0755 /etc/cloud
        : >/etc/cloud/cloud-init.disabled
        awk '{
            out = ""
            for (i = 1; i <= NF; i++) {
                if ($i == "resize") continue
                out = out (out == "" ? "" : " ") $i
            }
            print out
        }' /boot/firmware/cmdline.txt >/boot/firmware/cmdline.txt.new
        [ "$(awk 'END { print NR }' /boot/firmware/cmdline.txt.new)" -eq 1 ] \
            || die 'Raspberry Pi command line is not exactly one line'
        mv /boot/firmware/cmdline.txt.new /boot/firmware/cmdline.txt
        rm -f /boot/firmware/userconf /boot/firmware/userconf.txt \
            /boot/firmware/firstrun.sh /boot/firmware/user-data \
            /boot/firmware/meta-data
        ;;
    radxa-zero3w|radxa-rock5c)
        [ -f /etc/armbian-release ] && [ -f /boot/armbianEnv.txt ] \
            || die 'Armbian base markers are missing'
        disable_and_mask armbian-firstrun.service armbian-firstrun-config.service \
            armbian-resize-filesystem.service armbian-ramlog.service rsyslog.service
        install -d -m 0755 /usr/lib/yonder/disabled-first-use
        for profile in /etc/profile.d/armbian-check-first-login*.sh \
                /etc/profile.d/armbian-firstlogin*.sh; do
            [ -f "$profile" ] || continue
            mv "$profile" "/usr/lib/yonder/disabled-first-use/$(basename "$profile")"
        done
        rm -f /root/.not_logged_in_yet /etc/armbian/first_run.txt
        ;;
esac

install -m 0600 /dev/null /etc/yonder/secrets.yaml

empty_directory /var/log
install -d -m 2755 -o root -g systemd-journal /var/log/journal
empty_directory /var/cache
empty_directory /var/lib/apt/lists
empty_directory /tmp
empty_directory /var/tmp
chmod 1777 /tmp /var/tmp

/bin/sh /opt/yonder-src/image/verify-finalized.sh --rootfs --target "$target"
printf 'image-finalize: credential-free %s factory root prepared\n' "$target"
