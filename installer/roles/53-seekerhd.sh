# SPDX-License-Identifier: GPL-3.0-or-later
# Install the ZERO 3W SeekerHD sensor, ISP service and tuning. R-CAM-01,
# R-CAM-05, R-CAM-14, R-HW-03.
# shellcheck shell=sh

if ! seekerhd_target_selected; then
    log "this is not the Radxa ZERO 3W target; skipping the SeekerHD stack"
    return 0
fi

seekerhd_validate_payload
ensure_pkgs dkms device-tree-compiler libdrm2 libstdc++6 \
    linux-headers-vendor-rk35xx python3 v4l-utils

seeker_src="$YONDER_SRC/scripts/spikes/seekerhd"
seeker_installer="$YONDER_SRC/installer/seekerhd"
seeker_payload=$(seekerhd_payload_dir)
[ -s "$seeker_installer/bootargs.py" ] \
    || die "the SeekerHD install source is missing $seeker_installer/bootargs.py"
for seeker_file in imx462_yonder.c imx462_hdr2.h seekerhd-imx462.dts prepare.py \
        select-profile.py yonder-seekerhd.service yonder-seekerhd-aiq.service \
        core-camera-order.conf; do
    [ -s "$seeker_src/$seeker_file" ] \
        || die "the SeekerHD install source is missing $seeker_src/$seeker_file"
done

# DKMS owns rebuilds after apt installs another vendor kernel. Build every
# kernel already present in this root now; no host uname value participates.
seeker_kernels=$(seekerhd_require_kernel_headers)
seekerhd_validate_module_version "$seeker_src/imx462_yonder.c" \
    "$seeker_src/imx462_hdr2.h"
seekerhd_require_notifier_blacklist_support
ensure_dir "$YONDER_SEEKER_DKMS_SOURCE_DIR" 0755
run install -m 0644 "$seeker_src/imx462_yonder.c" \
    "$YONDER_SEEKER_DKMS_SOURCE_DIR/imx462_yonder.c"
run install -m 0644 "$seeker_src/imx462_hdr2.h" \
    "$YONDER_SEEKER_DKMS_SOURCE_DIR/imx462_hdr2.h"
run install -m 0644 "$seeker_installer/Makefile" \
    "$YONDER_SEEKER_DKMS_SOURCE_DIR/Makefile"
run install -m 0644 "$seeker_installer/dkms.conf" \
    "$YONDER_SEEKER_DKMS_SOURCE_DIR/dkms.conf"
if [ "$DRY_RUN" = "1" ]; then
    log "would register imx462-yonder/$YONDER_SEEKER_VERSION with DKMS"
elif dkms status -m imx462-yonder -v "$YONDER_SEEKER_VERSION" \
        | grep -q '^imx462-yonder/'; then
    log "imx462-yonder/$YONDER_SEEKER_VERSION is already registered with DKMS"
else
    run dkms add -m imx462-yonder -v "$YONDER_SEEKER_VERSION"
fi
for seeker_kernel in $seeker_kernels; do
    seekerhd_install_dkms_kernel "$seeker_kernel"
    run depmod -a "$seeker_kernel"
done

ensure_dir "$YONDER_MODULES_LOAD_DIR" 0755
run install -m 0644 "$seeker_installer/yonder-seekerhd.conf" \
    "$YONDER_MODULES_LOAD_DIR/yonder-seekerhd.conf"

# Compile from committed source in the target root, then prove it composes
# with the exact base tree and the UART overlay already staged by role 40.
ensure_dir "$YONDER_SEEKER_BOOT_OVERLAY_DIR" 0755
seeker_dtbo="$YONDER_SEEKER_BOOT_OVERLAY_DIR/seekerhd-imx462.dtbo"
run dtc -@ -I dts -O dtb -o "$seeker_dtbo.new" \
    "$seeker_src/seekerhd-imx462.dts"
