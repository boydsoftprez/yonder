# SPDX-License-Identifier: GPL-3.0-or-later
# Raspberry Pi candidate preparation based on the existing Pi boot layout.
# Final-image and per-model qualification remains separate hardware work.
# shellcheck shell=sh

target_preflight() {
    if [ "$DRY_RUN" = "1" ]; then
        log "would validate Raspberry Pi config.txt and cmdline.txt"
        return 0
    fi
    [ -f "$YONDER_BOOT_DIR/config.txt" ] && [ -f "$YONDER_BOOT_DIR/cmdline.txt" ] \
        || die "the rpi target requires config.txt and cmdline.txt under $YONDER_BOOT_DIR"
}

target_prepare_network() { return 0; }

target_prepare_uart() {
    ua_cfg="$YONDER_BOOT_DIR/config.txt"
    ua_cmdline="$YONDER_BOOT_DIR/cmdline.txt"
    ua_marker='# yonder-uart'
    ua_line1='enable_uart=1'
    ua_line2='dtoverlay=disable-bt'

    # shellcheck disable=SC2329 # invoked through run
    ua_append_stanza() {
        printf '\n%s\n%s\n%s\n' "$ua_marker" "$ua_line1" "$ua_line2" >>"$1"
    }
    if grep -qxF "$ua_marker" "$ua_cfg"; then
        log "config.txt already carries the $ua_marker stanza"
    else
        run ua_append_stanza "$ua_cfg"
    fi

    ua_console_re='(^|[[:space:]])console=serial0(,[^[:space:]]*)?([[:space:]]|$)'
    # shellcheck disable=SC2329 # invoked through run
    ua_strip_console() {
        ua_stripped=$(cat "$1")
        while printf '%s\n' "$ua_stripped" | grep -Eq "$ua_console_re"; do
            ua_stripped=$(printf '%s\n' "$ua_stripped" \
                | sed -E '{
                    s/(^|[[:space:]])console=serial0(,[^[:space:]]*)?([[:space:]]|$)/\1\3/g
                    s/^[[:space:]]+//
                    s/[[:space:]]+$//
                    s/[[:space:]]+/ /g
                }')
        done
        printf '%s\n' "$ua_stripped" >"$1.new" || { rm -f "$1.new"; return 1; }
        mv "$1.new" "$1" || { rm -f "$1.new"; return 1; }
    }
    if grep -Eq "$ua_console_re" "$ua_cmdline"; then
        run ua_strip_console "$ua_cmdline"
    fi

    service_disable serial-getty@ttyAMA0.service
    service_stop hciuart.service
    service_disable hciuart.service

    if [ "$DRY_RUN" = "1" ]; then
        log "would check Raspberry Pi UART preparation"
        return 0
    fi
    ua_want=$(printf '%s\n%s\n%s' "$ua_marker" "$ua_line1" "$ua_line2")
    ua_have=$(awk -v m="$ua_marker" '
        $0 == m { print; found = 1; left = 2; next }
        found && left > 0 { print; left--; next }
    ' "$ua_cfg")
    [ "$ua_have" = "$ua_want" ] \
        || die "config.txt does not carry an intact $ua_marker stanza"
    ! grep -Eq "$ua_console_re" "$ua_cmdline" \
        || die "cmdline.txt still carries console=serial0"
    log "the Raspberry Pi header UART is staged for the autopilot at the next boot"
}
