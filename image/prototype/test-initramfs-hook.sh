#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
[[ $# == 0 && -f image/prototype/initramfs-hook ]]
fixture=$(mktemp -d /tmp/yonder-hook-tools.XXXXXX)
trap 'rm -rf "$fixture"' EXIT INT TERM
for tool in mount umount blkid blockdev findmnt lsblk partx; do
    ln -s /usr/bin/true "$fixture/$tool"
done
set +e
PATH=$fixture /bin/sh image/prototype/initramfs-hook 2>"$fixture/error"
status=$?
set -e
[[ $status == 1 ]]
grep -Fxq "Yonder initramfs hook: required tool 'sgdisk' is missing." "$fixture/error"
directory_line=$(grep -nF 'install -d -m 0755 /etc/systemd/journald.conf.d' image/prototype/install.sh | cut -d: -f1)
write_line=$(grep -nF 'cat >/etc/systemd/journald.conf.d/70-yonder-storage-prototype.conf' image/prototype/install.sh | cut -d: -f1)
[[ -n $directory_line && -n $write_line && $directory_line -lt $write_line ]]
printf '%s\n' 'PASS: initramfs hook names a missing required full tool before archive generation.'
