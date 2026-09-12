#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Focused installer contract for the ZERO 3W SeekerHD stack.
set -eu

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/yonder-seekerhd-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
out="$tmp/out"
failures=0

ok() { printf 'ok - %s\n' "$*"; }
bad() { printf 'not ok - %s\n' "$*"; failures=$((failures + 1)); }

# The payload builder exposes SeekerHD as an explicit ARM64-only component.
# This stops before network or container work and proves the selector routes
# to the camera component rather than rejecting the name or building for x64.
if "$REPO/installer/make-payload.sh" --arch linux-x64 --only seekerhd \
        --out "$tmp/payload" >"$out" 2>&1; then
    bad "the payload builder accepted SeekerHD for a non-ARM64 target"
elif grep -q 'SeekerHD is available only for linux-arm64' "$out"; then
    ok "the payload builder selects SeekerHD and gates it to ARM64"
else
    bad "the payload builder does not expose the pinned SeekerHD component"
    sed 's/^/      /' "$out"
fi

# A wrong image target must never receive camera boot configuration merely
# because both Radxa bases carry the same vendor kernel package.
if /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w
    . "$1/installer/lib/common.sh"
    . "$1/installer/lib/seekerhd.sh"
    seekerhd_target_selected
' sh "$REPO" \
    && ! /bin/sh -c '
        set -eu
        DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-rock5c
        . "$1/installer/lib/common.sh"
        . "$1/installer/lib/seekerhd.sh"
        seekerhd_target_selected
    ' sh "$REPO"; then
    ok "camera integration selects only the ZERO 3W image target"
else
    bad "camera integration leaked onto another image target"
fi

# Kernel discovery must read the target filesystem. In an image chroot uname
# is the build host kernel and could build an unusable module while reporting
# success.
mkdir -p "$tmp/modules/6.1.115-vendor-rk35xx/build" \
    "$tmp/modules/6.1.116-vendor-rk35xx/build" "$tmp/bin"
cat >"$tmp/bin/uname" <<'EOF'
#!/bin/sh
printf '%s\n' 'uname must not be consulted' >&2
exit 99
EOF
chmod +x "$tmp/bin/uname"
if kernels=$(PATH="$tmp/bin:$PATH" /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w
    YONDER_SEEKER_MODULES_DIR=$1
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/seekerhd.sh"
    seekerhd_kernel_releases
' sh "$tmp/modules" "$REPO") \
    && [ "$kernels" = "6.1.115-vendor-rk35xx
6.1.116-vendor-rk35xx" ]; then
    ok "kernel releases come from the target rootfs without uname"
else
    bad "kernel discovery used the host or missed a target-root release"
    printf '%s\n' "$kernels" | sed 's/^/      /'
fi

mkdir -p "$tmp/modules/6.1.117-vendor-rk35xx"
if /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w
    YONDER_SEEKER_MODULES_DIR=$1
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"
    seekerhd_require_kernel_headers >/dev/null
' sh "$tmp/modules" "$REPO" >"$out" 2>&1; then
    bad "a target-root kernel without matching headers was accepted"
elif grep -q '6.1.117-vendor-rk35xx has no matching build headers' "$out"; then
    ok "a target-root kernel without matching headers fails before DKMS"
else
    bad "missing target-root headers failed without identifying the kernel"
fi
rm -rf "$tmp/modules/6.1.117-vendor-rk35xx"

if /bin/sh -c '
    set -eu
    DRY_RUN=0
    . "$1/installer/lib/common.sh"; . "$1/installer/lib/seekerhd.sh"
    seekerhd_validate_module_version "$1/scripts/spikes/seekerhd/imx462_yonder.c" \
        "$1/scripts/spikes/seekerhd/imx462_hdr2.h"
' sh "$REPO"; then
    ok "the DKMS version fingerprints both module source inputs"
else
    bad "the DKMS version is stale against its module source inputs"
fi

# A prior run can be interrupted after dkms build but before dkms install.
# Debian rejects another build of that kernel, so a retry must resume at the
# install transition and an installed kernel must remain a no-op.
dkms_fake="$tmp/dkms-bin"
mkdir -p "$dkms_fake"
cat >"$dkms_fake/dkms" <<'EOF'
#!/bin/sh
set -eu
command=$1
state=$(cat "$YONDER_TEST_DKMS_STATE")
case "$command" in
    status)
        case "$state" in
            absent) ;;
            added) printf '%s\n' 'imx462-yonder/1.0.0: added' ;;
            built) printf '%s\n' 'imx462-yonder/1.0.0, 6.1.115-vendor-rk35xx, aarch64: built' ;;
            installed) printf '%s\n' 'imx462-yonder/1.0.0, 6.1.115-vendor-rk35xx, aarch64: installed' ;;
        esac
        ;;
    build)
        printf '%s\n' build >>"$YONDER_TEST_DKMS_CALLS"
        [ "$state" != built ] || exit 75
        printf '%s\n' built >"$YONDER_TEST_DKMS_STATE"
        ;;
    install)
        printf '%s\n' install >>"$YONDER_TEST_DKMS_CALLS"
        printf '%s\n' installed >"$YONDER_TEST_DKMS_STATE"
        ;;
    *) exit 64 ;;
