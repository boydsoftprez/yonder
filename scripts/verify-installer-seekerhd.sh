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

if python3 -m unittest "$REPO/installer/seekerhd/test_bootargs.py" >"$out" 2>&1; then
    ok "boot arguments preserve and verify the RKISP notifier correction"
else
    bad "boot argument correction contract failed"
    sed 's/^/      /' "$out"
fi

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

# The protected image keeps /usr read-only and projects /var/lib/yonder from
# durable state before AIQ starts.  Its installed absolute IQ path must follow
# that state directory without losing either a new-image seed or an operator's
# already-selected profile on a later install.
iq_fresh="$tmp/iq-fresh"
mkdir -p "$iq_fresh/usr/local/share/yonder-seekerhd"
printf '%s\n' factory >"$iq_fresh/seed.json"
if /bin/sh -c '
    set -eu
    DRY_RUN=0
    YONDER_SEEKER_ROOT=$1
    YONDER_SEEKER_SHARE_DIR=$1/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_STATE_DIR=$1/var/lib/yonder/seekerhd
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"
    seekerhd_provision_active_iq "$1/seed.json" 1
    [ "$(readlink "$YONDER_SEEKER_SHARE_DIR/iqfiles")" = /var/lib/yonder/seekerhd/iqfiles ]
    cmp "$YONDER_SEEKER_SHARE_DIR/iqfiles.factory/imx462_IMX462_default.json" \
        "$YONDER_SEEKER_STATE_DIR/iqfiles/imx462_IMX462_default.json"
    mkdir -p "$1/state"
    cp -a "$1/var/lib/yonder" "$1/state/app"
    cmp "$YONDER_SEEKER_STATE_DIR/iqfiles/imx462_IMX462_default.json" \
        "$1/state/app/seekerhd/iqfiles/imx462_IMX462_default.json"
    seekerhd_provision_active_iq "$1/seed.json" 1
' sh "$iq_fresh" "$REPO" >"$out" 2>&1; then
    ok "new image active IQ bytes seed the state-app copy through an idempotent absolute symlink"
else
    bad "new image active IQ bytes did not seed durable state safely"
    sed 's/^/      /' "$out"
fi

iq_preserved="$tmp/iq-preserved"
mkdir -p "$iq_preserved/usr/local/share/yonder-seekerhd/iqfiles" \
    "$iq_preserved/var/lib/yonder/seekerhd/iqfiles"
printf '%s\n' factory >"$iq_preserved/usr/local/share/yonder-seekerhd/iqfiles/imx462_IMX462_default.json"
printf '%s\n' operator >"$iq_preserved/var/lib/yonder/seekerhd/iqfiles/imx462_IMX462_default.json"
printf '%s\n' seed >"$iq_preserved/seed.json"
if /bin/sh -c '
    set -eu
    DRY_RUN=0
    YONDER_SEEKER_ROOT=$1
    YONDER_SEEKER_SHARE_DIR=$1/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_STATE_DIR=$1/var/lib/yonder/seekerhd
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"
    seekerhd_provision_active_iq "$1/seed.json" 0
    [ "$(cat "$YONDER_SEEKER_STATE_DIR/iqfiles/imx462_IMX462_default.json")" = operator ]
    [ "$(cat "$YONDER_SEEKER_SHARE_DIR/iqfiles.factory/imx462_IMX462_default.json")" = factory ]
' sh "$iq_preserved" "$REPO" >"$out" 2>&1; then
    ok "existing durable active IQ bytes survive a later installer run"
else
    bad "installer replaced an existing durable active IQ file"
    sed 's/^/      /' "$out"
fi

iq_conflict="$tmp/iq-conflict"
mkdir -p "$iq_conflict/usr/local/share/yonder-seekerhd/iqfiles" \
    "$iq_conflict/usr/local/share/yonder-seekerhd/iqfiles.factory"
printf '%s\n' live >"$iq_conflict/usr/local/share/yonder-seekerhd/iqfiles/imx462_IMX462_default.json"
printf '%s\n' backup >"$iq_conflict/usr/local/share/yonder-seekerhd/iqfiles.factory/imx462_IMX462_default.json"
printf '%s\n' seed >"$iq_conflict/seed.json"
if /bin/sh -c '
    set -eu
    DRY_RUN=0
    YONDER_SEEKER_ROOT=$1
    YONDER_SEEKER_SHARE_DIR=$1/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_STATE_DIR=$1/var/lib/yonder/seekerhd
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"
    seekerhd_provision_active_iq "$1/seed.json" 1
