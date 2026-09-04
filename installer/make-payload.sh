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
ZEROTIER_SHA256_arm64=e6c71707d8db57dd9bc6d6a4d5d5b8343ad244f48ff1ebd288f5f588fbdb10a4
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
MEDIAMTX_SHA256_arm64=d1689f0bfefb1864e5ed3dcc8495eb2d7ec0a654f90bf3cd48980cb3bd08718a
MEDIAMTX_SHA256_amd64=81b143f55a5d23d4a8c028d52869c14ea4a59919900528698fcc97a747fd69c6

ARCH=""
OUT="$REPO/vendor"

usage() {
    cat <<'USAGE'
Usage: make-payload.sh --arch <linux-arm64|linux-x64> [--out DIR]

  --arch ARCH        the board's architecture; required
  --out DIR          where to stage the payload (default: vendor/ in this repo)
  --node-version V   override the pinned Node version
  -h, --help         this message

Produces:
  DIR/node/bin/node                              the runtime both services use
  DIR/console/node_modules/node-red/red.js       the console
  DIR/mediamtx/mediamtx                          the media server
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --arch)         shift; [ $# -gt 0 ] || { usage; exit 2; }; ARCH="$1" ;;
        --out)          shift; [ $# -gt 0 ] || { usage; exit 2; }; OUT="$1" ;;
        --node-version) shift; [ $# -gt 0 ] || { usage; exit 2; }; NODE_VERSION="$1" ;;
        -h|--help)      usage; exit 0 ;;
        *)              printf 'unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
    esac
    shift
done

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
log()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

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
case "$ARCH" in
    linux-arm64) NPM_OS=linux; NPM_CPU=arm64; DEB_ARCH=arm64 ;;
    linux-x64)   NPM_OS=linux; NPM_CPU=x64;   DEB_ARCH=amd64 ;;
    "") die "--arch is required (linux-arm64 for a Raspberry Pi or Radxa, linux-x64 for a PC)" ;;
    *)  die "unsupported architecture: $ARCH" ;;
esac
# Debian, so glibc. A musl target would be a different --arch.
NPM_LIBC=glibc

command -v curl >/dev/null 2>&1 || die "curl is needed to fetch the payload"
command -v tar  >/dev/null 2>&1 || die "tar is needed to unpack the payload"
command -v npm  >/dev/null 2>&1 || die "npm is needed to install the console's dependencies"

# sha256sum on Linux, shasum on macOS. Checking the download is not optional:
# a payload that silently accepts a corrupt or substituted runtime is not a
# payload worth having, and the thing it would be substituted into is the
# process that talks to an aircraft.
if command -v sha256sum >/dev/null 2>&1; then
    SHA_CHECK="sha256sum -c"
elif command -v shasum >/dev/null 2>&1; then
    SHA_CHECK="shasum -a 256 -c"
else
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

# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
step "done"
log "node:    $OUT/node/bin/node"
log "zerotier: $OUT/zerotier/$ZT_DEB"
log "mediamtx: $OUT/mediamtx/mediamtx"
log "console: $OUT/console/node_modules/node-red/red.js"
log ""
log "vendor/ is git-ignored. Copy this whole repository, vendor/ included, to"
log "the board (or into the image build) and run installer/install.sh there."
