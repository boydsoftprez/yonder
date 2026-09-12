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
ZEROTIER_SOURCE_URL=${ZEROTIER_SOURCE_URL:-https://codeload.github.com/zerotier/ZeroTierOne/tar.gz/refs/tags/$ZEROTIER_VERSION}
ZEROTIER_SOURCE_SHA256=2c607f573c6e38815433af289d364a689a203b18b51125f06c4472014d0657f0
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
MAVLINK_ROUTER_IMAGE=${MAVLINK_ROUTER_IMAGE:-debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1}
APPLICATION_IMAGE=${APPLICATION_IMAGE:-debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1}

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
GST_ROCKCHIP_IMAGE=${GST_ROCKCHIP_IMAGE:-debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1}

# RKAIQ userspace for the ZERO 3W's ISP21 camera path. The commit is the
# complete source input fingerprint; the two IQ inputs additionally have
# recorded byte hashes because they are fetched as individual files.
RKAIQ_COMMIT=${RKAIQ_COMMIT:-622bdfa1ee61d2279cfc273b1a53b546e0ec71be}
RKAIQ_REPO=${RKAIQ_REPO:-https://github.com/roju/rkaiq_3A_server-rk356x}
RKAIQ_IMAGE=${RKAIQ_IMAGE:-debian@sha256:f324c7ff54321e8d9c588493a20244965938ce0aa50bbd1022d38010e9ffc4b1}
SEEKERHD_REFERENCE_COMMIT=${SEEKERHD_REFERENCE_COMMIT:-0b896b19cb43132ea5cd862a5a7f7870c292f07e}
SEEKERHD_REFERENCE_URL=${SEEKERHD_REFERENCE_URL:-https://raw.githubusercontent.com/kinchims/Radxa-Zero3-IMX462/$SEEKERHD_REFERENCE_COMMIT/etc/iqfiles/imx290_IMX462_default.json}
SEEKERHD_REFERENCE_SHA256=6f596c69c62f9d46be45328d921c52c231426a4f7bbd0a4556bd5111d858052f
SEEKERHD_DIVIMATH_COMMIT=${SEEKERHD_DIVIMATH_COMMIT:-b94150b2b5798840ed5d931232808100836a8606}
SEEKERHD_DIVIMATH_URL=${SEEKERHD_DIVIMATH_URL:-https://raw.githubusercontent.com/rquellet/SeekerHD-RaspberryPi-Helper/$SEEKERHD_DIVIMATH_COMMIT/installer/Divimath-SeekerHD/tuning/imx462-seekerhd.json}
SEEKERHD_DIVIMATH_SHA256=d51bfea346bd1932ce76cab5cbf064e103af144e0e389178f81bf37e7cae2ac0

# The things a payload can carry, in the order they are staged.
COMPONENTS="node zerotier mediamtx mavlink-router gst-rockchip seekerhd console application"

ARCH=""
OUT="$REPO/vendor"
ONLY=""
TARGET=""
CAPTURE_INPUTS=""
OUT_EXPLICIT=0
ONLY_EXPLICIT=0

usage() {
    cat <<'USAGE'
Usage: make-payload.sh --arch <linux-arm64|linux-x64> [--out DIR] [--only LIST]
       make-payload.sh --arch linux-arm64 --target TARGET --out NEW_DIR \
         --capture-inputs NEW_DIR

  --arch ARCH        the board's architecture; required
  --out DIR          where to stage the payload (default: vendor/ in this repo)
  --only LIST        stage only these components, comma-separated:
                     node, zerotier, mediamtx, mavlink-router, gst-rockchip,
                     seekerhd, console.
                     Default: all of them. What is not staged in this run is
                     left exactly as an earlier run left it, so --only is an
                     update of one part of a payload rather than a smaller
                     payload.
  --node-version V   override the pinned Node version
  --target TARGET     rpi, radxa-zero3w or radxa-rock5c; required with
                     --capture-inputs and invalid otherwise
  --capture-inputs DIR
                     retain exact public inputs, sources, notices and payload
                     output for offline replay; DIR and --out must be new
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
  DIR/seekerhd/                                           pinned RKAIQ and generated IQ profiles
  DIR/console/node_modules/node-red/red.js        the console
  DIR/application/packages/                       fresh first-party ARM64 build (capture mode)
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --arch)         shift; [ $# -gt 0 ] || { usage; exit 2; }; ARCH="$1" ;;
        --out)          shift; [ $# -gt 0 ] || { usage; exit 2; }; OUT="$1"; OUT_EXPLICIT=1 ;;
        --only)         shift; [ $# -gt 0 ] || { usage; exit 2; }; ONLY="$1"; ONLY_EXPLICIT=1 ;;
        --node-version) shift; [ $# -gt 0 ] || { usage; exit 2; }; NODE_VERSION="$1" ;;
        --target)       shift; [ $# -gt 0 ] || { usage; exit 2; }; TARGET="$1" ;;
        --capture-inputs) shift; [ $# -gt 0 ] || { usage; exit 2; }; CAPTURE_INPUTS="$1" ;;
        -h|--help)      usage; exit 0 ;;
        *)              printf 'unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
    esac
    shift
done

die()  { printf 'error: %s\n' "$*" >&2; exit 1; }
log()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

if [ -n "$CAPTURE_INPUTS" ]; then
    command -v python3 >/dev/null 2>&1 \
        || die "--capture-inputs requires python3"
    OUT=$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$OUT")
    CAPTURE_INPUTS=$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$CAPTURE_INPUTS")
    python3 -c '
from pathlib import Path
import sys
left, right = map(Path, sys.argv[1:])
raise SystemExit(1 if left == right or left in right.parents or right in left.parents else 0)
' "$OUT" "$CAPTURE_INPUTS" \
        || die "--out and --capture-inputs must be separate, non-nested paths"
    [ "$ONLY_EXPLICIT" = "0" ] || die "--capture-inputs does not accept --only; a production capture must select the target's complete payload"
    [ "$OUT_EXPLICIT" = "1" ] || die "--capture-inputs requires an explicit new --out directory"
    [ "$ARCH" = "linux-arm64" ] || die "--capture-inputs is for the ARM64 image targets"
    case "$TARGET" in
        rpi) ONLY="node,zerotier,mediamtx,mavlink-router,console,application" ;;
        radxa-zero3w) ONLY="node,zerotier,mediamtx,mavlink-router,gst-rockchip,seekerhd,console,application" ;;
        radxa-rock5c) ONLY="node,zerotier,mediamtx,mavlink-router,gst-rockchip,console,application" ;;
        *) die "--capture-inputs requires --target rpi, radxa-zero3w or radxa-rock5c" ;;
    esac
    [ ! -e "$OUT" ] && [ ! -L "$OUT" ] || die "--capture-inputs requires a new --out directory"
    [ ! -e "$CAPTURE_INPUTS" ] && [ ! -L "$CAPTURE_INPUTS" ] \
        || die "--capture-inputs output must not already exist"
