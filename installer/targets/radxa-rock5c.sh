# SPDX-License-Identifier: GPL-3.0-or-later
# ROCK 5C private bench-image preparation. Hardware qualification remains
# deliberately separate from this explicit, reversible image-build opt-in.
# shellcheck shell=sh

rock5c_env_value() {
    r5ev_key="$1"
    awk -F= -v key="$r5ev_key" '$1 == key { print substr($0, length(key) + 2) }' \
        "$YONDER_ARMBIAN_ENV"
}

rock5c_require_env_value() {
    r5rev_key="$1"
    r5rev_expected="$2"
    r5rev_actual=$(rock5c_env_value "$r5rev_key")
    [ "$r5rev_actual" = "$r5rev_expected" ] \
        || die "$YONDER_ARMBIAN_ENV must contain exactly $r5rev_key=$r5rev_expected for the ROCK 5C bench image"
}

rock5c_names_overlay() {
    r5no_key="$1"
    r5no_name="$2"
    # shellcheck disable=SC2020 # space and tab both mapped to newline
    rock5c_env_value "$r5no_key" | tr ' \t' '\n\n' | grep -qxF "$r5no_name"
}

target_preflight() {
    [ "${IMAGE_HARDWARE_TEST:-0}" = "1" ] \
        || die "ROCK 5C UART preparation is not qualified; refusing image installation before making changes. Use --hardware-test only for the private ROCK 5C bench candidate; ordinary images remain gated."

    if [ "$DRY_RUN" = "1" ]; then
        log "would validate the exact ROCK 5C Armbian environment, DTB, and preserved UART2 debug console"
        return 0
    fi

    [ -f "$YONDER_ARMBIAN_ENV" ] \
        || die "the ROCK 5C bench target requires $YONDER_ARMBIAN_ENV"
    [ -f "$YONDER_ROCK5C_DTB" ] \
        || die "the ROCK 5C bench target requires the exact DTB $YONDER_ROCK5C_DTB"
    rock5c_require_env_value fdtfile rockchip/rk3588s-rock-5c.dtb
    rock5c_require_env_value overlay_prefix rockchip-rk3588
    rock5c_require_env_value console both

    if rock5c_names_overlay overlays rk3568-uart2-m0 \
        || rock5c_names_overlay user_overlays uart2-m0 \
        || rock5c_names_overlay user_overlays rk3568-uart2-m0; then
        die "$YONDER_ARMBIAN_ENV names a ZERO 3W/UART2 overlay; the ROCK 5C bench image must preserve its UART2 debug console"
    fi

    command -v fdtget >/dev/null 2>&1 \
        || die "the ROCK 5C bench preflight requires fdtget to identify $YONDER_ROCK5C_DTB"
    r5_compatible=$(fdtget -t s "$YONDER_ROCK5C_DTB" / compatible 2>/dev/null) \
        || die "cannot read the compatible property from $YONDER_ROCK5C_DTB"
    case " $r5_compatible " in
        *" radxa,rock-5c "*) ;;
        *) die "$YONDER_ROCK5C_DTB is not compatible with radxa,rock-5c" ;;
    esac
    log "validated the exact ROCK 5C boot environment and preserved UART2 debug console"
}