esac
EOF
chmod +x "$dkms_fake/dkms"
dkms_state="$tmp/dkms-state"
dkms_calls="$tmp/dkms-calls"
if PATH="$dkms_fake:$PATH" YONDER_TEST_DKMS_STATE="$dkms_state" \
        YONDER_TEST_DKMS_CALLS="$dkms_calls" /bin/sh -c '
    set -eu
    DRY_RUN=0
    . "$1/installer/lib/common.sh"; . "$1/installer/lib/seekerhd.sh"

    for initial in absent added; do
        : >"$YONDER_TEST_DKMS_CALLS"
        printf "%s\n" "$initial" >"$YONDER_TEST_DKMS_STATE"
        seekerhd_install_dkms_kernel 6.1.115-vendor-rk35xx
        [ "$(cat "$YONDER_TEST_DKMS_CALLS")" = "build
install" ]
    done

    : >"$YONDER_TEST_DKMS_CALLS"
    printf "%s\n" built >"$YONDER_TEST_DKMS_STATE"
    seekerhd_install_dkms_kernel 6.1.115-vendor-rk35xx
    seekerhd_install_dkms_kernel 6.1.115-vendor-rk35xx
    [ "$(cat "$YONDER_TEST_DKMS_CALLS")" = install ]
' sh "$REPO" >"$out" 2>&1; then
    ok "DKMS added, built-interrupted and installed retry states are idempotent"
else
    bad "the DKMS kernel state machine repeated or skipped a required transition"
    sed 's/^/      /' "$out"
fi

# The boot environment mutation preserves existing overlays and adds the
# camera exactly once after the already validated UART overlay.
cat >"$tmp/armbianEnv.txt" <<'EOF'
verbosity=1
user_overlays=dwc3-host uart2-m0
console=display
EOF
/bin/sh -c '
    set -eu
    DRY_RUN=0
    . "$1/installer/lib/common.sh"
    . "$1/installer/lib/seekerhd.sh"
    seekerhd_add_user_overlay "$2" seekerhd-imx462
    seekerhd_add_user_overlay "$2" seekerhd-imx462
' sh "$REPO" "$tmp/armbianEnv.txt" >"$out" 2>&1
if [ "$(sed -n 's/^user_overlays=//p' "$tmp/armbianEnv.txt")" = \
        'dwc3-host uart2-m0 seekerhd-imx462' ]; then
    ok "camera overlay composes after UART without duplicate boot tokens"
else
    bad "camera overlay mutation damaged or duplicated the boot overlay list"
fi

# Post-install verification checks the module for every target-root kernel and
# checks generated profiles rather than trusting that files were copied.
root="$tmp/root"
mkdir -p "$root/lib/modules/6.1.115-vendor-rk35xx/updates/dkms" \
    "$root/lib/modules/6.1.115-vendor-rk35xx/build" \
    "$root/boot/overlay-user" "$root/usr/local/lib/yonder-seekerhd" \
    "$root/usr/local/share/yonder-seekerhd/iqfiles" \
    "$root/usr/local/share/yonder-seekerhd/profiles" \
    "$root/usr/local/bin" "$root/etc/modules-load.d" "$root/boot" \
    "$root/etc/systemd/system/yonder-core.service.d" \
    "$root/etc/systemd/system/multi-user.target.wants" "$root/usr/src/imx462-yonder-1.0.0"
for fixture in \
    "$root/lib/modules/6.1.115-vendor-rk35xx/updates/dkms/imx462_yonder.ko" \
    "$root/boot/overlay-user/seekerhd-imx462.dtbo" \
    "$root/usr/local/lib/yonder-seekerhd/librkaiq.so" \
    "$root/usr/local/lib/yonder-seekerhd/rkaiq_3A_server" \
    "$root/usr/local/lib/yonder-seekerhd/prepare.py" \
    "$root/usr/local/bin/yonder-camera-profile" \
    "$root/etc/modules-load.d/yonder-seekerhd.conf" \
    "$root/usr/local/share/yonder-seekerhd/iqfiles/imx462_IMX462_default.json" \
    "$root/usr/local/share/yonder-seekerhd/profiles/normal-light.json" \
    "$root/usr/local/share/yonder-seekerhd/profiles/low-light.json" \
    "$root/usr/local/share/yonder-seekerhd/profiles/legacy-low-light.json" \
    "$root/usr/local/share/yonder-seekerhd/profiles/manifest.json" \
    "$root/usr/local/share/yonder-seekerhd/SOURCES" \
    "$root/etc/systemd/system/yonder-seekerhd.service" \
    "$root/etc/systemd/system/yonder-seekerhd-aiq.service" \
    "$root/etc/systemd/system/yonder-core.service.d/20-seekerhd.conf" \
    "$root/usr/src/imx462-yonder-1.0.0/dkms.conf" \
    "$root/usr/src/imx462-yonder-1.0.0/Makefile" \
    "$root/usr/src/imx462-yonder-1.0.0/imx462_yonder.c" \
    "$root/usr/src/imx462-yonder-1.0.0/imx462_hdr2.h"; do
    printf '%s\n' fixture >"$fixture"
done
printf '%s\n' 'mode linear' >"$root/usr/local/share/yonder-seekerhd/SOURCES"
printf '%s\n' imx462_yonder >"$root/etc/modules-load.d/yonder-seekerhd.conf"
printf '%s\n' 'user_overlays=uart2-m0 seekerhd-imx462' >"$root/boot/armbianEnv.txt"
printf '%s\n' normal >"$root/usr/local/share/yonder-seekerhd/profiles/normal-light.json"
printf '%s\n' low >"$root/usr/local/share/yonder-seekerhd/profiles/low-light.json"
printf '%s\n' legacy >"$root/usr/local/share/yonder-seekerhd/profiles/legacy-low-light.json"
cp "$root/usr/local/share/yonder-seekerhd/profiles/normal-light.json" \
    "$root/usr/local/share/yonder-seekerhd/iqfiles/imx462_IMX462_default.json"
YONDER_TEST_SHARE="$root/usr/local/share/yonder-seekerhd" python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path
root = Path(os.environ['YONDER_TEST_SHARE'])
profiles = {}
for name in ('normal-light', 'low-light', 'legacy-low-light'):
    profiles[name] = {'sha256': hashlib.sha256((root / 'profiles' / f'{name}.json').read_bytes()).hexdigest()}
(root / 'profiles/manifest.json').write_text(json.dumps({'profiles': profiles}) + '\n')
PY
ln -s ../yonder-seekerhd.service \
    "$root/etc/systemd/system/multi-user.target.wants/yonder-seekerhd.service"
ln -s ../yonder-seekerhd-aiq.service \
    "$root/etc/systemd/system/multi-user.target.wants/yonder-seekerhd-aiq.service"
cat >"$root/etc/systemd/system/yonder-seekerhd.service" <<'EOF'
[Unit]
ConditionPathExistsGlob=/sys/bus/i2c/drivers/imx462/*-001a
EOF
cat >"$root/etc/systemd/system/yonder-seekerhd-aiq.service" <<'EOF'
[Unit]
ConditionPathExistsGlob=/sys/bus/i2c/drivers/imx462/*-001a
EOF
cat >"$root/etc/systemd/system/yonder-core.service.d/20-seekerhd.conf" <<'EOF'
[Unit]
Wants=yonder-seekerhd-aiq.service
After=yonder-seekerhd-aiq.service
EOF
if /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w
    YONDER_SEEKER_ROOT=$1
    YONDER_SEEKER_MODULES_DIR=$1/lib/modules
    YONDER_SEEKER_BOOT_OVERLAY_DIR=$1/boot/overlay-user
    YONDER_SEEKER_LIB_DIR=$1/usr/local/lib/yonder-seekerhd
    YONDER_SEEKER_SHARE_DIR=$1/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_UNIT_DIR=$1/etc/systemd/system
    YONDER_SEEKER_DKMS_SOURCE_DIR=$1/usr/src/imx462-yonder-1.0.0
    YONDER_SEEKER_ARMBIAN_ENV=$1/boot/armbianEnv.txt
    YONDER_SEEKER_MODULES_LOAD_CONF=$1/etc/modules-load.d/yonder-seekerhd.conf
    YONDER_SEEKER_PROFILE_BIN=$1/usr/local/bin/yonder-camera-profile
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/seekerhd.sh"
    seekerhd_verify_install
' sh "$root" "$REPO" >"$out" 2>&1; then
    ok "post-install verifier covers target kernels, camera assets, profiles and units"
else
    bad "a complete staged camera stack failed post-install verification"
    sed 's/^/      /' "$out"
fi
rm -f "$root/lib/modules/6.1.115-vendor-rk35xx/updates/dkms/imx462_yonder.ko"
if /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w
    YONDER_SEEKER_ROOT=$1 YONDER_SEEKER_MODULES_DIR=$1/lib/modules
    YONDER_SEEKER_BOOT_OVERLAY_DIR=$1/boot/overlay-user
    YONDER_SEEKER_LIB_DIR=$1/usr/local/lib/yonder-seekerhd
    YONDER_SEEKER_SHARE_DIR=$1/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_UNIT_DIR=$1/etc/systemd/system
    YONDER_SEEKER_DKMS_SOURCE_DIR=$1/usr/src/imx462-yonder-1.0.0
    YONDER_SEEKER_ARMBIAN_ENV=$1/boot/armbianEnv.txt
    YONDER_SEEKER_MODULES_LOAD_CONF=$1/etc/modules-load.d/yonder-seekerhd.conf
    YONDER_SEEKER_PROFILE_BIN=$1/usr/local/bin/yonder-camera-profile
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"
    seekerhd_verify_install
' sh "$root" "$REPO" >"$out" 2>&1; then
    bad "post-install verification accepted a missing kernel module"
else
    ok "post-install verification rejects a kernel without the camera module"
fi

if [ "$failures" -ne 0 ]; then
    printf '%s\n' "$failures SeekerHD installer checks failed" >&2
    exit 1
fi
printf '%s\n' 'all SeekerHD installer checks passed'