elif [ -n "$TARGET" ]; then
    die "--target is valid only with --capture-inputs"
fi

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
if [ -z "$CAPTURE_INPUTS" ]; then
    case " $ONLY_LIST " in
        *" application "*) die "application is built only as part of a complete --capture-inputs target" ;;
    esac
fi

wanted() {
    # The application bundle is a production-capture input. Ordinary partial
    # payload refreshes retain their established behavior and never trust or
    # rebuild local ignored workspace output.
    [ "$1" = "application" ] && [ -z "$CAPTURE_INPUTS" ] && return 1
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
case " $ONLY_LIST " in
    *" seekerhd "*) SEEKERHD_EXPLICIT=1 ;;
    *) SEEKERHD_EXPLICIT=0 ;;
esac
if [ "$ARCH" != "linux-arm64" ] && [ "$SEEKERHD_EXPLICIT" = "1" ]; then
    die "SeekerHD is available only for linux-arm64"
fi
# Debian, so glibc. A musl target would be a different --arch.
NPM_LIBC=glibc

# Asked per component, not once for everything: a run that stages only the
# router needs neither npm nor a checksum tool, and dying for the want of one
# it will never call is how a selector stops being usable.
if wanted node || wanted zerotier || wanted mediamtx \
        || { [ "$ARCH" = "linux-arm64" ] && wanted seekerhd; }; then
    command -v curl >/dev/null 2>&1 || die "curl is needed to fetch the payload"
