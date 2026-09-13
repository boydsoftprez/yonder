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
: "${YONDER_SEEKER_STATE_DIR:=${YONDER_SEEKER_ROOT}/var/lib/yonder/seekerhd}"
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

# AIQ loads its initial tuning file through the installed absolute path, but
# live profile changes replace that file atomically.  On protected images the
# share tree is on the read-only system filesystem while /var/lib/yonder is
# projected from durable state before services start.  Keep the immutable
# factory copy beside the symlink so an interrupted maintenance migration has
# a visible recovery input rather than silently reseeding an operator choice.
seekerhd_active_iq_path() {
    printf '%s\n' "$YONDER_SEEKER_SHARE_DIR/iqfiles/imx462_IMX462_default.json"
}

seekerhd_state_iq_dir() {
    printf '%s\n' "$YONDER_SEEKER_STATE_DIR/iqfiles"
}

seekerhd_provision_active_iq() {
    spi_seed=$1
    spi_image_mode=$2
    spi_dir="$YONDER_SEEKER_SHARE_DIR/iqfiles"
    spi_factory="$YONDER_SEEKER_SHARE_DIR/iqfiles.factory"
    spi_active=$(seekerhd_active_iq_path)

    if [ "$DRY_RUN" = 1 ]; then
        log "would validate and provision the durable SeekerHD active IQ path"
        return 0
    fi

    # Inspect links before considering a seed write.  In particular, a
    # dangling or unexpected link must never redirect an image seed into an
    # arbitrary location just because IMAGE_MODE requests the factory profile.
    if [ -L "$spi_dir" ]; then
        seekerhd_migrate_active_iq
        return 0
    fi
    if [ ! -e "$spi_dir" ]; then
        if [ -d "$spi_factory" ] && [ ! -L "$spi_factory" ]; then
            seekerhd_migrate_active_iq
            return 0
        fi
        [ ! -e "$spi_factory" ] \
            || die "SeekerHD IQ factory backup exists without a resumable migration"
        run mkdir "$spi_dir"
        run chmod 0755 "$spi_dir"
    fi
    [ -d "$spi_dir" ] && [ ! -L "$spi_dir" ] \
        || die "SeekerHD IQ directory is not a regular directory"
    [ ! -e "$spi_factory" ] \
        || die "SeekerHD IQ factory backup already exists while the live directory remains"
    if [ "$spi_image_mode" = 1 ] || [ ! -s "$spi_active" ]; then
        run install -m 0644 "$spi_seed" "$spi_active"
    else
        log "preserving the live board's active SeekerHD profile"
    fi
    seekerhd_migrate_active_iq
}

