#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Install protected storage only into a layout already assembled by an image backend.
set -eu
umask 022

die() { echo "Yonder storage install: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die 'root is required'
[ "$#" -eq 4 ] && [ "$1" = --target ] && [ "$3" = --layout ] || exit 2
target=$2
layout=$4
case "$target" in rpi|radxa-zero3w|radxa-rock5c) ;; *) exit 2 ;; esac
[ -f "$layout" ] && [ ! -L "$layout" ] || die 'layout input is not a regular file'
layout_stat=$(stat -c '%u:%g:%a:%s' "$layout") || die 'cannot inspect layout input'
case "$layout_stat" in 0:0:600:*) ;; *) die 'layout input must be root-private' ;; esac
layout_size=${layout_stat##*:}
case "$layout_size" in ''|*[!0-9]*) die 'layout input size is invalid' ;; esac
[ "$layout_size" -gt 0 ] && [ "$layout_size" -le 4096 ] || die 'layout input size is invalid'

script_dir=${0%/*}
# shellcheck disable=SC1091 # fixed sibling parser, not input data
. "$script_dir/layout.sh"
yonder_read_layout "$layout" "$target" || die 'layout validation failed'
install -m 0644 "$layout" /etc/yonder-storage-layout.conf
[ "$(stat -c '%u:%g:%a' /etc/yonder-storage-layout.conf)" = 0:0:644 ] || die 'installed marker metadata is invalid'
install -d -m 0755 /usr/lib/yonder/storage
install -m 0644 "$script_dir/layout.sh" /usr/lib/yonder/storage/layout.sh

case "$target" in
    rpi)
        YONDER_STORAGE_INSTALL_MODE=production \
            /bin/sh /opt/yonder-src/image/pi/storage-prototype/install.sh
        ;;
    radxa-zero3w|radxa-rock5c)
        YONDER_STORAGE_INSTALL_MODE=production \
            /bin/sh /opt/yonder-src/image/prototype/install.sh \
            "$ROOT_UUID" "$STATE_UUID" "$LOG_UUID" "$MEDIA_UUID" "$DISK_GUID" \
            "$ROOT_PARTUUID" "$STATE_PARTUUID" "$LOG_PARTUUID" "$MEDIA_PARTUUID" \
            "$ROOT_TYPE_GUID" "$STATE_TYPE_GUID" "$LOG_TYPE_GUID" "$MEDIA_TYPE_GUID" \
            "$ROOT_START" "$ROOT_SIZE" "$STATE_START" "$STATE_SIZE" \
            "$LOG_START" "$LOG_SIZE" "$MEDIA_START" "$MEDIA_MIN_SIZE" "$MEDIA_PARTLABEL"
        ;;
esac