' sh "$iq_conflict" "$REPO" >"$out" 2>&1; then
    bad "IQ migration accepted conflicting live and factory directories"
else
    if [ "$(cat "$iq_conflict/usr/local/share/yonder-seekerhd/iqfiles/imx462_IMX462_default.json")" = live ] \
            && [ "$(cat "$iq_conflict/usr/local/share/yonder-seekerhd/iqfiles.factory/imx462_IMX462_default.json")" = backup ]; then
        ok "IQ migration rejects conflicting paths without replacing either input"
    else
        bad "IQ migration damaged a conflicting-path fixture"
    fi
fi

iq_order="$tmp/iq-order"
mkdir -p "$iq_order/wrong/usr/local/share/yonder-seekerhd" \
    "$iq_order/wrong/var/lib/yonder/seekerhd/iqfiles" \
    "$iq_order/dangling/usr/local/share/yonder-seekerhd" \
    "$iq_order/resume/usr/local/share/yonder-seekerhd/iqfiles.factory" \
    "$iq_order/resume/var/lib/yonder/seekerhd/iqfiles"
printf '%s\n' seed >"$iq_order/seed.json"
printf '%s\n' operator >"$iq_order/wrong/var/lib/yonder/seekerhd/iqfiles/imx462_IMX462_default.json"
ln -s /unexpected/iqfiles "$iq_order/wrong/usr/local/share/yonder-seekerhd/iqfiles"
ln -s /var/lib/yonder/seekerhd/iqfiles "$iq_order/dangling/usr/local/share/yonder-seekerhd/iqfiles"
printf '%s\n' factory >"$iq_order/resume/usr/local/share/yonder-seekerhd/iqfiles.factory/imx462_IMX462_default.json"
printf '%s\n' operator >"$iq_order/resume/var/lib/yonder/seekerhd/iqfiles/imx462_IMX462_default.json"
if /bin/sh -c '
    set -eu
    DRY_RUN=0
    . "$3/installer/lib/common.sh"; . "$3/installer/lib/seekerhd.sh"
    for name in wrong dangling; do
        YONDER_SEEKER_ROOT=$1/$name
        YONDER_SEEKER_SHARE_DIR=$YONDER_SEEKER_ROOT/usr/local/share/yonder-seekerhd
        YONDER_SEEKER_STATE_DIR=$YONDER_SEEKER_ROOT/var/lib/yonder/seekerhd
        export YONDER_SEEKER_ROOT YONDER_SEEKER_SHARE_DIR YONDER_SEEKER_STATE_DIR
        if ( seekerhd_provision_active_iq "$2/seed.json" 1 ); then exit 1; fi
    done
    [ "$(cat "$1/wrong/var/lib/yonder/seekerhd/iqfiles/imx462_IMX462_default.json")" = operator ]
    [ ! -e "$1/dangling/var/lib/yonder/seekerhd/iqfiles/imx462_IMX462_default.json" ]
    YONDER_SEEKER_ROOT=$1/resume
    YONDER_SEEKER_SHARE_DIR=$YONDER_SEEKER_ROOT/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_STATE_DIR=$YONDER_SEEKER_ROOT/var/lib/yonder/seekerhd
    export YONDER_SEEKER_ROOT YONDER_SEEKER_SHARE_DIR YONDER_SEEKER_STATE_DIR
    seekerhd_provision_active_iq "$2/seed.json" 1
    [ "$(readlink "$YONDER_SEEKER_SHARE_DIR/iqfiles")" = /var/lib/yonder/seekerhd/iqfiles ]
    [ "$(cat "$YONDER_SEEKER_STATE_DIR/iqfiles/imx462_IMX462_default.json")" = operator ]
    [ "$(cat "$YONDER_SEEKER_SHARE_DIR/iqfiles.factory/imx462_IMX462_default.json")" = factory ]
' sh "$iq_order" "$iq_order" "$REPO" >"$out" 2>&1; then
    ok "role provisioning validates wrong or dangling links before seeding and resumes only the recognised migration"
else
    bad "role provisioning wrote through an invalid link or failed the recognised migration resume"
    sed 's/^/      /' "$out"
fi

