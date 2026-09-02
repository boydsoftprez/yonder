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
    linux-arm64) NPM_OS=linux; NPM_CPU=arm64 ;;
    linux-x64)   NPM_OS=linux; NPM_CPU=x64 ;;
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
log "console: $OUT/console/node_modules/node-red/red.js"
log ""
log "vendor/ is git-ignored. Copy this whole repository, vendor/ included, to"
log "the board (or into the image build) and run installer/install.sh there."
