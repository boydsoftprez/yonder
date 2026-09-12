#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
package="$repo/vendor/zerotier/zerotier-one_1.16.2_arm64.deb"
expected=e6c71707d8db57dd9bc6d6a4d5d5b8343ad244f48ff1ebd288f5f588fbdb10a4
actual=$(sha256sum "$package" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || { echo "ZeroTier package provenance mismatch" >&2; exit 1; }

docker run --rm --platform linux/arm64 \
  --mount "type=bind,src=$repo/packages/yonder-core,dst=/repo,readonly" \
  --mount "type=bind,src=$package,dst=/input/zerotier.deb,readonly" \
  --tmpfs /lab:rw,nosuid,nodev,exec,mode=0755 \
  debian:trixie-slim sh -eu -c '
    apt-get update >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs >/dev/null
    mkdir -p /lab/package
    dpkg-deb -x /input/zerotier.deb /lab/package
    node /repo/scripts/verify-zerotier-linux.mjs
  '
printf '%s\n' "PASS: ZeroTier Linux integration used zerotier-one_1.16.2_arm64.deb SHA-256 $actual"