target_prepare_network() {
    r5_netplan_found=0
    for r5_netplan_file in "$YONDER_NETPLAN_DIR"/*.yaml; do
        [ -f "$r5_netplan_file" ] || continue
        r5_netplan_found=1
        ensure_dir "$YONDER_NETPLAN_DISABLED_DIR" 0755
        run mv "$r5_netplan_file" "$YONDER_NETPLAN_DISABLED_DIR/$(basename "$r5_netplan_file")"
    done
    if [ "$r5_netplan_found" = "1" ]; then
        log "retired the ROCK 5C netplan files so they cannot regenerate NetworkManager deny rules"
    else
        log "no active netplan YAML remains on the ROCK 5C image"
    fi
    service_disable systemd-networkd.service
    service_disable systemd-networkd.socket
    service_disable systemd-networkd-wait-online.service
    service_enable NetworkManager.service
    log "ROCK 5C networking is staged for Yonder's NetworkManager access point; Ethernet is not required"
}

target_prepare_uart() {
    r5_overlay="$YONDER_DTB_OVERLAY_DIR/rk3588-uart4-m2.dtbo"
    r5_token=rk3588-uart4-m2

    if [ "$DRY_RUN" = "1" ]; then
        log "would validate $r5_overlay against $YONDER_ROCK5C_DTB before staging UART4_M2; UART2 stays the debug console"
        return 0
    fi

    if [ ! -f "$r5_overlay" ]; then
        log "UART4_M2 remains unstaged pending physical SSH testing: $r5_overlay is absent; UART2 stays the debug console"
        return 0
    fi
    if ! command -v fdtoverlay >/dev/null 2>&1; then
        log "UART4_M2 remains unstaged pending physical SSH testing: fdtoverlay is unavailable; UART2 stays the debug console"
        return 0
    fi

    r5_applied=$(mktemp "${TMPDIR:-/tmp}/yonder-rock5c-uart4.XXXXXX.dtb") \
        || die "could not allocate a temporary DTB for ROCK 5C UART4 validation"
    if ! fdtoverlay -i "$YONDER_ROCK5C_DTB" -o "$r5_applied" "$r5_overlay"; then
        rm -f "$r5_applied"
        log "UART4_M2 remains unstaged pending physical SSH testing: the overlay did not apply to the exact ROCK 5C DTB; UART2 stays the debug console"
        return 0
    fi

    # `fdtoverlay` succeeding proves only that the fragments resolved. Verify
    # the exact RK3588 UART4 node and the M2 mux selected by the ROCK 5C base:
    # GPIO1_B2/B3 are bank 1 pins 10/11, function 10. Compare phandles rather
    # than pinctrl node names alone so the enabled UART actually references it.
    r5_uart_status=$(fdtget -t s "$r5_applied" /serial@feb70000 status 2>/dev/null || true)
    r5_uart_pinctrl=$(fdtget -t u "$r5_applied" /serial@feb70000 pinctrl-0 2>/dev/null || true)
    r5_m2_phandle=$(fdtget -t u "$r5_applied" /pinctrl/uart4/uart4m2-xfer phandle 2>/dev/null || true)
    r5_m2_pins=$(fdtget -t u "$r5_applied" /pinctrl/uart4/uart4m2-xfer rockchip,pins 2>/dev/null || true)
    if [ "$r5_uart_status" != "okay" ] \
        || [ -z "$r5_uart_pinctrl" ] \
        || [ "$r5_uart_pinctrl" != "$r5_m2_phandle" ] \
        || ! printf '%s\n' "$r5_m2_pins" | awk '
            NF == 8 && $1 == 1 && $2 == 10 && $3 == 10 \
                && $5 == 1 && $6 == 11 && $7 == 10 { valid = 1 }
            END { exit(valid ? 0 : 1) }
        '; then
        rm -f "$r5_applied"
        log "UART4_M2 remains unstaged pending physical SSH testing: the applied tree does not enable /serial@feb70000 with the GPIO1_B2/B3 M2 pinctrl; UART2 stays the debug console"
        return 0
    fi
    rm -f "$r5_applied"

    if rock5c_names_overlay overlays "$r5_token"; then
        log "$YONDER_ARMBIAN_ENV already carries $r5_token in overlays"
    else
        # shellcheck disable=SC2329 # invoked through run
        r5_add_overlay() {
            awk -v tok="$2" '
                BEGIN { done = 0 }
                /^overlays=/ {
                    rest = substr($0, 10)
                    $0 = (rest == "" ? "overlays=" tok : "overlays=" rest " " tok)
                    done = 1
                }
                { print }
                END { if (!done) print "overlays=" tok }
            ' "$1" >"$1.new" && mv "$1.new" "$1"
        }
        run r5_add_overlay "$YONDER_ARMBIAN_ENV" "$r5_token"
    fi

    rock5c_require_env_value console both
    rock5c_names_overlay overlays "$r5_token" \
        || die "$YONDER_ARMBIAN_ENV does not name the offline-validated $r5_token overlay"
    log "UART4_M2 is staged for physical SSH and loopback testing; UART2 remains the 1,500,000-baud debug console"
}