iq_dry="$tmp/iq-dry"
mkdir -p "$iq_dry/usr/local/share/yonder-seekerhd"
printf '%s\n' seed >"$iq_dry/seed.json"
if /bin/sh -c '
    set -eu
    DRY_RUN=1
    YONDER_SEEKER_ROOT=$1
    YONDER_SEEKER_SHARE_DIR=$1/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_STATE_DIR=$1/var/lib/yonder/seekerhd
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"
    seekerhd_provision_active_iq "$1/seed.json" 1
    [ ! -e "$YONDER_SEEKER_SHARE_DIR/iqfiles" ]
' sh "$iq_dry" "$REPO" >"$out" 2>&1; then
    ok "dry-run reports durable IQ provisioning without requiring a staged directory"
else
    bad "dry-run durable IQ provisioning attempted or required a filesystem write"
    sed 's/^/      /' "$out"
fi

# Post-install verification checks the module for every target-root kernel and
# checks generated profiles rather than trusting that files were copied.
root="$tmp/root"
mkdir -p "$root/lib/modules/6.1.115-vendor-rk35xx/updates/dkms" \
    "$root/lib/modules/6.1.115-vendor-rk35xx/build" \
    "$root/boot/overlay-user" "$root/usr/local/lib/yonder-seekerhd" \
    "$root/usr/local/share/yonder-seekerhd/iqfiles" \
    "$root/usr/local/share/yonder-seekerhd/profiles" \
    "$root/var/lib/yonder/seekerhd" \
    "$root/usr/local/bin" "$root/etc/modules-load.d" "$root/boot" \
    "$root/etc/systemd/system/yonder-core.service.d" \
    "$root/etc/systemd/system/multi-user.target.wants" "$root/usr/src/imx462-yonder-1.0.0"
for fixture in \
    "$root/lib/modules/6.1.115-vendor-rk35xx/updates/dkms/imx462_yonder.ko" \
    "$root/boot/overlay-user/seekerhd-imx462.dtbo" \
    "$root/usr/local/lib/yonder-seekerhd/librkaiq.so" \
    "$root/usr/local/lib/yonder-seekerhd/rkaiq_3A_server" \
    "$root/usr/local/lib/yonder-seekerhd/bootargs.py" \
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
cp "$REPO/installer/seekerhd/bootargs.py" "$root/usr/local/lib/yonder-seekerhd/bootargs.py"
chmod 0755 "$root/usr/local/lib/yonder-seekerhd/bootargs.py"
printf '%s\n' 'mode linear' >"$root/usr/local/share/yonder-seekerhd/SOURCES"
printf '%s\n' imx462_yonder >"$root/etc/modules-load.d/yonder-seekerhd.conf"
printf '%s\n' 'user_overlays=uart2-m0 seekerhd-imx462' \
    'extraargs=initcall_blacklist=rkisp_clr_unready_dev' >"$root/boot/armbianEnv.txt"
printf '%s\n' 'CONFIG_KALLSYMS=y' >"$root/boot/config-6.1.115-vendor-rk35xx"
printf '%s\n' 'ffff000000000000 t rkisp_clr_unready_dev' \
    >"$root/boot/System.map-6.1.115-vendor-rk35xx"
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
    YONDER_SEEKER_TEST_UID=$(id -u)
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/seekerhd.sh"
    seekerhd_provision_active_iq "$1/usr/local/share/yonder-seekerhd/iqfiles/imx462_IMX462_default.json" 0
    seekerhd_verify_install
' sh "$root" "$REPO" >"$out" 2>&1; then
    ok "post-install verifier covers target kernels, camera assets, profiles and units"
else
    bad "a complete staged camera stack failed post-install verification"
    sed 's/^/      /' "$out"
fi

printf '%s\n' 'ffff000000000000 t unrelated_initcall' \
    >"$root/boot/System.map-6.1.115-vendor-rk35xx"
if /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w
    YONDER_SEEKER_ROOT=$1
    YONDER_SEEKER_MODULES_DIR=$1/lib/modules
    . "$2/installer/lib/common.sh"
    . "$2/installer/lib/seekerhd.sh"
    seekerhd_require_notifier_blacklist_support
' sh "$root" "$REPO" >"$out" 2>&1; then
    bad "an unsupported kernel without the RKISP callback was accepted"
elif grep -q 'System.map does not contain rkisp_clr_unready_dev' "$out"; then
    ok "kernel verification rejects a target without the RKISP initcall callback"