seekerhd_migrate_active_iq() {
    smi_dir="$YONDER_SEEKER_SHARE_DIR/iqfiles"
    smi_factory="$YONDER_SEEKER_SHARE_DIR/iqfiles.factory"
    smi_state_dir=$(seekerhd_state_iq_dir)
    smi_active=$(seekerhd_active_iq_path)
    smi_state_active="$smi_state_dir/imx462_IMX462_default.json"
    smi_link=/var/lib/yonder/seekerhd/iqfiles

    if [ -L "$smi_dir" ]; then
        [ "$(readlink "$smi_dir")" = "$smi_link" ] \
            || die "SeekerHD IQ directory links somewhere other than durable Yonder state"
        [ -d "$smi_state_dir" ] && [ ! -L "$smi_state_dir" ] && [ -s "$smi_state_active" ] \
            || die "SeekerHD IQ link has no durable active tuning file"
        return 0
    fi

    # Complete only the intentional, recoverable interruption after the
    # immutable tree was renamed but before its replacement symlink appeared.
    if [ ! -e "$smi_dir" ] && [ -d "$smi_factory" ] && [ ! -L "$smi_factory" ]; then
        [ -d "$smi_state_dir" ] && [ ! -L "$smi_state_dir" ] && [ -s "$smi_state_active" ] \
            || die "SeekerHD IQ migration is incomplete without durable tuning"
        run ln -s "$smi_link" "$smi_dir"
        return 0
    fi

    [ -d "$smi_dir" ] && [ ! -L "$smi_dir" ] \
        || die "SeekerHD IQ directory is not a regular directory"
    [ ! -e "$smi_factory" ] \
        || die "SeekerHD IQ factory backup already exists while the live directory remains"
    smi_state_parent=${smi_state_dir%/iqfiles}
    if [ -e "$smi_state_parent" ]; then
        [ -d "$smi_state_parent" ] && [ ! -L "$smi_state_parent" ] \
            || die "SeekerHD durable state parent is not a regular directory"
    else
        run mkdir -p "$smi_state_parent"
        run chmod 0755 "$smi_state_parent"
    fi
    if [ -e "$smi_state_dir" ]; then
        [ -d "$smi_state_dir" ] && [ ! -L "$smi_state_dir" ] \
            || die "SeekerHD durable IQ directory is not a regular directory"
    else
        run mkdir "$smi_state_dir"
        run chmod 0755 "$smi_state_dir"
    fi
    [ -s "$smi_active" ] || die "SeekerHD source active IQ file is missing"
    if [ -s "$smi_state_active" ]; then
        log "preserving the durable active SeekerHD profile"
    else
        run install -m 0644 "$smi_active" "$smi_state_active.new"
        run cmp "$smi_active" "$smi_state_active.new"
        run mv "$smi_state_active.new" "$smi_state_active"
    fi
    # The root topology changes next.  Make the copied (or preserved) active
    # file durable first, so a maintenance interruption keeps a complete
    # source for the recognised factory-directory recovery path.
    run sync -f "$smi_state_active"
    run sync -f "$smi_state_dir"
    run mv "$smi_dir" "$smi_factory"
    run ln -s "$smi_link" "$smi_dir"
    [ -L "$smi_dir" ] && [ "$(readlink "$smi_dir")" = "$smi_link" ] \
        || die "SeekerHD durable IQ symlink was not installed"
    [ -s "$smi_state_active" ] \
        || die "SeekerHD active IQ file was lost while moving it to durable state"
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
    svi_iq_dir="$YONDER_SEEKER_SHARE_DIR/iqfiles"
    svi_state_iq_dir=$(seekerhd_state_iq_dir)
    [ -L "$svi_iq_dir" ] && [ "$(readlink "$svi_iq_dir")" = /var/lib/yonder/seekerhd/iqfiles ] \
        || die "the active SeekerHD IQ directory is not linked to durable Yonder state"
    [ -d "$YONDER_SEEKER_SHARE_DIR/iqfiles.factory" ] && [ ! -L "$YONDER_SEEKER_SHARE_DIR/iqfiles.factory" ] \
        || die "the immutable SeekerHD IQ factory backup is missing"
    [ -d "$svi_state_iq_dir" ] && [ ! -L "$svi_state_iq_dir" ] \
        || die "the durable SeekerHD IQ directory is missing"
    svi_expected_uid=0
    # Staged-root tests run without privilege on the build host. Production
    # runs in the target root and always retains the root-owner requirement.
    if [ -n "$YONDER_SEEKER_ROOT" ]; then
        svi_expected_uid=${YONDER_SEEKER_TEST_UID:-0}
    fi
    YONDER_SEEKER_VERIFY_ACTIVE="$svi_state_iq_dir/imx462_IMX462_default.json" \
        YONDER_SEEKER_VERIFY_EXPECTED_UID="$svi_expected_uid" python3 - <<'PY'
import os
import stat

path = os.environ['YONDER_SEEKER_VERIFY_ACTIVE']
expected_uid = int(os.environ['YONDER_SEEKER_VERIFY_EXPECTED_UID'])
info = os.lstat(path)
if not stat.S_ISREG(info.st_mode):
    raise SystemExit('the durable SeekerHD active IQ file is not regular')
if info.st_uid != expected_uid:
    raise SystemExit('the durable SeekerHD active IQ file is not owned by root')
if info.st_mode & 0o022:
    raise SystemExit('the durable SeekerHD active IQ file is writable by group or other')
if info.st_size <= 0 or info.st_size > 16 * 1024 * 1024:
    raise SystemExit('the durable SeekerHD active IQ file has an invalid size')
PY
    # The manifest is the generator's independently recorded content map.
    # Verify all named profiles, then ensure a newly built image begins in
    # the normal linear profile. Live reinstalls preserve an operator's
    # current profile and therefore intentionally skip the final comparison.
    YONDER_SEEKER_VERIFY_SHARE="$YONDER_SEEKER_SHARE_DIR" \
        YONDER_SEEKER_VERIFY_ACTIVE="$svi_state_iq_dir/imx462_IMX462_default.json" \
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
    active = Path(os.environ['YONDER_SEEKER_VERIFY_ACTIVE']).read_bytes()
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
