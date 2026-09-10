# SPDX-License-Identifier: GPL-3.0-or-later
# R-CAM-15: prepare the narrow configfs write path before 20 starts the daemon.
# This installs kernel prerequisites, never peripheral boot settings or a gadget.
# shellcheck shell=sh

ensure_dir /etc/modules-load.d 0755
if [ "$DRY_RUN" = "1" ]; then
    log "would load libcomposite and usb_f_fs and ensure configfs is mounted before yonder-core starts"
else
    cat > /etc/modules-load.d/yonder-accessory.conf <<'MODULES'
libcomposite
usb_f_fs
MODULES
    chmod 0644 /etc/modules-load.d/yonder-accessory.conf
    if command -v modprobe >/dev/null 2>&1 && modprobe libcomposite && modprobe usb_f_fs; then
        if ! mountpoint -q /sys/kernel/config; then
            mount -t configfs configfs /sys/kernel/config \
                || log "configfs unavailable; accessory detection will report it, and core installation continues"
        fi
    else
        log "FunctionFS modules unavailable in this kernel; accessory detection will report it, and core installation continues"
    fi
fi