fi
if wanted node || wanted mediamtx; then
    command -v tar >/dev/null 2>&1 || die "tar is needed to unpack the payload"
fi
if wanted console; then
    command -v npm >/dev/null 2>&1 || die "npm is needed to install the console's dependencies"
fi
if [ "$ARCH" = "linux-arm64" ] && wanted seekerhd; then
    command -v git >/dev/null 2>&1 || die "git is needed to fetch the pinned RKAIQ source"
    command -v patch >/dev/null 2>&1 || die "patch is needed to prepare RKAIQ"
    command -v python3 >/dev/null 2>&1 || die "python3 is needed to generate the IQ profiles"
fi
if [ -n "$CAPTURE_INPUTS" ]; then
    command -v python3 >/dev/null 2>&1 || die "python3 is needed to inventory retained payload inputs"
    command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb is needed to retain the ZeroTier package notice"
    [ -f "$REPO/image/inputs/payload-inventory.py" ] \
        || die "image/inputs/payload-inventory.py is missing"
    [ -f "$REPO/image/inputs/application-bundle.py" ] \
        || die "image/inputs/application-bundle.py is missing"
fi
if wanted application; then
    command -v git >/dev/null 2>&1 || die "git is needed to archive the exact application source"
    APP_ENGINE=$(command -v docker 2>/dev/null || command -v podman 2>/dev/null || true)
    [ -n "$APP_ENGINE" ] || die "docker or podman is needed to build the ARM64 application"
    APP_SOURCE_COMMIT=$(git -C "$REPO" rev-parse HEAD 2>/dev/null) \
        || die "could not identify the application source commit"
    [ -z "$(git -C "$REPO" status --porcelain --untracked-files=all)" ] \
        || die "production application capture requires a clean source tree"
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
elif wanted node || wanted zerotier || wanted mediamtx \
        || { [ "$ARCH" = "linux-arm64" ] && wanted seekerhd; }; then
    die "neither sha256sum nor shasum is here; the Node download could not be verified"
fi

mkdir -p "$OUT"
OUT=$(CDPATH='' cd -- "$OUT" && pwd)
WORK="$OUT/.work"
rm -rf "$WORK"
mkdir -p "$WORK"
# The staging directory is removed on any exit, including a failed download,
# so a re-run never resumes from a half-fetched tarball.
cleanup_payload() {
    cleanup_status=$?
    trap - EXIT INT TERM
    rm -rf "$WORK"
    if [ "$cleanup_status" -ne 0 ] && [ -n "$CAPTURE_INPUTS" ]; then
        # Both paths were required to be absent before capture began, so a
        # failed production capture cannot leave a plausible partial result.
        rm -rf "$OUT" "$CAPTURE_INPUTS"
    fi
    exit "$cleanup_status"
}
trap cleanup_payload EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

CAPTURE_STAGE=""
if [ -n "$CAPTURE_INPUTS" ]; then
    CAPTURE_STAGE="$WORK/payload-capture"
    mkdir -p "$CAPTURE_STAGE/inputs"
    : >"$CAPTURE_STAGE/records.tsv"
fi

retain_record() {
    [ -n "$CAPTURE_STAGE" ] || return 0
    printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" >>"$CAPTURE_STAGE/records.tsv"
}

retain_file() {
    [ -n "$CAPTURE_STAGE" ] || return 0
    retain_destination="$CAPTURE_STAGE/$6"
    mkdir -p "$(dirname -- "$retain_destination")"
    cp -p "$5" "$retain_destination"
    retain_record "$1" "$2" "$3" "$4" "$6"
}

