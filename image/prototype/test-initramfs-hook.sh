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
printf '%s\n' 'PASS: initramfs hook names a missing required full tool before archive generation.'
