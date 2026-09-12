# SPDX-License-Identifier: GPL-3.0-or-later
# Armbian candidate preparation based on previous Radxa ZERO 3W board evidence.
# Final-image qualification remains separate hardware work.
# shellcheck shell=sh

target_preflight() {
    if [ "$DRY_RUN" = "1" ]; then
        log "would validate the ZERO 3W Armbian boot environment and UART2 overlay"
        return 0
    fi
    [ -f "$YONDER_ARMBIAN_ENV" ] \
        || die "the radxa-zero3w target requires $YONDER_ARMBIAN_ENV"
    [ -f "$YONDER_DTB_OVERLAY_DIR/rk3568-uart2-m0.dtbo" ] \
        || die "the radxa-zero3w target requires rk3568-uart2-m0.dtbo under $YONDER_DTB_OVERLAY_DIR"
}

target_prepare_network() {
    netplan_found=0
    for netplan_file in "$YONDER_NETPLAN_DIR"/*.yaml; do
        [ -f "$netplan_file" ] || continue
        netplan_found=1
        ensure_dir "$YONDER_NETPLAN_DISABLED_DIR" 0755
        run mv "$netplan_file" "$YONDER_NETPLAN_DISABLED_DIR/$(basename "$netplan_file")"
    done
    if [ "$netplan_found" = "1" ]; then
        log "retired the ZERO 3W netplan files so they cannot regenerate NetworkManager deny rules"
    else
        log "no active netplan YAML remains on the ZERO 3W image"
    fi
    service_disable systemd-networkd.service
    service_disable systemd-networkd.socket
    service_disable systemd-networkd-wait-online.service
    service_enable NetworkManager.service
}

target_prepare_uart() {
    ua_dtbo="$YONDER_DTB_OVERLAY_DIR/rk3568-uart2-m0.dtbo"
    ua_user="$YONDER_USER_OVERLAY_DIR/uart2-m0.dtbo"
    [ -f "$ua_dtbo" ] || die "no rk3568-uart2-m0.dtbo under $YONDER_DTB_OVERLAY_DIR; this ZERO 3W image cannot free the header UART"
    ensure_dir "$YONDER_USER_OVERLAY_DIR" 0755
    if [ -f "$ua_user" ]; then
        log "$ua_user already present"
    else
        run cp "$ua_dtbo" "$ua_user"
    fi

    ua_names_overlay() {
        # shellcheck disable=SC2020 # space and tab both mapped to newline
        sed -n 's/^user_overlays=//p' "$1" | tr ' \t' '\n\n' | grep -qxF "$2"
    }
    # shellcheck disable=SC2329 # invoked through run
    ua_add_overlay() {
        awk -v tok="$2" '
            BEGIN { done = 0 }
            /^user_overlays=/ {
                rest = substr($0, 15)
                $0 = (rest == "" ? "user_overlays=" tok : "user_overlays=" rest " " tok)
                done = 1
            }
            { print }
            END { if (!done) print "user_overlays=" tok }
        ' "$1" >"$1.new" && mv "$1.new" "$1"
    }
    if ua_names_overlay "$YONDER_ARMBIAN_ENV" uart2-m0; then
        log "$YONDER_ARMBIAN_ENV already carries uart2-m0 in user_overlays"
    else
        run ua_add_overlay "$YONDER_ARMBIAN_ENV" uart2-m0
    fi

    # shellcheck disable=SC2329 # invoked through run
    ua_drop_serial_console() {
        sed -E 's/^console=(both|serial)$/console=display/' "$1" >"$1.new" && mv "$1.new" "$1"
    }
    if grep -Eq '^console=(both|serial)$' "$YONDER_ARMBIAN_ENV"; then
        run ua_drop_serial_console "$YONDER_ARMBIAN_ENV"
    fi

    service_disable serial-getty@ttyFIQ0.service
    if [ "$DRY_RUN" = "1" ]; then
        log "would check that ZERO 3W UART2 preparation is complete"
        return 0
    fi
    [ -f "$ua_user" ] || die "$ua_user is not there; the overlay would not load"
    ua_names_overlay "$YONDER_ARMBIAN_ENV" uart2-m0 \
        || die "$YONDER_ARMBIAN_ENV does not name uart2-m0"
    ! grep -Eq '^console=(both|serial)$' "$YONDER_ARMBIAN_ENV" \
        || die "$YONDER_ARMBIAN_ENV still puts a login console on UART2"
    log "UART2 is staged for the autopilot as /dev/ttyS2; it takes effect at the next boot"
}
