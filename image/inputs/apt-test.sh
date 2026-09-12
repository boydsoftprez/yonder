#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
sets=$repo/image/package-sets.sh
# shellcheck source=../package-sets.sh
source "$sets"

fail() { echo "FAIL: $*" >&2; exit 1; }

for target in rpi radxa-zero3w radxa-rock5c; do
    packages=$($sets "$target")
    [[ $packages == "$(printf '%s\n' "$packages" | sort -u)" ]] \
        || fail "$target package set is not sorted and unique"
    if grep -Ev '^[a-z0-9][a-z0-9+.-]+$' <<<"$packages" | grep -q .; then
        fail "$target package set contains an invalid package name"
    fi
    for required in ca-certificates curl openssh-server sudo whois initramfs-tools \
            network-manager dnsmasq-base gstreamer1.0-tools gstreamer1.0-rtsp \
            python3-gi zerotier-one; do
        grep -qxF "$required" <<<"$packages" || fail "$target omits $required"
    done
done

zero=$($sets radxa-zero3w)
for required in dkms device-tree-compiler e2fsprogs gdisk linux-headers-vendor-rk35xx; do
    grep -qxF "$required" <<<"$zero" || fail "radxa-zero3w omits $required"
done
if yonder_direct_packages radxa-zero3w | grep -qx passwd; then
    fail 'radxa-zero3w direct set includes the Pi-only passwd request'
fi
pi=$($sets rpi)
for required in binutils build-essential dosfstools e2fsprogs fdisk; do
    grep -qxF "$required" <<<"$pi" || fail "rpi omits $required"
done
yonder_direct_packages rpi | grep -qx passwd || fail 'rpi direct set omits passwd'
rock=$($sets radxa-rock5c)
for required in device-tree-compiler e2fsprogs gdisk libdrm2; do
    grep -qxF "$required" <<<"$rock" || fail "radxa-rock5c omits $required"
done
if $sets unknown >/dev/null 2>&1; then fail 'unknown target was accepted'; fi

if [[ $# == 0 ]]; then
    "$repo/image/inputs/capture-apt.sh" --help | grep -q -- '--payload PAYLOAD_COMPONENTS_DIRECTORY' \
        || fail 'capture CLI does not require an explicit payload input'
    echo 'PASS: canonical target package sets are sorted, unique, and contain current builder/installer requirements.'
    echo 'LIMIT: pass --target, --base, --payload and --work for an online capture plus network-disabled fresh-base replay.'
    exit 0
fi

target=
base=
payload=
work=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --target) target=${2:-}; shift 2 ;;
        --base) base=${2:-}; shift 2 ;;
        --payload) payload=${2:-}; shift 2 ;;
        --work) work=${2:-}; shift 2 ;;
        *) fail 'usage: image/inputs/apt-test.sh [--target TARGET --base BASE.img.xz --payload PAYLOAD_COMPONENTS_DIRECTORY --work NEW_DIRECTORY]' ;;
    esac
done
[[ -n $target && -f $base && -d $payload && -n $work && ! -e $work ]] \
    || fail 'integration arguments are incomplete or work exists'
mkdir -m 0700 "$work"
work=$(CDPATH='' cd -- "$work" && pwd)
if "$repo"/image/inputs/capture-apt.sh --target "$target" --base "$base" \
        --output "$work/missing-payload" >"$work/missing-payload.log" 2>&1; then
    fail 'capture accepted a missing explicit payload input'
fi
[[ ! -e $work/missing-payload ]]
grep -q -- '--payload is required' "$work/missing-payload.log" \
    || fail 'missing payload refusal was not actionable'
mkdir "$work/malformed-payload" "$work/malformed-payload/zerotier"
printf 'not a deb\n' >"$work/malformed-payload/zerotier/wrong.txt"
if "$repo"/image/inputs/capture-apt.sh --target "$target" --base "$base" \
        --payload "$work/malformed-payload" --output "$work/malformed-output" \
        >"$work/malformed-payload.log" 2>&1; then
    fail 'capture accepted a malformed payload zerotier component'
fi
[[ ! -e $work/malformed-output ]]
grep -q 'exactly one regular ARM64 deb' "$work/malformed-payload.log" \
    || fail 'malformed payload refusal was not actionable'
"$repo"/image/inputs/capture-apt.sh --target "$target" --base "$base" \
    --payload "$payload" --output "$work/capture"
(
    cd "$work/capture"
    sha256sum -c SHA256SUMS >/dev/null
    sed -n 's/^[a-f0-9]\{64\}  //p' SHA256SUMS | sort >"$work/listed"
    find . -type f ! -name SHA256SUMS -print | sort >"$work/actual"
    cmp "$work/listed" "$work/actual"
)
node -e '
const capture = JSON.parse(require("fs").readFileSync(process.argv[1]));
if (capture.resolverPreflightUser !== "_apt") process.exit(1);
' "$work/capture/capture.json"
"$repo"/image/inputs/replay-apt.sh --target "$target" --base "$base" \
    --input "$work/capture" --output "$work/replay"
grep -qx 'docker_network=none' "$work/replay/replay-proof.txt"
grep -qx 'apt_sources=local-file-only' "$work/replay/replay-proof.txt"
grep -qx 'apt_downloads=disabled' "$work/replay/replay-proof.txt"
grep -qx 'production_adapter=passed' "$work/replay/replay-proof.txt"
echo "PASS: exact-base APT capture and network-disabled replay completed for $target."
