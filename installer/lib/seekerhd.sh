# SPDX-License-Identifier: GPL-3.0-or-later
# ZERO 3W SeekerHD install and verification helpers. Sourced, never executed.
# shellcheck shell=sh

: "${YONDER_SEEKER_VERSION:=1.0.0+60b0f170be23}"
: "${YONDER_SEEKER_ROOT:=}"
: "${YONDER_SEEKER_MODULES_DIR:=${YONDER_SEEKER_ROOT}/lib/modules}"
: "${YONDER_SEEKER_DKMS_SOURCE_DIR:=${YONDER_SEEKER_ROOT}/usr/src/imx462-yonder-$YONDER_SEEKER_VERSION}"
: "${YONDER_SEEKER_BOOT_OVERLAY_DIR:=${YONDER_SEEKER_ROOT}/boot/overlay-user}"
: "${YONDER_SEEKER_LIB_DIR:=${YONDER_SEEKER_ROOT}/usr/local/lib/yonder-seekerhd}"
: "${YONDER_SEEKER_SHARE_DIR:=${YONDER_SEEKER_ROOT}/usr/local/share/yonder-seekerhd}"
: "${YONDER_SEEKER_UNIT_DIR:=${YONDER_SEEKER_ROOT}/etc/systemd/system}"
: "${YONDER_SEEKER_PROC_COMPATIBLE:=${YONDER_SEEKER_ROOT}/proc/device-tree/compatible}"
: "${YONDER_SEEKER_ARMBIAN_ENV:=${YONDER_SEEKER_ROOT}/boot/armbianEnv.txt}"
: "${YONDER_SEEKER_BOOTARGS:=${YONDER_SEEKER_LIB_DIR}/bootargs.py}"
: "${YONDER_SEEKER_MODULES_LOAD_CONF:=${YONDER_SEEKER_ROOT}/etc/modules-load.d/yonder-seekerhd.conf}"
: "${YONDER_SEEKER_PROFILE_BIN:=${YONDER_SEEKER_ROOT}/usr/local/bin/yonder-camera-profile}"

seekerhd_target_selected() {
    if [ "${IMAGE_MODE:-0}" = "1" ]; then
        [ "${YONDER_TARGET:-}" = "radxa-zero3w" ]
        return
    fi
    [ -f "$YONDER_SEEKER_PROC_COMPATIBLE" ] || return 1
    tr '\000' '\n' <"$YONDER_SEEKER_PROC_COMPATIBLE" \
        | grep -Eq '^radxa,zero3($|-)'
}

