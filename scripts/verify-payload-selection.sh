#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Real selector execution; network commands are intercepted, never performed.
set -eu
repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
mkdir "$fixture/bin"
cat >"$fixture/bin/curl" <<'STUB'
#!/bin/sh
printf '%s\n' "called" >>"$PAYLOAD_CURL_PROBE"
exit 71
STUB
chmod 755 "$fixture/bin/curl"
export PAYLOAD_CURL_PROBE="$fixture/curl-called"
export PATH="$fixture/bin:$PATH"
# SeekerHD refuses x64; it must not first download an unrelated component.
if "$repo/installer/make-payload.sh" --arch linux-x64 --only seekerhd --out "$fixture/skipped" >"$fixture/log" 2>&1; then
    echo "FAIL: unsupported SeekerHD architecture accepted" >&2
    exit 1
fi
grep -q "SeekerHD is available only for linux-arm64" "$fixture/log"
[ ! -e "$PAYLOAD_CURL_PROBE" ]
# MediaMTX is independently selectable and reaches its own fetch operation.
if "$repo/installer/make-payload.sh" --arch linux-x64 --only mediamtx --out "$fixture/selected" >"$fixture/log" 2>&1; then
    echo 'FAIL: intercepted network failure was accepted' >&2
    exit 1
fi
[ -s "$PAYLOAD_CURL_PROBE" ]
grep -q "could not download mediamtx" "$fixture/log"
echo 'PASS: payload selection isolates skipped components and accepts MediaMTX'