run chmod 0644 "$seeker_dtbo.new"
run mv "$seeker_dtbo.new" "$seeker_dtbo"
seeker_fdt=$(sed -n 's/^fdtfile=//p' "$YONDER_ARMBIAN_ENV")
[ -n "$seeker_fdt" ] || die "$YONDER_ARMBIAN_ENV names no fdtfile for camera overlay validation"
seeker_base="${YONDER_SEEKER_ROOT}/boot/dtb/$seeker_fdt"
seeker_uart="$YONDER_USER_OVERLAY_DIR/uart2-m0.dtbo"
if [ "$DRY_RUN" = "1" ]; then
    log "would validate $seeker_dtbo with $seeker_base and $seeker_uart"
else
    seekerhd_validate_overlay_stack "$seeker_base" "$seeker_uart" "$seeker_dtbo"
fi
run seekerhd_add_user_overlay "$YONDER_ARMBIAN_ENV" seekerhd-imx462
run python3 "$seeker_installer/bootargs.py" "$YONDER_ARMBIAN_ENV"

# Runtime and profiles are fully offline payload files. Preserve the active IQ
# on a live reinstall; an image begins in the measured normal-light profile.
ensure_dir "$YONDER_SEEKER_LIB_DIR" 0755
ensure_dir "$YONDER_SEEKER_SHARE_DIR/iqfiles" 0755
ensure_dir "$YONDER_SEEKER_SHARE_DIR/profiles" 0755
run install -m 0755 "$seeker_payload/bin/rkaiq_3A_server" \
    "$YONDER_SEEKER_LIB_DIR/rkaiq_3A_server"
run install -m 0644 "$seeker_payload/lib/librkaiq.so" \
    "$YONDER_SEEKER_LIB_DIR/librkaiq.so"
run install -m 0755 "$seeker_installer/bootargs.py" "$YONDER_SEEKER_BOOTARGS"
run install -m 0755 "$seeker_src/prepare.py" "$YONDER_SEEKER_LIB_DIR/prepare.py"
ensure_dir "$(dirname "$YONDER_SEEKER_PROFILE_BIN")"
run install -m 0755 "$seeker_src/select-profile.py" \
    "$YONDER_SEEKER_PROFILE_BIN"
for seeker_profile in normal-light low-light legacy-low-light; do
    run install -m 0644 "$seeker_payload/profiles/$seeker_profile.json" \
        "$YONDER_SEEKER_SHARE_DIR/profiles/$seeker_profile.json"
done
run install -m 0644 "$seeker_payload/profiles/manifest.json" \
    "$YONDER_SEEKER_SHARE_DIR/profiles/manifest.json"
run install -m 0644 "$seeker_payload/SOURCES" "$YONDER_SEEKER_SHARE_DIR/SOURCES"
seeker_active="$YONDER_SEEKER_SHARE_DIR/iqfiles/imx462_IMX462_default.json"
if [ "$IMAGE_MODE" = "1" ] || [ ! -s "$seeker_active" ]; then
    run install -m 0644 "$seeker_payload/iqfiles/imx462_IMX462_default.json" \
        "$seeker_active"
else
    log "preserving the live board's active SeekerHD profile"
fi

ensure_dir "$YONDER_SEEKER_UNIT_DIR/yonder-core.service.d" 0755
run install -m 0644 "$seeker_src/yonder-seekerhd.service" \
    "$YONDER_SEEKER_UNIT_DIR/yonder-seekerhd.service"
run install -m 0644 "$seeker_src/yonder-seekerhd-aiq.service" \
    "$YONDER_SEEKER_UNIT_DIR/yonder-seekerhd-aiq.service"
run install -m 0644 "$seeker_src/core-camera-order.conf" \
    "$YONDER_SEEKER_UNIT_DIR/yonder-core.service.d/20-seekerhd.conf"
service_daemon_reload
service_enable yonder-seekerhd.service
service_enable yonder-seekerhd-aiq.service
if [ "$IMAGE_MODE" != "1" ]; then
    log "SeekerHD files are staged for reboot; not replacing the running vendor camera graph"
fi

if [ "$DRY_RUN" = "1" ]; then
    log "would verify the installed SeekerHD module, overlay, boot correction, ISP runtime, profiles and services"
else
    seekerhd_verify_install
fi