# Enumerate kernels from the installed root. uname reports the build host in
# an image chroot, which is not a kernel this module can ever run under.
seekerhd_kernel_releases() {
    for sk_dir in "$YONDER_SEEKER_MODULES_DIR"/*; do
        [ -d "$sk_dir" ] || continue
        sk_release=$(basename "$sk_dir")
        case "$sk_release" in
            *-vendor-rk35xx) printf '%s\n' "$sk_release" ;;
        esac
    done | LC_ALL=C sort
}

seekerhd_require_kernel_headers() {
    srkh_kernels=$(seekerhd_kernel_releases)
    [ -n "$srkh_kernels" ] || die "the target root contains no vendor-rk35xx kernel modules"
    for srkh_kernel in $srkh_kernels; do
        [ -e "$YONDER_SEEKER_MODULES_DIR/$srkh_kernel/build" ] \
            || die "kernel $srkh_kernel has no matching build headers; refusing a camera image whose next boot could not load its sensor driver"
    done
    printf '%s\n' "$srkh_kernels"
}

seekerhd_require_notifier_blacklist_support() {
    snbs_kernels=$(seekerhd_kernel_releases)
    [ -n "$snbs_kernels" ] || die "the target root contains no vendor-rk35xx kernel modules"
    for snbs_kernel in $snbs_kernels; do
        snbs_config="$YONDER_SEEKER_ROOT/boot/config-$snbs_kernel"
        snbs_map="$YONDER_SEEKER_ROOT/boot/System.map-$snbs_kernel"
        [ -r "$snbs_config" ] \
            || die "kernel $snbs_kernel has no installed boot config at $snbs_config; cannot verify initcall_blacklist support"
        grep -qxF 'CONFIG_KALLSYMS=y' "$snbs_config" \
            || die "kernel $snbs_kernel lacks CONFIG_KALLSYMS=y; initcall_blacklist=rkisp_clr_unready_dev is unsupported"
        [ -r "$snbs_map" ] \
            || die "kernel $snbs_kernel has no installed System.map at $snbs_map; cannot verify the RKISP callback"
        grep -Eq '[[:space:]]rkisp_clr_unready_dev$' "$snbs_map" \
            || die "kernel $snbs_kernel System.map does not contain rkisp_clr_unready_dev; refusing an unsupported SeekerHD boot correction"
    done
}

seekerhd_validate_module_version() {
    svm_source="$1"
    svm_header="$2"
    svm_hash=$({
        sha256sum "$svm_source" | awk '{print $1}'
        sha256sum "$svm_header" | awk '{print $1}'
    } | sha256sum | awk '{print $1}')
    svm_short=$(printf '%s' "$svm_hash" | cut -c1-12)
    case "$YONDER_SEEKER_VERSION" in
        *"+$svm_short") ;;
        *) die "SeekerHD DKMS version $YONDER_SEEKER_VERSION does not identify the current module inputs ($svm_short); bump it before installing" ;;
    esac
}

seekerhd_dkms_kernel_state() {
    sdks_kernel="$1"
    sdks_output=$(dkms status -m imx462-yonder -v "$YONDER_SEEKER_VERSION" \
        -k "$sdks_kernel" 2>/dev/null) || sdks_output=""
    if printf '%s\n' "$sdks_output" | grep -q ': installed$'; then
        printf '%s\n' installed
    elif printf '%s\n' "$sdks_output" | grep -q ': built$'; then
        printf '%s\n' built
    else
        printf '%s\n' added
    fi
}

seekerhd_install_dkms_kernel() {
    sidk_kernel="$1"
    if [ "$DRY_RUN" = "1" ]; then
        sidk_state=added
    else
        sidk_state=$(seekerhd_dkms_kernel_state "$sidk_kernel")
    fi
    case "$sidk_state" in
        installed)
            log "imx462-yonder is already installed for $sidk_kernel"
            ;;
        built)
            # Resume an installer interrupted between build and install.
            run dkms install -m imx462-yonder -v "$YONDER_SEEKER_VERSION" \
                -k "$sidk_kernel"
            ;;
        added)
            run dkms build -m imx462-yonder -v "$YONDER_SEEKER_VERSION" \
                -k "$sidk_kernel"
            run dkms install -m imx462-yonder -v "$YONDER_SEEKER_VERSION" \
                -k "$sidk_kernel"
            ;;
        *) die "unrecognized DKMS state $sidk_state for $sidk_kernel" ;;
    esac
}

seekerhd_names_user_overlay() {
    # shellcheck disable=SC2020 # space and tab both mapped to newline
    sed -n 's/^user_overlays=//p' "$1" | tr ' \t' '\n\n' | grep -qxF "$2"
}

seekerhd_add_user_overlay() {
    sao_env="$1"
    sao_token="$2"
    if seekerhd_names_user_overlay "$sao_env" "$sao_token"; then
        log "$sao_env already carries $sao_token in user_overlays"
        return 0
    fi
    if ! awk -v tok="$sao_token" '
        BEGIN { done = 0 }
        /^user_overlays=/ {
            rest = substr($0, 15)
            $0 = (rest == "" ? "user_overlays=" tok : "user_overlays=" rest " " tok)
            done = 1
        }
        { print }
        END { if (!done) print "user_overlays=" tok }
    ' "$sao_env" >"$sao_env.new"; then
        rm -f "$sao_env.new"
        return 1
    fi
    if ! mv "$sao_env.new" "$sao_env"; then
        rm -f "$sao_env.new"
        return 1
    fi
}

seekerhd_payload_dir() {
    printf '%s\n' "$YONDER_SRC/vendor/seekerhd"
}

seekerhd_validate_payload() {
    svp_dir=$(seekerhd_payload_dir)
    for svp_file in \
        "$svp_dir/bin/rkaiq_3A_server" \
        "$svp_dir/lib/librkaiq.so" \
        "$svp_dir/iqfiles/imx462_IMX462_default.json" \
        "$svp_dir/profiles/normal-light.json" \
        "$svp_dir/profiles/low-light.json" \
        "$svp_dir/profiles/legacy-low-light.json" \
        "$svp_dir/profiles/manifest.json" \
        "$svp_dir/SHA256SUMS" "$svp_dir/SOURCES"; do
        [ -s "$svp_file" ] \
            || die "SeekerHD payload is incomplete: missing or empty $svp_file; run installer/make-payload.sh --arch linux-arm64 --only seekerhd"
    done
    [ -x "$svp_dir/bin/rkaiq_3A_server" ] \
        || die "SeekerHD payload is incomplete: $svp_dir/bin/rkaiq_3A_server is not executable"
    svp_want=$(elf_machine "$YONDER_ELF_REFERENCE")
    for svp_elf in "$svp_dir/bin/rkaiq_3A_server" "$svp_dir/lib/librkaiq.so"; do
        svp_have=$(elf_machine "$svp_elf")
        [ -n "$svp_have" ] && [ "$svp_have" = "$svp_want" ] \
            || die "SeekerHD payload architecture mismatch: $svp_elf does not match the target root"
    done
    if [ "$DRY_RUN" = "1" ]; then
        log "would verify every SeekerHD payload file against SHA256SUMS"
    else
        (cd "$svp_dir" && sha256sum -c SHA256SUMS) >/dev/null \
            || die "SeekerHD payload checksum verification failed"
    fi
}

seekerhd_validate_overlay_stack() {
    svos_base="$1"
    svos_uart="$2"
    svos_camera="$3"
    [ -s "$svos_base" ] && [ -s "$svos_uart" ] && [ -s "$svos_camera" ] \
        || die "cannot validate the ZERO 3W camera overlay: base, UART, or camera DTB is missing"
    svos_compatible=$(fdtget -t s "$svos_base" / compatible 2>/dev/null) \
        || die "cannot read compatible from ZERO 3W base DTB $svos_base"
    case " $svos_compatible " in
        *" radxa,zero3 "*|*" radxa,zero3-"*) ;;
        *) die "$svos_base is not a Radxa Zero 3 device tree" ;;
    esac
    svos_result=$(mktemp "${TMPDIR:-/tmp}/yonder-seekerhd-tree.XXXXXX.dtb") \
        || die "could not allocate a temporary composed camera tree"
    if ! fdtoverlay -i "$svos_base" -o "$svos_result" "$svos_uart" "$svos_camera"; then
        rm -f "$svos_result"
        die "the SeekerHD overlay does not compose with the ZERO 3W base and UART overlay"
    fi
    rm -f "$svos_result"
    log "validated the SeekerHD overlay with the ZERO 3W base tree and UART overlay"
}

seekerhd_verify_install() {
    svi_kernels=$(seekerhd_require_kernel_headers)
    seekerhd_require_notifier_blacklist_support
    python3 "$YONDER_SEEKER_BOOTARGS" --check "$YONDER_SEEKER_ARMBIAN_ENV" \
        || die "$YONDER_SEEKER_ARMBIAN_ENV does not preserve the RKISP notifier correction"
    for svi_kernel in $svi_kernels; do
        svi_module=$(find "$YONDER_SEEKER_MODULES_DIR/$svi_kernel" -type f \
            -name 'imx462_yonder.ko*' -print -quit 2>/dev/null || true)
        [ -n "$svi_module" ] && [ -s "$svi_module" ] \
            || die "kernel $svi_kernel has no installed imx462_yonder module"
        if [ -z "$YONDER_SEEKER_ROOT" ]; then
            svi_vermagic=$(modinfo -F vermagic "$svi_module" | awk '{print $1}') \
                || die "cannot inspect the module installed for $svi_kernel"
            [ "$svi_vermagic" = "$svi_kernel" ] \
                || die "$svi_module has vermagic $svi_vermagic, not $svi_kernel"
        fi
    done
    for svi_file in \
        "$YONDER_SEEKER_DKMS_SOURCE_DIR/dkms.conf" \
        "$YONDER_SEEKER_DKMS_SOURCE_DIR/Makefile" \
        "$YONDER_SEEKER_DKMS_SOURCE_DIR/imx462_yonder.c" \
        "$YONDER_SEEKER_DKMS_SOURCE_DIR/imx462_hdr2.h" \
        "$YONDER_SEEKER_BOOT_OVERLAY_DIR/seekerhd-imx462.dtbo" \
        "$YONDER_SEEKER_LIB_DIR/librkaiq.so" \
        "$YONDER_SEEKER_LIB_DIR/rkaiq_3A_server" \
        "$YONDER_SEEKER_BOOTARGS" \
        "$YONDER_SEEKER_LIB_DIR/prepare.py" \
        "$YONDER_SEEKER_PROFILE_BIN" \
        "$YONDER_SEEKER_MODULES_LOAD_CONF" \
        "$YONDER_SEEKER_SHARE_DIR/iqfiles/imx462_IMX462_default.json" \
        "$YONDER_SEEKER_SHARE_DIR/profiles/normal-light.json" \
        "$YONDER_SEEKER_SHARE_DIR/profiles/low-light.json" \
        "$YONDER_SEEKER_SHARE_DIR/profiles/legacy-low-light.json" \
        "$YONDER_SEEKER_SHARE_DIR/profiles/manifest.json" \
        "$YONDER_SEEKER_SHARE_DIR/SOURCES" \
        "$YONDER_SEEKER_UNIT_DIR/yonder-seekerhd.service" \
        "$YONDER_SEEKER_UNIT_DIR/yonder-seekerhd-aiq.service" \
        "$YONDER_SEEKER_UNIT_DIR/yonder-core.service.d/20-seekerhd.conf"; do
        [ -s "$svi_file" ] || die "installed SeekerHD stack is missing $svi_file"
    done
    grep -qxF imx462_yonder "$YONDER_SEEKER_MODULES_LOAD_CONF" \
        || die "$YONDER_SEEKER_MODULES_LOAD_CONF does not request the sensor module at boot"
    seekerhd_names_user_overlay "$YONDER_SEEKER_ARMBIAN_ENV" seekerhd-imx462 \
        || die "$YONDER_SEEKER_ARMBIAN_ENV does not enable the SeekerHD overlay"
    for svi_unit in yonder-seekerhd.service yonder-seekerhd-aiq.service; do
        svi_link=$(find "$YONDER_SEEKER_UNIT_DIR" -path "*.wants/$svi_unit" \
            -type l -print -quit 2>/dev/null || true)
        [ -n "$svi_link" ] && [ -e "$svi_link" ] \
            || die "$svi_unit is not enabled with a link to an installed unit"
    done
    for svi_unit in "$YONDER_SEEKER_UNIT_DIR/yonder-seekerhd.service" \
            "$YONDER_SEEKER_UNIT_DIR/yonder-seekerhd-aiq.service"; do
        grep -qxF 'ConditionPathExistsGlob=/sys/bus/i2c/drivers/imx462/*-001a' "$svi_unit" \
            || die "$svi_unit could touch the camera graph when no IMX462 is bound"
    done
    svi_core_dropin="$YONDER_SEEKER_UNIT_DIR/yonder-core.service.d/20-seekerhd.conf"
    grep -qxF 'Wants=yonder-seekerhd-aiq.service' "$svi_core_dropin" \
        || die "$svi_core_dropin does not start the optional ISP preparation"
    ! grep -q '^Requires=.*yonder-seekerhd' "$svi_core_dropin" \
        || die "$svi_core_dropin makes camera success a requirement for core startup"
    grep -qxF 'mode linear' "$YONDER_SEEKER_SHARE_DIR/SOURCES" \
        || die "the installed SeekerHD runtime does not record the normal linear mode"
    # The manifest is the generator's independently recorded content map.
    # Verify all named profiles, then ensure a newly built image begins in
    # the normal linear profile. Live reinstalls preserve an operator's
    # current profile and therefore intentionally skip the final comparison.
    YONDER_SEEKER_VERIFY_SHARE="$YONDER_SEEKER_SHARE_DIR" \
        YONDER_SEEKER_VERIFY_IMAGE="$IMAGE_MODE" python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ['YONDER_SEEKER_VERIFY_SHARE'])
manifest = json.loads((root / 'profiles/manifest.json').read_text())
for name in ('normal-light', 'low-light', 'legacy-low-light'):
    data = (root / 'profiles' / f'{name}.json').read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    expected = manifest['profiles'][name]['sha256']
    if actual != expected:
        raise SystemExit(f'{name} profile is {actual}, expected {expected}')
if os.environ['YONDER_SEEKER_VERIFY_IMAGE'] == '1':
    active = (root / 'iqfiles/imx462_IMX462_default.json').read_bytes()
    normal = (root / 'profiles/normal-light.json').read_bytes()
    if active != normal:
        raise SystemExit('new image does not start with the normal-light profile')
PY
    if [ -z "$YONDER_SEEKER_ROOT" ]; then
        svi_want=$(elf_machine "$YONDER_ELF_REFERENCE")
        for svi_elf in "$YONDER_SEEKER_LIB_DIR/librkaiq.so" \
                "$YONDER_SEEKER_LIB_DIR/rkaiq_3A_server"; do
            [ "$(elf_machine "$svi_elf")" = "$svi_want" ] \
                || die "$svi_elf does not match the installed root architecture"
            svi_ldd=$(LD_LIBRARY_PATH="$YONDER_SEEKER_LIB_DIR" ldd "$svi_elf") \
                || die "cannot resolve runtime dependencies for $svi_elf"
            ! printf '%s\n' "$svi_ldd" | grep -q 'not found' \
                || die "$svi_elf has an unresolved runtime dependency"
        done
    fi
    log "verified the installed SeekerHD stack for: $(printf '%s' "$svi_kernels" | tr '\n' ' ')"
}