else
    bad "missing RKISP callback failed without identifying the unsupported kernel"
    sed 's/^/      /' "$out"
fi
printf '%s\n' 'ffff000000000000 t rkisp_clr_unready_dev' \
    >"$root/boot/System.map-6.1.115-vendor-rk35xx"
trusted_active="$root/var/lib/yonder/seekerhd/iqfiles/imx462_IMX462_default.json"
mv "$trusted_active" "$trusted_active.saved"
ln -s imx462_IMX462_default.json.saved "$trusted_active"
if /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w YONDER_SEEKER_ROOT=$1
    YONDER_SEEKER_MODULES_DIR=$1/lib/modules YONDER_SEEKER_BOOT_OVERLAY_DIR=$1/boot/overlay-user
    YONDER_SEEKER_LIB_DIR=$1/usr/local/lib/yonder-seekerhd YONDER_SEEKER_SHARE_DIR=$1/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_STATE_DIR=$1/var/lib/yonder/seekerhd YONDER_SEEKER_UNIT_DIR=$1/etc/systemd/system
    YONDER_SEEKER_DKMS_SOURCE_DIR=$1/usr/src/imx462-yonder-1.0.0 YONDER_SEEKER_ARMBIAN_ENV=$1/boot/armbianEnv.txt
    YONDER_SEEKER_MODULES_LOAD_CONF=$1/etc/modules-load.d/yonder-seekerhd.conf YONDER_SEEKER_PROFILE_BIN=$1/usr/local/bin/yonder-camera-profile
    YONDER_SEEKER_TEST_UID=$(id -u)
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"; seekerhd_verify_install
' sh "$root" "$REPO" >"$out" 2>&1; then
    bad "post-install verification accepted a symlink active IQ leaf"
else
    ok "post-install verification rejects a symlink active IQ leaf"
fi
rm "$trusted_active"
mv "$trusted_active.saved" "$trusted_active"
chmod 0664 "$trusted_active"
if /bin/sh -c '
    set -eu
    DRY_RUN=0 IMAGE_MODE=1 YONDER_TARGET=radxa-zero3w YONDER_SEEKER_ROOT=$1
    YONDER_SEEKER_MODULES_DIR=$1/lib/modules YONDER_SEEKER_BOOT_OVERLAY_DIR=$1/boot/overlay-user
    YONDER_SEEKER_LIB_DIR=$1/usr/local/lib/yonder-seekerhd YONDER_SEEKER_SHARE_DIR=$1/usr/local/share/yonder-seekerhd
    YONDER_SEEKER_STATE_DIR=$1/var/lib/yonder/seekerhd YONDER_SEEKER_UNIT_DIR=$1/etc/systemd/system
    YONDER_SEEKER_DKMS_SOURCE_DIR=$1/usr/src/imx462-yonder-1.0.0 YONDER_SEEKER_ARMBIAN_ENV=$1/boot/armbianEnv.txt
    YONDER_SEEKER_MODULES_LOAD_CONF=$1/etc/modules-load.d/yonder-seekerhd.conf YONDER_SEEKER_PROFILE_BIN=$1/usr/local/bin/yonder-camera-profile
    YONDER_SEEKER_TEST_UID=$(id -u)
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"; seekerhd_verify_install
' sh "$root" "$REPO" >"$out" 2>&1; then
    bad "post-install verification accepted a group-writable active IQ leaf"
else
    ok "post-install verification rejects a group-writable active IQ leaf"
fi
chmod 0644 "$trusted_active"
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
    YONDER_SEEKER_TEST_UID=$(id -u)
    . "$2/installer/lib/common.sh"; . "$2/installer/lib/seekerhd.sh"
    seekerhd_verify_install
' sh "$root" "$REPO" >"$out" 2>&1; then
    bad "post-install verification accepted a missing kernel module"
elif grep -q 'kernel 6.1.115-vendor-rk35xx has no installed imx462_yonder module' "$out"; then
    ok "post-install verification rejects a kernel without the camera module"
else
    bad "missing camera module failed without identifying the module"
    sed 's/^/      /' "$out"
fi

if [ "$failures" -ne 0 ]; then
    printf '%s\n' "$failures SeekerHD installer checks failed" >&2
    exit 1
fi
printf '%s\n' 'all SeekerHD installer checks passed'
