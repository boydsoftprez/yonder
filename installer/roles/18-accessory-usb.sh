# SPDX-License-Identifier: GPL-3.0-or-later
# R-CAM-15: prepare the narrow configfs write path before 20 starts the daemon.
# This installs kernel prerequisites, never peripheral boot settings or a gadget.
# shellcheck shell=sh

ensure_dir "$YONDER_MODULES_LOAD_DIR" 0755
if [ "$DRY_RUN" = "1" ]; then
    log "would write $YONDER_ACCESSORY_MODULES_CONF"
else
    printf 'libcomposite\nusb_f_fs\n' >"$YONDER_ACCESSORY_MODULES_CONF"
    chmod 0644 "$YONDER_ACCESSORY_MODULES_CONF"
fi
if [ "$IMAGE_MODE" = "1" ]; then
    log "image mode: modules will load from $YONDER_ACCESSORY_MODULES_CONF on the target's first boot; not mounting configfs"
elif [ "$DRY_RUN" = "1" ]; then
    log "would load libcomposite and usb_f_fs and ensure configfs is mounted before yonder-core starts"
else
    if command -v modprobe >/dev/null 2>&1 && modprobe libcomposite && modprobe usb_f_fs; then
        if ! mountpoint -q /sys/kernel/config; then
            mount -t configfs configfs /sys/kernel/config \
                || log "configfs unavailable; accessory detection will report it, and core installation continues"
        fi
    else
        log "FunctionFS modules unavailable in this kernel; accessory detection will report it, and core installation continues"
    fi
fi