retain_tree() {
    [ -n "$CAPTURE_STAGE" ] || return 0
    retain_destination="$CAPTURE_STAGE/$6"
    mkdir -p "$(dirname -- "$retain_destination")"
    cp -pR "$5" "$retain_destination"
    retain_record "$1" "$2" "$3" "$4" "$6"
}

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
    retain_file archive node-distribution "$($SHA_SUM "$WORK/$NODE_TARBALL" | cut -d' ' -f1)" \
        "$NODE_URL" "$WORK/$NODE_TARBALL" "inputs/downloads/node/$NODE_TARBALL"
    retain_file index node-checksums "v$NODE_VERSION" "$NODE_DIST/v$NODE_VERSION/SHASUMS256.txt" \
        "$WORK/SHASUMS256.txt" "inputs/downloads/node/SHASUMS256.txt"

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
if wanted application; then
    step "first-party application at $APP_SOURCE_COMMIT for linux/arm64"
    APP_SOURCE_ARCHIVE="$CAPTURE_STAGE/inputs/sources/application/source.tar"
    APP_NPM_INPUT="$CAPTURE_STAGE/inputs/npm/application"
    APP_BUILD="$WORK/application"
    python3 -I "$REPO/image/inputs/application-bundle.py" \
        --repo "$REPO" \
        --output "$APP_BUILD" \
        --npm-input "$APP_NPM_INPUT" \
        --source-output "$APP_SOURCE_ARCHIVE" \
        --node-runtime "$OUT/node" \
        --engine "$APP_ENGINE" \
        --image "$APPLICATION_IMAGE" \
        --platform linux/arm64 \
        --expected-commit "$APP_SOURCE_COMMIT" \
        || die "could not build the first-party ARM64 application from clean source"
    APP_ARCHIVE_SHA=$($SHA_SUM "$APP_SOURCE_ARCHIVE" | cut -d' ' -f1)
    APP_LOCK_SHA=$($SHA_SUM "$APP_NPM_INPUT/manifests/package-lock.json" | cut -d' ' -f1)
    retain_record git-source application-source "$APP_SOURCE_COMMIT" \
        "repository:git-archive" "inputs/sources/application/source.tar"
    retain_record index application-manifests "$APP_LOCK_SHA" \
        "repository:package-lock.json" "inputs/npm/application/manifests"
    retain_record npm-cache application-npm-cache "$APP_LOCK_SHA" \
        "https://registry.npmjs.org/" "inputs/npm/application/cache"
    # The archive hash is repeated in the bundle metadata and the outer file
    # inventory; checking it here catches a helper/caller handoff mismatch.
    APP_RECORDED_SHA=$(python3 -c \
        'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["sourceArchiveSha256"])' \
        "$APP_BUILD/application-bundle.json")
    [ "$APP_ARCHIVE_SHA" = "$APP_RECORDED_SHA" ] \
        || die "application source archive does not match its build metadata"
    mv "$APP_BUILD" "$OUT/application"
    log "staged fresh first-party application and standalone yonder-core dependencies"
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
    if [ -n "$CAPTURE_STAGE" ]; then
        ZT_SOURCE="ZeroTierOne-$ZEROTIER_VERSION.tar.gz"
        curl -fsSL --retry 3 -o "$WORK/$ZT_SOURCE" "$ZEROTIER_SOURCE_URL" \
            || die "could not download the ZeroTier $ZEROTIER_VERSION source archive"
        printf '%s  %s\n' "$ZEROTIER_SOURCE_SHA256" "$ZT_SOURCE" \
            >"$WORK/zerotier-source.sha256"
        (cd "$WORK" && $SHA_CHECK zerotier-source.sha256) >/dev/null \
            || die "$ZT_SOURCE does not match its recorded source checksum"
        retain_file archive zerotier-source "$ZEROTIER_SOURCE_SHA256" \
            "$ZEROTIER_SOURCE_URL" "$WORK/$ZT_SOURCE" \
            "inputs/sources/zerotier/$ZT_SOURCE"
    fi
    retain_file index zerotier-inrelease "$ZEROTIER_VERSION" \
        "$ZEROTIER_REPO/dists/trixie/InRelease" "$WORK/InRelease" \
        "inputs/downloads/zerotier/InRelease"
    retain_file index zerotier-packages "$want" \
        "$ZEROTIER_REPO/dists/trixie/main/binary-$DEB_ARCH/Packages" "$WORK/Packages" \
        "inputs/downloads/zerotier/Packages"
    retain_file archive zerotier-package "$ZT_EXPECTED" \
        "$ZEROTIER_REPO/pool/main/z/zerotier-one/$ZT_DEB" "$WORK/$ZT_DEB" \
        "inputs/downloads/zerotier/$ZT_DEB"
    if [ -n "$CAPTURE_STAGE" ]; then
        rm -rf "$WORK/zerotier-notice"
        dpkg-deb -x "$WORK/$ZT_DEB" "$WORK/zerotier-notice" \
            || die "could not extract the ZeroTier package notice"
        ZT_NOTICE="$WORK/zerotier-notice/usr/share/doc/zerotier-one/copyright"
        [ -f "$ZT_NOTICE" ] || die "the ZeroTier package has no copyright notice"
        retain_file notice zerotier-copyright "$ZEROTIER_VERSION" "$ZEROTIER_REPO" \
            "$ZT_NOTICE" "inputs/notices/zerotier-one.copyright"
    fi

    rm -rf "$OUT/zerotier"
    mkdir -p "$OUT/zerotier"
    mv "$WORK/$ZT_DEB" "$OUT/zerotier/$ZT_DEB"
    log "staged $OUT/zerotier/$ZT_DEB"
