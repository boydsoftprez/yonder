#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Build the offline payload: everything an install needs that is not in this
# repository, staged into vendor/ for the target board's architecture.
#
# Yonder installs without a network (R-CFG-07). That used to mean one
# instruction in installer/README.md — "download a Node distribution into
# vendor/node" — which was survivable while Node was the only thing to fetch.
# It is not survivable now that the console carries Node-RED and a dashboard
# too: an instruction nobody can run twice and get the same result from is not
# a build step, it is a story about one.
#
# This script runs on a build machine with a network, and produces a vendor/
# the installer can be pointed at on a board with none. vendor/ is
# git-ignored: it is downloaded binaries, not source, and it is never
# committed. What *is* committed is installer/console/package-lock.json, which
# is what makes two payloads built a week apart identical.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$HERE/.." && pwd)

# Node 24, not 20. Node 20 reached end of life in April 2026 and Node-RED 5
# requires 22.9 or newer, so the runtime had to move; 24 is the current LTS
# line and is what a board flashed today should carry. yonder-core itself
# still declares a floor of 20 — that is genuinely its floor, and a role
# should say what it needs — so the two roles ask for different minimums and
# a board with a distro Node 20 installs the daemon and fails loudly at the
# console, with a reason.
#
# Pinned rather than "latest": a payload whose contents depend on the day it
# was built is not a payload, and two boards imaged a week apart would carry
# different runtimes with nothing recording it.
NODE_VERSION=${NODE_VERSION:-24.20.0}
NODE_DIST=${NODE_DIST:-https://nodejs.org/dist}

# ZeroTier 1.16.2. Pinned and fingerprinted for the same reason Node is: a
# payload whose contents depend on the day it was built is not a payload.
#
# Both halves are checked at build time and they do different jobs. The
# recorded fingerprint is what a reviewer sees in a pull request when this
# version is bumped, and what makes two payloads built a week apart identical.
# The signature is what catches what a fingerprint cannot - the download site
# itself being tampered with - since the fingerprint would have been read off
# that same site when it was written down.
ZEROTIER_VERSION=${ZEROTIER_VERSION:-1.16.2}
ZEROTIER_REPO=${ZEROTIER_REPO:-https://download.zerotier.com/debian/trixie}
# shellcheck disable=SC2034 # read by the `eval` below, keyed on DEB_ARCH
ZEROTIER_SHA256_arm64=e6c71707d8db57dd9bc6d6a4d5d5b8343ad244f48ff1ebd288f5f588fbdb10a4
# shellcheck disable=SC2034 # likewise
ZEROTIER_SHA256_amd64=75589dbdc989546629e8676b186b1e7854b3fa3b5dac061b93f8c8e427af2b13

# mediamtx 1.20.1, and pinned harder than either of the two above.
#
# Node publishes a SHASUMS256.txt beside each release and ZeroTier publishes a
# GPG-signed apt index; this project checks both, and the signature is what
# catches the one thing a recorded fingerprint cannot - the download site
# itself being tampered with, since the fingerprint would have been read off
# that same site when it was written down. **mediamtx has no signed index and
# no detached signature at all.** It publishes a checksums.sha256 asset beside
# the tarballs, on the same host, so verifying the tarball against it proves
# only that the two files agree.
#
# So these two constants are the entire trust anchor. They were read once, by
# hand, on a machine with a network, and they are what a reviewer sees in a
# pull request when this version is bumped. Bumping the version means
# re-reading them - not editing the number and hoping:
#
#     curl -fsSL https://github.com/bluenviron/mediamtx/releases/download/v<version>/checksums.sha256 \
#       | grep -E 'linux_(arm64|amd64)\.tar\.gz'
#
# 1.20.1 rather than something older for two reasons that are not taste. It is
# the first line whose release carries a checksums.sha256 asset to check
# against at all - 1.9.x published none, and its arm64 tarball is named
# linux_arm64v8 rather than linux_arm64 - and its authentication model is the
# one media/config.ts writes: readUser/readPass/publishIPs inside a path are
# deprecated, warned about on every start, and their eventual removal would
# leave an open listener rather than a broken configuration.
MEDIAMTX_VERSION=${MEDIAMTX_VERSION:-1.20.1}
MEDIAMTX_BASE=${MEDIAMTX_BASE:-https://github.com/bluenviron/mediamtx/releases/download}
# Indirectly read by the architecture-selected eval below.
# shellcheck disable=SC2034
MEDIAMTX_SHA256_arm64=d1689f0bfefb1864e5ed3dcc8495eb2d7ec0a654f90bf3cd48980cb3bd08718a
# shellcheck disable=SC2034
MEDIAMTX_SHA256_amd64=81b143f55a5d23d4a8c028d52869c14ea4a59919900528698fcc97a747fd69c6
# mavlink-router. The one component that is *built* rather than downloaded:
# it is not in Debian, there is no published binary, and it is a Meson/C++
# build from source (R-CFG-07, R-MAV-17).
#
# **The pin is a commit, and that commit is the fingerprint.** Node and
# ZeroTier are downloads, so a recorded sha256 is what says the bytes are the
# bytes; here the bytes are produced by a compiler, and a compiler's output
# moves with its version, so pinning the *binary* by hash would fail the day
# Debian updated gcc rather than the day somebody changed the source. A git
# commit id is a hash over the complete tree — every file, and the exact
# commit of every submodule — so verifying that the checkout is this commit
# verifies precisely the input the build consumes. It is SHA-1, which is
# weakened rather than broken, and it is stated here plainly rather than
# implied: it is a strong integrity check against corruption and an accident,
# and it is not the strongest thing available against a determined attacker
# with control of the source host.
#
# 2362c62, 2026-02-19, is the commit Task 2 built and measured on a Raspberry
# Pi 4 — 325 KB stripped, per-endpoint statistics confirmed. See
# docs/hardware/an-autopilot-on-the-uart.md.
MAVLINK_ROUTER_COMMIT=${MAVLINK_ROUTER_COMMIT:-2362c620f483cef1edd574fb962a373a288e4b9e}
MAVLINK_ROUTER_REPO=${MAVLINK_ROUTER_REPO:-https://github.com/mavlink-router/mavlink-router}
# Debian 13, the release the boards run, so the binary is linked against the
# glibc it will actually meet rather than one that merely happens to be newer.
MAVLINK_ROUTER_IMAGE=${MAVLINK_ROUTER_IMAGE:-debian:trixie}

# gstreamer-rockchip, and the two libraries it links: the second component
# that is *built* rather than downloaded, for mavlink-router's reason — no
# repository a board has carries any of the three, Debian or Armbian, and the
# vendor publishes no binary for trixie. Rejected on the way here, so they are
# not revisited: the vendor's prebuilt plugin (bullseye, GStreamer 1.14, not
# guaranteed against 1.26), and building on the board (nine build packages
# and a from-source MPP on a 1.9 GB board — done once by hand for the bench,
# not a thing an installer does).
#
# Three pins, one commit each, fingerprinted as mavlink-router's is: a commit
# is a hash over the whole tree. These are what the bench built on 2026-09-06:
# mpph264enc and mpph265enc both encode clean, decodable streams and take a
# live bitrate change with no gap. See docs/hardware/ffmpeg-as-the-pipeline-composer.md.
MPP_COMMIT=${MPP_COMMIT:-0986d01294d5c2449c14cf13af9b740368c33967}
MPP_REPO=${MPP_REPO:-https://github.com/rockchip-linux/mpp}
# librga ships its library already built under libs/Linux/gcc-aarch64/; its
# headers and a pkg-config file are what turn the plugin's `rga` option on,
# which is what puts `width`/`height` on the encoders (spec §4).
LIBRGA_COMMIT=${LIBRGA_COMMIT:-2b32edcb97b601b25683e2941d888c8515da6d55}
LIBRGA_REPO=${LIBRGA_REPO:-https://github.com/airockchip/librga}
# rockchip-linux/gstreamer-rockchip is a 404; JeffyCN's mirror carries it on
# a branch of that name, committed to twelve days before the bench built it.
GST_ROCKCHIP_COMMIT=${GST_ROCKCHIP_COMMIT:-a0d45af504099b4b82f3d3377019a63d357e7cef}
GST_ROCKCHIP_REPO=${GST_ROCKCHIP_REPO:-https://github.com/JeffyCN/mirrors}
GST_ROCKCHIP_BRANCH=${GST_ROCKCHIP_BRANCH:-gstreamer-rockchip}
GST_ROCKCHIP_IMAGE=${GST_ROCKCHIP_IMAGE:-debian:trixie}

# The five things a payload can carry, in the order they are staged.
COMPONENTS="node zerotier mavlink-router gst-rockchip console"

ARCH=""
OUT="$REPO/vendor"
ONLY=""

usage() {
    cat <<'USAGE'
Usage: make-payload.sh --arch <linux-arm64|linux-x64> [--out DIR] [--only LIST]

  --arch ARCH        the board's architecture; required
  --out DIR          where to stage the payload (default: vendor/ in this repo)
  --only LIST        stage only these components, comma-separated:
                     node, zerotier, mavlink-router, gst-rockchip, console.
                     Default: all of them. What is not staged in this run is
                     left exactly as an earlier run left it, so --only is an
                     update of one part of a payload rather than a smaller
                     payload.
  --node-version V   override the pinned Node version
  -h, --help         this message

Produces:
  DIR/node/bin/node                              the runtime both services use
  DIR/console/node_modules/node-red/red.js       the console
  DIR/mediamtx/mediamtx                          the media server
  DIR/node/bin/node                               the runtime both services use
  DIR/zerotier/zerotier-one_<version>_<arch>.deb  the primary mesh client
  DIR/mavlink-router/mavlink-routerd              the service that owns the serial port
  DIR/gst-rockchip/gstreamer-1.0/libgstrockchipmpp.so   Rockchip's encoders, for GStreamer
  DIR/gst-rockchip/lib/                                   MPP and librga, which it links
  DIR/console/node_modules/node-red/red.js        the console
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --arch)         shift; [ $# -gt 0 ] || { usage; exit 2; }; ARCH="$1" ;;
        --out)          shift; [ $# -gt 0 ] || { usage; exit 2; }; OUT="$1" ;;
        --only)         shift; [ $# -gt 0 ] || { usage; exit 2; }; ONLY="$1" ;;
        --node-version) shift; [ $# -gt 0 ] || { usage; exit 2; }; NODE_VERSION="$1" ;;
        -h|--help)      usage; exit 0 ;;
        *)              printf 'unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
    esac
    shift
done

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
log()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# Whether this run stages a given component.
#
# A misspelling is refused rather than silently staging nothing: `--only
# mavlink_router` producing a payload with no router, and an install that
# then says "no mavlink-router in the payload; skipping", is a board with no
# telemetry and two log lines that both look like they are working.
ONLY_LIST=$(printf '%s' "$ONLY" | tr ',' ' ')
for asked in $ONLY_LIST; do
    known=0
    for name in $COMPONENTS; do
        [ "$asked" = "$name" ] && known=1
    done
    [ "$known" = "1" ] || die "unknown component: $asked
--only takes any of: $COMPONENTS"
done

wanted() {
    [ -n "$ONLY_LIST" ] || return 0
    for name in $ONLY_LIST; do
        [ "$1" = "$name" ] && return 0
    done
    return 1
}

# npm resolves optional dependencies for the machine it is *running* on, not
# for the machine the payload is *for*. Node-RED pulls @node-rs/bcrypt, whose
# real code is in a per-platform optional package, so a payload built on a
# developer's laptop carried @node-rs/bcrypt-darwin-arm64 and no Linux binding
# at all. Node-RED catches that and falls back to pure JavaScript, so it is
# not fatal — which is exactly why it would never have been noticed, and why
# the next dependency with a native binding would have been.
#
# --os/--cpu/--libc tell npm which machine to resolve for. --libc matters as
# much as the other two: without it npm can pick neither the gnu nor the musl
# variant and quietly installs neither.
#
# OCI_PLATFORM is the same fact spelled the way a container runtime wants it,
# and it is what makes the mavlink-router build below produce a binary for the
# *board* rather than for whatever machine is running this script. A Meson/C++
# build has no equivalent of npm's --cpu: the only way to get a foreign
# binary is a foreign toolchain, and the cheapest correct one is the target's
# own userland in a container.
case "$ARCH" in
    linux-arm64) NPM_OS=linux; NPM_CPU=arm64; DEB_ARCH=arm64; OCI_PLATFORM=linux/arm64 ;;
    linux-x64)   NPM_OS=linux; NPM_CPU=x64;   DEB_ARCH=amd64; OCI_PLATFORM=linux/amd64 ;;
    "") die "--arch is required (linux-arm64 for a Raspberry Pi or Radxa, linux-x64 for a PC)" ;;
    *)  die "unsupported architecture: $ARCH" ;;
esac
# Debian, so glibc. A musl target would be a different --arch.
NPM_LIBC=glibc

# Asked per component, not once for everything: a run that stages only the
# router needs neither npm nor a checksum tool, and dying for the want of one
# it will never call is how a selector stops being usable.
if wanted node || wanted zerotier; then
    command -v curl >/dev/null 2>&1 || die "curl is needed to fetch the payload"
fi
if wanted node; then
    command -v tar >/dev/null 2>&1 || die "tar is needed to unpack the payload"
fi
if wanted console; then
    command -v npm >/dev/null 2>&1 || die "npm is needed to install the console's dependencies"
fi

# sha256sum on Linux, shasum on macOS. Checking the download is not optional:
# a payload that silently accepts a corrupt or substituted runtime is not a
# payload worth having, and the thing it would be substituted into is the
# process that talks to an aircraft.
SHA_CHECK=""
SHA_SUM=""
if command -v sha256sum >/dev/null 2>&1; then
    SHA_CHECK="sha256sum -c"
    SHA_SUM="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
    SHA_CHECK="shasum -a 256 -c"
    SHA_SUM="shasum -a 256"
elif wanted node || wanted zerotier; then
    die "neither sha256sum nor shasum is here; the Node download could not be verified"
fi

mkdir -p "$OUT"
OUT=$(CDPATH='' cd -- "$OUT" && pwd)
WORK="$OUT/.work"
rm -rf "$WORK"
mkdir -p "$WORK"
# The staging directory is removed on any exit, including a failed download,
# so a re-run never resumes from a half-fetched tarball.
trap 'rm -rf "$WORK"' EXIT INT TERM

# ---------------------------------------------------------------------------
if wanted node; then
    step "node $NODE_VERSION for $ARCH"

    NODE_TARBALL="node-v$NODE_VERSION-$ARCH.tar.xz"
    NODE_URL="$NODE_DIST/v$NODE_VERSION/$NODE_TARBALL"

    log "fetching $NODE_URL"
    curl -fsSL --retry 3 -o "$WORK/$NODE_TARBALL" "$NODE_URL" \
        || die "could not download $NODE_URL"

    log "fetching the published checksums"
    curl -fsSL --retry 3 -o "$WORK/SHASUMS256.txt" "$NODE_DIST/v$NODE_VERSION/SHASUMS256.txt" \
        || die "could not download the SHASUMS256.txt for v$NODE_VERSION"

    # One line out of the published list, matched on the exact file name, so the
    # check cannot pass because some *other* line in the file happened to verify.
    grep " $NODE_TARBALL\$" "$WORK/SHASUMS256.txt" > "$WORK/expected.sha256" \
        || die "$NODE_TARBALL is not listed in the published SHASUMS256.txt for v$NODE_VERSION"

    log "verifying $NODE_TARBALL"
    ( cd "$WORK" && $SHA_CHECK expected.sha256 ) >/dev/null \
        || die "$NODE_TARBALL does not match its published checksum; refusing to unpack it"
    log "checksum matches"

    rm -rf "$WORK/node" "$OUT/node"
    mkdir -p "$WORK/node"
    # --strip-components 1 so the result is vendor/node/bin/node rather than
    # vendor/node/node-v24.20.0-linux-arm64/bin/node: install_bundled_node in
    # installer/lib/common.sh looks for exactly the former.
    tar -xJf "$WORK/$NODE_TARBALL" -C "$WORK/node" --strip-components 1 \
        || die "could not unpack $NODE_TARBALL"
    [ -f "$WORK/node/bin/node" ] || die "the unpacked distribution has no bin/node"
    mv "$WORK/node" "$OUT/node"
    log "staged $OUT/node/bin/node"
fi

# ---------------------------------------------------------------------------
if wanted zerotier; then
    step "zerotier $ZEROTIER_VERSION for $DEB_ARCH"

    command -v gpgv >/dev/null 2>&1 \
        || die "gpgv is needed to verify ZeroTier's repository signature"

    ZT_DEB="zerotier-one_${ZEROTIER_VERSION}_${DEB_ARCH}.deb"
    eval "ZT_EXPECTED=\$ZEROTIER_SHA256_$DEB_ARCH"
    [ -n "$ZT_EXPECTED" ] || die "no recorded checksum for zerotier-one on $DEB_ARCH"

    log "fetching the signed repository index"
    curl -fsSL --retry 3 -o "$WORK/InRelease" "$ZEROTIER_REPO/dists/trixie/InRelease" \
        || die "could not download ZeroTier's InRelease"

    log "verifying it against the key committed in installer/keys"
    gpgv --keyring "$HERE/keys/zerotier.gpg" "$WORK/InRelease" >/dev/null 2>&1 \
        || die "ZeroTier's repository index is not signed by the key in installer/keys/zerotier.gpg"

    log "fetching the package list"
    curl -fsSL --retry 3 -o "$WORK/Packages" \
        "$ZEROTIER_REPO/dists/trixie/main/binary-$DEB_ARCH/Packages" \
        || die "could not download the package list for $DEB_ARCH"

    # The index states the list's checksum; check it before believing the list.
    # `awk` rather than `grep -A`: the SHA256 block is a fixed section of the
    # index, and matching the file name anywhere in the document would also match
    # the MD5Sum block above it.
    want=$(awk '/^SHA256:/{s=1;next} /^[A-Z]/{s=0} s && $3=="main/binary-'"$DEB_ARCH"'/Packages"{print $1}' "$WORK/InRelease")
    [ -n "$want" ] || die "the signed index does not list main/binary-$DEB_ARCH/Packages"
    printf '%s  %s\n' "$want" "Packages" > "$WORK/packages.sha256"
    ( cd "$WORK" && $SHA_CHECK packages.sha256 ) >/dev/null \
        || die "the package list does not match the checksum in the signed index"

    # And the list states the .deb's checksum. Matched on the exact file name so
    # the check cannot pass because some other stanza happened to verify.
    from_index=$(awk -v f="pool/main/z/zerotier-one/$ZT_DEB" '
        $1=="Filename:" && $2==f {found=1} $1=="SHA256:" && found {print $2; exit}' "$WORK/Packages")
    [ -n "$from_index" ] || die "$ZT_DEB is not listed in the verified package list"
    [ "$from_index" = "$ZT_EXPECTED" ] \
        || die "the signed index gives a different checksum for $ZT_DEB than this script records:
  index:    $from_index
  recorded: $ZT_EXPECTED
if the version was bumped deliberately, update ZEROTIER_SHA256_$DEB_ARCH"

    log "fetching $ZT_DEB"
    curl -fsSL --retry 3 -o "$WORK/$ZT_DEB" \
        "$ZEROTIER_REPO/pool/main/z/zerotier-one/$ZT_DEB" \
        || die "could not download $ZT_DEB"

    printf '%s  %s\n' "$ZT_EXPECTED" "$ZT_DEB" > "$WORK/zt.sha256"
    ( cd "$WORK" && $SHA_CHECK zt.sha256 ) >/dev/null \
        || die "$ZT_DEB does not match its recorded checksum; refusing to stage it"
    log "signature and checksum both match"

    rm -rf "$OUT/zerotier"
    mkdir -p "$OUT/zerotier"
    mv "$WORK/$ZT_DEB" "$OUT/zerotier/$ZT_DEB"
    log "staged $OUT/zerotier/$ZT_DEB"
fi

# ---------------------------------------------------------------------------
step "mediamtx $MEDIAMTX_VERSION for $DEB_ARCH"

# mediamtx names its Linux tarballs by the same two words Debian names its
# architectures with - linux_arm64, linux_amd64 - so DEB_ARCH does for both.
MTX_TARBALL="mediamtx_v${MEDIAMTX_VERSION}_linux_${DEB_ARCH}.tar.gz"
eval "MTX_EXPECTED=\$MEDIAMTX_SHA256_$DEB_ARCH"
[ -n "$MTX_EXPECTED" ] || die "no recorded checksum for mediamtx on $DEB_ARCH"

log "fetching the published checksums"
curl -fsSL --retry 3 -o "$WORK/mediamtx.sha256" \
    "$MEDIAMTX_BASE/v$MEDIAMTX_VERSION/checksums.sha256" \
    || die "could not download mediamtx's checksums.sha256 for v$MEDIAMTX_VERSION"

# Matched on the exact file name, so the comparison cannot pass because some
# other line in the list happened to. The published file writes its entries
# `<sha>  *<name>`, the binary-mode form both sha256sum and shasum understand.
from_release=$(awk -v f="*$MTX_TARBALL" '$2==f {print $1; exit}' "$WORK/mediamtx.sha256")
[ -n "$from_release" ] || die "$MTX_TARBALL is not listed in the published checksums for v$MEDIAMTX_VERSION"

# The published list and the constant in this script have to agree. They are
# both read off the same host, so agreement proves nothing about the upstream
# - what it proves is that nobody bumped MEDIAMTX_VERSION without re-reading
# the checksum, which is the mistake this catches.
[ "$from_release" = "$MTX_EXPECTED" ] \
    || die "the published checksums give a different value for $MTX_TARBALL than this script records:
  published: $from_release
  recorded:  $MTX_EXPECTED
if the version was bumped deliberately, update MEDIAMTX_SHA256_$DEB_ARCH"

log "fetching $MTX_TARBALL"
curl -fsSL --retry 3 -o "$WORK/$MTX_TARBALL" \
    "$MEDIAMTX_BASE/v$MEDIAMTX_VERSION/$MTX_TARBALL" \
    || die "could not download $MTX_TARBALL"

printf '%s  %s\n' "$MTX_EXPECTED" "$MTX_TARBALL" > "$WORK/mtx.sha256"
( cd "$WORK" && $SHA_CHECK mtx.sha256 ) >/dev/null \
    || die "$MTX_TARBALL does not match its recorded checksum; refusing to stage it"
log "checksum matches"

rm -rf "$WORK/mediamtx" "$OUT/mediamtx"
mkdir -p "$WORK/mediamtx"
# The tarball holds the binary, its example configuration and a licence at the
# top level, with no directory to strip.
tar -xzf "$WORK/$MTX_TARBALL" -C "$WORK/mediamtx" \
    || die "could not unpack $MTX_TARBALL"
[ -f "$WORK/mediamtx/mediamtx" ] || die "the unpacked archive has no mediamtx binary"

mkdir -p "$OUT/mediamtx"
mv "$WORK/mediamtx/mediamtx" "$OUT/mediamtx/mediamtx"
chmod 0755 "$OUT/mediamtx/mediamtx"
# The licence travels with the binary; the example configuration does not.
# Every listener this device opens is decided by media/config.ts, and a second
# configuration on the disk is a second place somebody could turn one on.
[ -f "$WORK/mediamtx/LICENSE" ] && mv "$WORK/mediamtx/LICENSE" "$OUT/mediamtx/LICENSE"
log "staged $OUT/mediamtx/mediamtx"

# ---------------------------------------------------------------------------
step "the console: node-red and the dashboard"
if wanted mavlink-router; then
    MR_SHORT=$(printf '%s' "$MAVLINK_ROUTER_COMMIT" | cut -c1-7)
    step "mavlink-router $MR_SHORT for $ARCH"

    command -v git >/dev/null 2>&1 \
        || die "git is needed to fetch mavlink-router's source"

    # Docker or Podman, and there is no third option. A C++ build for a
    # foreign architecture needs a foreign toolchain, and the target's own
    # userland in a container is the cheapest correct one — no cross file, no
    # multiarch apt sources, and the exact glibc the board runs. On an arm64
    # machine building for arm64 this is not emulation at all; on an x86 one
    # it is, and the host has to have the handlers registered for it (Docker
    # Desktop ships them; a Linux host wants qemu-user-static and binfmt).
    #
    # Building on the board instead was measured and rejected: a stock image
    # is missing meson, ninja-build, libsystemd-dev and systemd-dev — the
    # last of which the build looks for under the name `systemd`, so
    # installing the obvious one still fails — and a default parallel build
    # is killed by the OOM killer on a 905 MiB Pi 4. The result is 325 KB.
    # See docs/hardware/an-autopilot-on-the-uart.md.
    MR_ENGINE=$(command -v docker 2>/dev/null || command -v podman 2>/dev/null || true)
    [ -n "$MR_ENGINE" ] || die "no docker or podman here, and mavlink-router is a source build.
It is not in Debian and publishes no binary, so a $ARCH build needs a $ARCH toolchain.
  install Docker or Podman, or
  stage the rest of the payload with:
    make-payload.sh --arch $ARCH --only node,zerotier,console
  and expect a board with a console, an access point and no telemetry."

    log "cloning $MAVLINK_ROUTER_REPO"
    rm -rf "$WORK/mavlink-router"
    git clone --quiet "$MAVLINK_ROUTER_REPO" "$WORK/mavlink-router" \
        || die "could not clone $MAVLINK_ROUTER_REPO"
    git -C "$WORK/mavlink-router" checkout --quiet --detach "$MAVLINK_ROUTER_COMMIT" \
        || die "$MAVLINK_ROUTER_COMMIT is not a commit in $MAVLINK_ROUTER_REPO"
    # After the checkout, never before: a submodule is pinned by the commit
    # that names it, so updating them against the default branch and then
    # moving the superproject would build one tree from two versions.
    git -C "$WORK/mavlink-router" submodule update --quiet --init --recursive \
        || die "could not fetch mavlink-router's submodules"

    # The fingerprint, checked rather than assumed. `git checkout` of a
    # commit that is not there fails above, so this is belt and braces — but
    # the belt is what a reviewer reads in a pull request when this pin is
    # bumped, and a check that only exists in a comment is not one.
    MR_HEAD=$(git -C "$WORK/mavlink-router" rev-parse HEAD)
    [ "$MR_HEAD" = "$MAVLINK_ROUTER_COMMIT" ] \
        || die "the checkout is at $MR_HEAD, not the pinned $MAVLINK_ROUTER_COMMIT"
    log "source is $MR_HEAD, exactly the pinned commit"

    log "building in $MAVLINK_ROUTER_IMAGE for $OCI_PLATFORM; this compiles C++, so give it a few minutes"
    # `chown` at the end because the container runs as root and the source is
    # a bind mount: without it the build products in $WORK belong to root and
    # this script's own `rm -rf` on exit cannot remove them.
    #
    # `safe.directory` because meson reads the version string out of git, and
    # git refuses to look at a repository owned by another user. Without it
    # the build succeeds and produces a binary whose --version says nothing,
    # which is exactly the string the check below reads.
    # shellcheck disable=SC2016 # MR_OWNER is expanded by the container's shell, not this one
    "$MR_ENGINE" run --rm --platform "$OCI_PLATFORM" \
        -v "$WORK/mavlink-router:/src" -w /src \
        -e DEBIAN_FRONTEND=noninteractive \
        -e "MR_OWNER=$(id -u):$(id -g)" \
        "$MAVLINK_ROUTER_IMAGE" sh -c '
            set -eu
            apt-get update -qq
            apt-get install -y --no-install-recommends \
                build-essential meson ninja-build pkg-config git \
                libsystemd-dev systemd-dev python3 >/dev/null
            git config --global --add safe.directory /src
            meson setup build .
            ninja -C build
            strip build/src/mavlink-routerd
            chown -R "$MR_OWNER" build
        ' || die "the mavlink-router build failed in $MAVLINK_ROUTER_IMAGE for $OCI_PLATFORM.
If it stopped at 'exec format error', this host cannot run $OCI_PLATFORM containers:
register the emulation handlers (Linux: qemu-user-static and binfmt-support) and try again."

    MR_BUILT="$WORK/mavlink-router/build/src/mavlink-routerd"
    [ -f "$MR_BUILT" ] || die "the build reported success and produced no $MR_BUILT"

    # The post-condition, and it checks both halves of the claim at once:
    # that the binary **runs on the target's architecture**, and that it is
    # the **pinned source**. mavlink-router derives its version string from
    # git describe, so `--version` printing the pinned short commit is the
    # build saying which source it came from — the one thing a fingerprint
    # over the binary could not have told us, since a compiler's output moves
    # with the compiler.
    #
    # Run inside the same container, deliberately: on an x86 build host the
    # binary cannot be executed here at all, and this is the only place that
    # can execute it. Output is captured with `2>&1` and the exit status is
    # not consulted — a program's --version is not required to exit 0, and
    # what is being read is the string.
    MR_VERSION=$("$MR_ENGINE" run --rm --platform "$OCI_PLATFORM" \
        -v "$WORK/mavlink-router:/src" "$MAVLINK_ROUTER_IMAGE" \
        /src/build/src/mavlink-routerd --version 2>&1 || true)
    case "$MR_VERSION" in
        *"$MR_SHORT"*) log "it runs on $OCI_PLATFORM and reports: $MR_VERSION" ;;
        *) die "the built binary does not report the pinned version.
  expected to see: $MR_SHORT
  it said:         $MR_VERSION" ;;
    esac

    rm -rf "$OUT/mavlink-router"
    mkdir -p "$OUT/mavlink-router"
    mv "$MR_BUILT" "$OUT/mavlink-router/mavlink-routerd"
    chmod 0755 "$OUT/mavlink-router/mavlink-routerd"
    # Recorded in the log rather than in this file. It is the fingerprint of
    # *this* build, which two machines are not expected to agree on, so it is
    # something to compare two payloads with — never something to gate on.
    if [ -n "$SHA_SUM" ]; then
        log "sha256 $($SHA_SUM "$OUT/mavlink-router/mavlink-routerd" | cut -d' ' -f1)"
    fi
    log "staged $OUT/mavlink-router/mavlink-routerd ($(wc -c < "$OUT/mavlink-router/mavlink-routerd" | tr -d ' ') bytes)"
fi

# ---------------------------------------------------------------------------
if wanted gst-rockchip; then
    if [ "$ARCH" != "linux-arm64" ]; then
        step "gst-rockchip: not for $ARCH"
        log "every Rockchip board is arm64; an $ARCH payload carries no MPP plugin and the role skips it"
    else
    GR_PINS="MPP $(printf '%s' "$MPP_COMMIT" | cut -c1-7), librga $(printf '%s' "$LIBRGA_COMMIT" | cut -c1-7), plugin $(printf '%s' "$GST_ROCKCHIP_COMMIT" | cut -c1-7)"
    step "gst-rockchip: $GR_PINS for $ARCH"
    command -v git >/dev/null 2>&1 || die "git is needed to fetch the Rockchip sources"
    GR_ENGINE=$(command -v docker 2>/dev/null || command -v podman 2>/dev/null || true)
    [ -n "$GR_ENGINE" ] || die "no docker or podman here, and gst-rockchip is a source build.
  install Docker or Podman, or stage the rest with:
    make-payload.sh --arch $ARCH --only node,zerotier,mavlink-router,console
  and expect a Rockchip board to encode in software."
    GR="$WORK/gst-rockchip"
    rm -rf "$GR"
    mkdir -p "$GR"
    # repo commit dir. A shallow fetch of exactly the pinned commit: the pin
    # is verified by construction, and what crosses the network is the tree,
    # not the history — JeffyCN/mirrors carries many projects' histories on
    # separate branches, and a full clone of it is gigabytes, which is what
    # timed out the first time this ran. GitHub serves a reachable commit by
    # id. The branch name stays recorded in the MANIFEST as where that
    # commit lives.
    gr_fetch() {
        mkdir -p "$3"
        git -C "$3" init --quiet
        git -C "$3" remote add origin "$1"
        git -C "$3" fetch --quiet --depth=1 origin "$2" \
            || die "could not fetch $2 from $1"
        git -C "$3" checkout --quiet --detach FETCH_HEAD
        gr_head=$(git -C "$3" rev-parse HEAD)
        [ "$gr_head" = "$2" ] || die "the fetch of $1 is at $gr_head, not the pinned $2"
        log "$(basename "$3") is $gr_head, exactly the pinned commit"
    }
    gr_fetch "$MPP_REPO" "$MPP_COMMIT" "$GR/mpp"
    gr_fetch "$LIBRGA_REPO" "$LIBRGA_COMMIT" "$GR/librga"
    gr_fetch "$GST_ROCKCHIP_REPO" "$GST_ROCKCHIP_COMMIT" "$GR/plugin"
    [ -f "$GR/librga/libs/Linux/gcc-aarch64/librga.so" ] \
        || die "librga at $LIBRGA_COMMIT carries no libs/Linux/gcc-aarch64/librga.so"
    log "building in $GST_ROCKCHIP_IMAGE for $OCI_PLATFORM; MPP is a large C build, so give it several minutes"
    # shellcheck disable=SC2016 # GR_OWNER is expanded by the container's shell, not this one
    "$GR_ENGINE" run --rm --platform "$OCI_PLATFORM" \
        -v "$GR:/src" -w /src \
        -e DEBIAN_FRONTEND=noninteractive \
        -e "GR_OWNER=$(id -u):$(id -g)" \
        "$GST_ROCKCHIP_IMAGE" sh -c '
            set -eu
            apt-get update -qq
            apt-get install -y --no-install-recommends \
                build-essential cmake meson ninja-build pkg-config git ca-certificates \
                libdrm-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
                gstreamer1.0-tools >/dev/null
            git config --global --add safe.directory "*"
            lib=/usr/lib/aarch64-linux-gnu
            # MPP, installed into the container so the plugin can link it.
            cmake -S /src/mpp -B /src/mpp/build -DCMAKE_BUILD_TYPE=Release \
                -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR=lib/aarch64-linux-gnu \
                -DBUILD_TEST=OFF >/dev/null
            make -C /src/mpp/build -j"$(nproc)" install >/dev/null
            # librga, already built by its authors; the headers and a
            # pkg-config file are what the plugin build asks for.
            install -m 0644 /src/librga/libs/Linux/gcc-aarch64/librga.so "$lib/librga.so.2"
            ln -sf librga.so.2 "$lib/librga.so"
            mkdir -p /usr/include/rga
            cp -r /src/librga/include/. /usr/include/rga/
            printf "prefix=/usr\nlibdir=%s\nincludedir=/usr/include/rga\n\nName: librga\nDescription: Rockchip RGA 2D raster graphic acceleration\nVersion: 1.10.6\nLibs: -L%s -lrga\nCflags: -I/usr/include/rga\n" \
                "$lib" "$lib" > "$lib/pkgconfig/librga.pc"
            ldconfig
            # The plugin, with only the MPP element set: rkximage wants X11
            # and kmssrc a display, and neither is on an aircraft.
            meson setup /src/plugin/build /src/plugin --prefix=/usr --libdir=lib/aarch64-linux-gnu \
                --buildtype=release -Drockchipmpp=enabled -Drga=enabled \
                -Drkximage=disabled -Dkmssrc=disabled -Dvpxalphadec=disabled >/dev/null
            ninja -C /src/plugin/build >/dev/null
            strip /src/plugin/build/gst/rockchipmpp/libgstrockchipmpp.so
            # It registers. Without /dev/mpp_service the encoders stay
            # unregistered and only the decoders show, so the decoder is what
            # is asked for here; the role asks for the encoders on the board.
            GST_PLUGIN_PATH=/src/plugin/build/gst/rockchipmpp gst-inspect-1.0 rockchipmpp > /src/inspect.txt
            grep -q mppjpegdec /src/inspect.txt
            mkdir -p /src/out/lib /src/out/gstreamer-1.0
            cp -a "$lib"/librockchip_mpp.so* /src/out/lib/
            cp -a "$lib"/librga.so* /src/out/lib/
            cp /src/plugin/build/gst/rockchipmpp/libgstrockchipmpp.so /src/out/gstreamer-1.0/
            # Only what this container created: the host wrote the three
            # source trees with its own git, and a bind mount will not chown
            # the read-only objects git writes. These four are what the host
            # cleanup trap has to be able to remove.
            chown -R "$GR_OWNER" /src/out /src/inspect.txt /src/mpp/build /src/plugin/build
        ' || die "the gst-rockchip build failed in $GST_ROCKCHIP_IMAGE for $OCI_PLATFORM.
If it stopped at 'exec format error', this host cannot run $OCI_PLATFORM containers:
register the emulation handlers (Linux: qemu-user-static and binfmt-support) and try again."
    [ -f "$GR/out/gstreamer-1.0/libgstrockchipmpp.so" ] || die "the build reported success and produced no plugin"
    grep -q mppjpegdec "$GR/inspect.txt" || die "the built plugin registers no mppjpegdec; it is not the plugin"
    rm -rf "$OUT/gst-rockchip"
    mkdir -p "$OUT/gst-rockchip"
    cp -a "$GR/out/lib" "$OUT/gst-rockchip/lib"
    cp -a "$GR/out/gstreamer-1.0" "$OUT/gst-rockchip/gstreamer-1.0"
    cp "$GR/inspect.txt" "$OUT/gst-rockchip/inspect.txt"
    {
        printf 'mpp %s %s\n' "$MPP_COMMIT" "$MPP_REPO"
        printf 'librga %s %s\n' "$LIBRGA_COMMIT" "$LIBRGA_REPO"
        printf 'gstreamer-rockchip %s %s %s\n' "$GST_ROCKCHIP_COMMIT" "$GST_ROCKCHIP_REPO" "$GST_ROCKCHIP_BRANCH"
        if [ -n "$SHA_SUM" ]; then
            find "$OUT/gst-rockchip" -type f -name '*.so*' | sort | while read -r f; do
                printf 'sha256 %s %s\n' "$($SHA_SUM "$f" | cut -d' ' -f1)" "${f#"$OUT/gst-rockchip/"}"
            done
        fi
    } > "$OUT/gst-rockchip/MANIFEST"
    log "staged $OUT/gst-rockchip ($GR_PINS)"
    cat "$OUT/gst-rockchip/MANIFEST" | while read -r line; do log "  $line"; done
    fi
fi

# ---------------------------------------------------------------------------
if wanted console; then
    step "the console: node-red and the dashboard"

    CONSOLE_SRC="$HERE/console"
    [ -f "$CONSOLE_SRC/package.json" ] || die "no console manifest at $CONSOLE_SRC/package.json"

    rm -rf "$OUT/console"
    mkdir -p "$OUT/console"
    cp "$CONSOLE_SRC/package.json" "$OUT/console/package.json"

    if [ -f "$CONSOLE_SRC/package-lock.json" ]; then
        cp "$CONSOLE_SRC/package-lock.json" "$OUT/console/package-lock.json"
        # `npm ci` rather than `npm install`: it installs exactly what the
        # lockfile pins, so two payloads built a week apart carry the same
        # console instead of whatever the registry was serving each day.
        log "installing from the committed lockfile, resolved for $NPM_OS/$NPM_CPU/$NPM_LIBC"
        ( cd "$OUT/console" && npm ci --omit=dev --no-audit --no-fund \
            --os="$NPM_OS" --cpu="$NPM_CPU" --libc="$NPM_LIBC" ) \
            || die "npm ci failed in $OUT/console"
    else
        log "no lockfile yet; resolving one"
        ( cd "$OUT/console" && npm install --omit=dev --no-audit --no-fund \
            --os="$NPM_OS" --cpu="$NPM_CPU" --libc="$NPM_LIBC" ) \
            || die "npm install failed in $OUT/console"
        cp "$OUT/console/package-lock.json" "$CONSOLE_SRC/package-lock.json"
        log "wrote $CONSOLE_SRC/package-lock.json — commit it, or the next payload will differ"
    fi

    [ -f "$OUT/console/node_modules/node-red/red.js" ] \
        || die "node-red did not install into $OUT/console"
    [ -d "$OUT/console/node_modules/@flowfuse/node-red-dashboard" ] \
        || die "the dashboard did not install into $OUT/console"

    # The post-condition on the platform overrides above. A tree resolved for the
    # build machine is not a tree the board can run, and the only visible symptom
    # would have been a native module quietly falling back to a slower one — until
    # something arrives that has no fallback.
    foreign=$(find "$OUT/console/node_modules" -type d \
        \( -name '*darwin*' -o -name '*win32*' -o -name '*freebsd*' -o -name '*android*' \) \
        2>/dev/null | head -n 3)
    if [ -n "$foreign" ]; then
        die "the console tree carries packages built for another platform:
$foreign
that means npm resolved this tree for the build machine rather than for $ARCH"
    fi

    wrong_binding=$(find "$OUT/console/node_modules" -name '*.node' 2>/dev/null \
        | grep -v -- "-$NPM_OS-$NPM_CPU" | head -n 3)
    if [ -n "$wrong_binding" ]; then
        die "the console tree carries a native binding that is not for $ARCH:
$wrong_binding"
    fi

    # Not fatal: Node-RED catches a missing @node-rs/bcrypt and falls back to a
    # pure-JavaScript implementation, so a payload without it still works. Said
    # out loud anyway, because the usual cause is an npm too old to understand
    # --libc, and the next native dependency may not have a fallback.
    if [ -d "$OUT/console/node_modules/@node-rs/bcrypt" ] \
       && [ -z "$(find "$OUT/console/node_modules/@node-rs" -maxdepth 1 -type d -name "bcrypt-$NPM_OS-$NPM_CPU*" 2>/dev/null)" ]; then
        log "warning: no @node-rs/bcrypt binding for $ARCH was installed;"
        log "         the console will fall back to pure JavaScript. npm $(npm --version) may not"
        log "         understand --libc; npm 10.4 or newer does."
    fi
fi

# ---------------------------------------------------------------------------
step "done"
log "node:    $OUT/node/bin/node"
zt_staged="none staged"
for f in "$OUT"/zerotier/zerotier-one_*.deb; do
    [ -e "$f" ] && zt_staged="$f"
    break
done
log "zerotier: $zt_staged"
log "gst-rockchip: $([ -f "$OUT/gst-rockchip/gstreamer-1.0/libgstrockchipmpp.so" ] && printf '%s' "$OUT/gst-rockchip/gstreamer-1.0/libgstrockchipmpp.so" || printf 'none staged')"
log "mediamtx: $OUT/mediamtx/mediamtx"
log "console: $OUT/console/node_modules/node-red/red.js"

# What the payload carries now, not what this run happened to stage. A
# `--only console` run leaves the other three exactly as an earlier run left
# them, and reporting only this run's work would describe a payload that is
# not the one on disk.
#
# It also has to be a lookup rather than a variable: ZT_DEB (K-64's variable,
# fixed above by reading the staged .deb off disk instead) is set inside the
# zerotier step, so under `set -u` printing it after a run that skipped that
# step is an unbound variable and a non-zero exit at the very last line of a
# payload that built perfectly.
carries() {
    if [ -e "$2" ]; then
        log "$1 $2"
    else
        log "$1 (not in this payload)"
    fi
}
carries "node:           " "$OUT/node/bin/node"
carries "zerotier:       " "$OUT/zerotier"
carries "mavlink-router: " "$OUT/mavlink-router/mavlink-routerd"
carries "console:        " "$OUT/console/node_modules/node-red/red.js"
log ""
log "vendor/ is git-ignored. Copy this whole repository, vendor/ included, to"
log "the board (or into the image build) and run installer/install.sh there."
