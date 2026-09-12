#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Direct requests match image-builder apt-get semantics. Role requests match
# ensure_pkgs and are selected only when absent from the exact locked base.
set -euo pipefail

yonder_direct_packages() {
    local target=$1
    cat <<'EOF'
ffmpeg
gpiod
gstreamer1.0-tools
i2c-tools
openssh-server
picocom
python3-serial
sudo
v4l-utils
whois
EOF
    case "$target" in
        radxa-zero3w|radxa-rock5c)
            printf '%s\n' device-tree-compiler e2fsprogs gdisk initramfs-tools util-linux
            ;;
        rpi)
            printf '%s\n' binutils build-essential dosfstools e2fsprogs fdisk \
                initramfs-tools passwd util-linux
            ;;
        *) return 2 ;;
    esac
}

yonder_role_packages() {
    local target=$1
    cat <<'EOF'
avahi-daemon
ca-certificates
coreutils
curl
dnsmasq-base
gir1.2-gstreamer-1.0
gstreamer1.0-libav
gstreamer1.0-plugins-bad
gstreamer1.0-plugins-base
gstreamer1.0-plugins-good
gstreamer1.0-plugins-ugly
gstreamer1.0-rtsp
gstreamer1.0-tools
iperf3
iproute2
iputils-ping
libnss-myhostname
modemmanager
network-manager
python3-gi
traceroute
zerotier-one
EOF
    case "$target" in
        radxa-zero3w)
            printf '%s\n' device-tree-compiler dkms libdrm2 libstdc++6 \
                linux-headers-vendor-rk35xx python3 v4l-utils
            ;;
        radxa-rock5c)
            printf '%s\n' gstreamer1.0-tools libdrm2
            ;;
        rpi) ;;
        *) return 2 ;;
    esac
}

yonder_packages() {
    local target=$1
    case "$target" in rpi|radxa-zero3w|radxa-rock5c) ;; *) return 2 ;; esac
    { yonder_direct_packages "$target"; yonder_role_packages "$target"; } | LC_ALL=C sort -u
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    [[ $# == 1 ]] || {
        echo 'Usage: image/package-sets.sh TARGET' >&2
        exit 2
    }
    yonder_packages "$1"
fi