fi

# ---------------------------------------------------------------------------
if wanted mediamtx; then
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
retain_file index mediamtx-checksums "v$MEDIAMTX_VERSION" \
    "$MEDIAMTX_BASE/v$MEDIAMTX_VERSION/checksums.sha256" "$WORK/mediamtx.sha256" \
    "inputs/downloads/mediamtx/checksums.sha256"
retain_file archive mediamtx-distribution "$MTX_EXPECTED" \
    "$MEDIAMTX_BASE/v$MEDIAMTX_VERSION/$MTX_TARBALL" "$WORK/$MTX_TARBALL" \
    "inputs/downloads/mediamtx/$MTX_TARBALL"

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
fi

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
    retain_tree git-source mavlink-router "$MR_HEAD" "$MAVLINK_ROUTER_REPO" \
        "$WORK/mavlink-router" "inputs/sources/mavlink-router"

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
if [ "$ARCH" = "linux-arm64" ] && wanted seekerhd; then
    step "SeekerHD RKAIQ $RKAIQ_COMMIT and pinned IQ inputs for $ARCH"
    SH_ENGINE=$(command -v docker 2>/dev/null || command -v podman 2>/dev/null || true)
    [ -n "$SH_ENGINE" ] || die "no docker or podman here, and SeekerHD RKAIQ is a source build"
    SH_SRC="$WORK/seekerhd-rkaiq"
    mkdir -p "$SH_SRC"
    git -C "$SH_SRC" init --quiet
    git -C "$SH_SRC" remote add origin "$RKAIQ_REPO"
    git -C "$SH_SRC" fetch --quiet --depth=1 origin "$RKAIQ_COMMIT" \
        || die "could not fetch RKAIQ $RKAIQ_COMMIT from $RKAIQ_REPO"
    git -C "$SH_SRC" checkout --quiet --detach FETCH_HEAD
    SH_HEAD=$(git -C "$SH_SRC" rev-parse HEAD)
    [ "$SH_HEAD" = "$RKAIQ_COMMIT" ] \
        || die "the RKAIQ checkout is at $SH_HEAD, not the pinned $RKAIQ_COMMIT"
    retain_tree git-source rkaiq "$SH_HEAD" "$RKAIQ_REPO" "$SH_SRC" \
        "inputs/sources/rkaiq"

    # Normal linear service: readiness, scheduling fallback, current sensor
    # timing, native live controls, and the vendor 6.1 frame-interval ABI.
    # aiq-hdr-mode.patch is deliberately absent; the image never opts into
    # experimental HDR.
    SH_PATCHES="aiq-server.patch aiq-thread-fallback.patch aiq-sensor-timing.patch aiq-live-controls.patch aiq-vendor-hdr-abi.patch"
    for sh_patch in $SH_PATCHES; do
        retain_file patch "rkaiq-$sh_patch" \
            "$($SHA_SUM "$REPO/scripts/spikes/seekerhd/$sh_patch" | cut -d' ' -f1)" \
            "repository:scripts/spikes/seekerhd/$sh_patch" \
            "$REPO/scripts/spikes/seekerhd/$sh_patch" "inputs/patches/seekerhd/$sh_patch"
        patch --batch --forward -d "$SH_SRC" -p1 \
            <"$REPO/scripts/spikes/seekerhd/$sh_patch" \
            || die "$sh_patch does not apply to pinned RKAIQ $RKAIQ_COMMIT"
    done

    log "building patched ISP21 RKAIQ in $RKAIQ_IMAGE for $OCI_PLATFORM"
    # shellcheck disable=SC2016 # SH_OWNER is expanded by the container shell
    "$SH_ENGINE" run --rm --platform "$OCI_PLATFORM" \
        -v "$SH_SRC:/src" -w /src \
        -e DEBIAN_FRONTEND=noninteractive \
        -e "SH_OWNER=$(id -u):$(id -g)" \
        "$RKAIQ_IMAGE" sh -c '
            set -eu
            apt-get update -qq
            apt-get install -y --no-install-recommends \
                build-essential cmake pkg-config libdrm-dev m4 xxd >/dev/null
            cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release >/dev/null
            cmake --build /src/build --parallel "$(nproc)" >/dev/null
            sh_lib=$(find /src/build -type f -name librkaiq.so -print -quit)
            sh_bin=$(find /src/build -type f -name rkaiq_3A_server -perm /111 -print -quit)
            [ -n "$sh_lib" ] && [ -n "$sh_bin" ]
            mkdir -p /src/yonder-out/bin /src/yonder-out/lib
            cp "$sh_lib" /src/yonder-out/lib/librkaiq.so
            cp "$sh_bin" /src/yonder-out/bin/rkaiq_3A_server
            strip /src/yonder-out/lib/librkaiq.so /src/yonder-out/bin/rkaiq_3A_server
            sh_ldd=$(LD_LIBRARY_PATH=/src/yonder-out/lib \
                ldd /src/yonder-out/bin/rkaiq_3A_server)
            ! printf "%s\n" "$sh_ldd" | grep -q "not found"
            chown -R "$SH_OWNER" /src/build /src/yonder-out
        ' || die "the SeekerHD RKAIQ build failed in $RKAIQ_IMAGE for $OCI_PLATFORM"

    SH_IQ="$WORK/seekerhd-iq"
    mkdir -p "$SH_IQ"
    curl -fsSL --retry 3 -o "$SH_IQ/reference.json" "$SEEKERHD_REFERENCE_URL" \
        || die "could not fetch the pinned Rockchip IMX462 IQ reference"
    curl -fsSL --retry 3 -o "$SH_IQ/divimath.json" "$SEEKERHD_DIVIMATH_URL" \
        || die "could not fetch the pinned Divimath SeekerHD tuning"
    printf '%s  %s\n' "$SEEKERHD_REFERENCE_SHA256" reference.json \
        >"$SH_IQ/inputs.sha256"
    printf '%s  %s\n' "$SEEKERHD_DIVIMATH_SHA256" divimath.json \
        >>"$SH_IQ/inputs.sha256"
    (cd "$SH_IQ" && $SHA_CHECK inputs.sha256) >/dev/null \
        || die "a SeekerHD IQ input does not match its recorded checksum"
    retain_file archive seekerhd-reference-iq "$SEEKERHD_REFERENCE_SHA256" \
        "$SEEKERHD_REFERENCE_URL" "$SH_IQ/reference.json" \
        "inputs/downloads/seekerhd/reference.json"
    retain_file archive seekerhd-divimath-iq "$SEEKERHD_DIVIMATH_SHA256" \
        "$SEEKERHD_DIVIMATH_URL" "$SH_IQ/divimath.json" \
        "inputs/downloads/seekerhd/divimath.json"
    python3 "$REPO/scripts/spikes/seekerhd/tune.py" \
        "$SH_IQ/reference.json" "$SH_IQ/divimath.json" "$SH_IQ/tuned.json"
    python3 "$REPO/scripts/spikes/seekerhd/profiles.py" \
        "$SH_IQ/tuned.json" "$SH_IQ/profiles" >/dev/null

    SH_OUT="$WORK/seekerhd-out"
    mkdir -p "$SH_OUT/bin" "$SH_OUT/lib" "$SH_OUT/iqfiles" "$SH_OUT/profiles"
    cp "$SH_SRC/yonder-out/bin/rkaiq_3A_server" "$SH_OUT/bin/"
    cp "$SH_SRC/yonder-out/lib/librkaiq.so" "$SH_OUT/lib/"
    cp "$SH_IQ/profiles/normal-light.json" \
        "$SH_OUT/iqfiles/imx462_IMX462_default.json"
    cp "$SH_IQ/profiles/"*.json "$SH_OUT/profiles/"
    chmod 0755 "$SH_OUT/bin/rkaiq_3A_server"
    chmod 0644 "$SH_OUT/lib/librkaiq.so" "$SH_OUT/iqfiles/"*.json \
        "$SH_OUT/profiles/"*.json
    {
        printf 'rkaiq %s %s\n' "$RKAIQ_COMMIT" "$RKAIQ_REPO"
        printf 'rockchip-iq %s %s %s\n' "$SEEKERHD_REFERENCE_COMMIT" \
            "$SEEKERHD_REFERENCE_SHA256" "$SEEKERHD_REFERENCE_URL"
        printf 'divimath-iq %s %s %s\n' "$SEEKERHD_DIVIMATH_COMMIT" \
            "$SEEKERHD_DIVIMATH_SHA256" "$SEEKERHD_DIVIMATH_URL"
        for sh_patch in $SH_PATCHES; do
            printf 'patch %s %s\n' \
                "$($SHA_SUM "$REPO/scripts/spikes/seekerhd/$sh_patch" | cut -d' ' -f1)" \
                "$sh_patch"
        done
        printf '%s\n' 'mode linear'
    } >"$SH_OUT/SOURCES"
    (
        cd "$SH_OUT"
        find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort \
            | sed 's#^./##' | while IFS= read -r sh_file; do
                printf '%s  %s\n' "$($SHA_SUM "$sh_file" | cut -d' ' -f1)" "$sh_file"
            done
    ) >"$SH_OUT/SHA256SUMS"
    rm -rf "$OUT/seekerhd"
    mv "$SH_OUT" "$OUT/seekerhd"
    log "staged $OUT/seekerhd from pinned RKAIQ and verified IQ inputs"
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
    retain_tree git-source rockchip-mpp "$MPP_COMMIT" "$MPP_REPO" "$GR/mpp" \
        "inputs/sources/rockchip-mpp"
    retain_tree git-source librga "$LIBRGA_COMMIT" "$LIBRGA_REPO" "$GR/librga" \
        "inputs/sources/librga"
    retain_tree git-source gstreamer-rockchip "$GST_ROCKCHIP_COMMIT" \
        "$GST_ROCKCHIP_REPO" "$GR/plugin" \
        "inputs/sources/gstreamer-rockchip"
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
    if [ -n "$CAPTURE_STAGE" ] && [ ! -f "$CONSOLE_SRC/package-lock.json" ]; then
        die "production payload capture requires installer/console/package-lock.json"
    fi

    NPM_CACHE=""
    if [ -n "$CAPTURE_STAGE" ]; then
        NPM_CACHE="$CAPTURE_STAGE/inputs/npm/cache"
        mkdir -p "$NPM_CACHE"
    fi

    rm -rf "$OUT/console"
    mkdir -p "$OUT/console"
    cp "$CONSOLE_SRC/package.json" "$OUT/console/package.json"

    if [ -f "$CONSOLE_SRC/package-lock.json" ]; then
        cp "$CONSOLE_SRC/package-lock.json" "$OUT/console/package-lock.json"
        # `npm ci` rather than `npm install`: it installs exactly what the
        # lockfile pins, so two payloads built a week apart carry the same
        # console instead of whatever the registry was serving each day.
        log "installing from the committed lockfile, resolved for $NPM_OS/$NPM_CPU/$NPM_LIBC"
        if [ -n "$NPM_CACHE" ]; then
            ( cd "$OUT/console" && npm ci --omit=dev --no-audit --no-fund \
                --cache="$NPM_CACHE" --os="$NPM_OS" --cpu="$NPM_CPU" --libc="$NPM_LIBC" ) \
                || die "npm ci failed in $OUT/console"
        else
            ( cd "$OUT/console" && npm ci --omit=dev --no-audit --no-fund \
                --os="$NPM_OS" --cpu="$NPM_CPU" --libc="$NPM_LIBC" ) \
                || die "npm ci failed in $OUT/console"
        fi
    else
        log "no lockfile yet; resolving one"
        ( cd "$OUT/console" && npm install --omit=dev --no-audit --no-fund \
            --os="$NPM_OS" --cpu="$NPM_CPU" --libc="$NPM_LIBC" ) \
            || die "npm install failed in $OUT/console"
        cp "$OUT/console/package-lock.json" "$CONSOLE_SRC/package-lock.json"
        log "wrote $CONSOLE_SRC/package-lock.json — commit it, or the next payload will differ"
    fi

    if [ -n "$CAPTURE_STAGE" ]; then
        rm -rf "$NPM_CACHE/_logs"
        rm -f "$NPM_CACHE/_update-notifier-last-checked"
        retain_file index console-package-json \
            "$($SHA_SUM "$CONSOLE_SRC/package.json" | cut -d' ' -f1)" \
            "repository:installer/console/package.json" "$CONSOLE_SRC/package.json" \
            "inputs/npm/manifests/package.json"
        retain_file index console-package-lock \
            "$($SHA_SUM "$CONSOLE_SRC/package-lock.json" | cut -d' ' -f1)" \
            "repository:installer/console/package-lock.json" "$CONSOLE_SRC/package-lock.json" \
            "inputs/npm/manifests/package-lock.json"
        retain_record npm-cache console-npm-cache \
            "$($SHA_SUM "$CONSOLE_SRC/package-lock.json" | cut -d' ' -f1)" \
            "https://registry.npmjs.org/" "inputs/npm/cache"
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
if [ -n "$CAPTURE_STAGE" ]; then
    step "inventorying retained application payload for $TARGET"
    if [ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" != "$APP_SOURCE_COMMIT" ] ||
            [ -n "$(git -C "$REPO" status --porcelain --untracked-files=all)" ]; then
        die "application source changed during production payload capture"
    fi
    capture_inventory() {
        python3 -I "$REPO/image/inputs/payload-inventory.py" capture \
            --staging "$CAPTURE_STAGE" \
            --payload "$OUT" \
            --output "$CAPTURE_INPUTS" \
            --target "$TARGET" \
            --arch "$ARCH" \
            --selected "$ONLY" \
            "$@"
    }
    case "$TARGET" in
        rpi)
            capture_inventory \
                --toolchain "application=$APPLICATION_IMAGE" \
                --toolchain "mavlink-router=$MAVLINK_ROUTER_IMAGE"
            ;;
        radxa-rock5c)
            capture_inventory \
                --toolchain "application=$APPLICATION_IMAGE" \
                --toolchain "mavlink-router=$MAVLINK_ROUTER_IMAGE" \
                --toolchain "gst-rockchip=$GST_ROCKCHIP_IMAGE"
            ;;
        radxa-zero3w)
            capture_inventory \
                --toolchain "application=$APPLICATION_IMAGE" \
                --toolchain "mavlink-router=$MAVLINK_ROUTER_IMAGE" \
                --toolchain "gst-rockchip=$GST_ROCKCHIP_IMAGE" \
                --toolchain "seekerhd-rkaiq=$RKAIQ_IMAGE"
            ;;
    esac
    log "retained inputs and exact payload replay at $CAPTURE_INPUTS"
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
