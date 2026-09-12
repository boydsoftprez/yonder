# SPDX-License-Identifier: GPL-3.0-or-later
# Service and package lifecycle helpers for live and image installs.
# Sourced after common.sh, never executed.
# shellcheck shell=sh

: "${IMAGE_MODE:=0}"
: "${YONDER_POLICY_RC_D:=/usr/sbin/policy-rc.d}"

PACKAGE_POLICY_ACTIVE=0
PACKAGE_POLICY_HAD_PRIOR=0
PACKAGE_POLICY_BACKUP=""

assert_unit_enabled() {
    aue_unit="$1"
    if [ "$DRY_RUN" = "1" ]; then
        log "would check that something in $YONDER_SYSTEMD_DIRS wants $aue_unit at boot"
        return 0
    fi
    # shellcheck disable=SC2086 # the roots are a deliberate word list
    aue_wants=$(find $YONDER_SYSTEMD_DIRS -name "$aue_unit" -type l 2>/dev/null \
        | grep -E '\.(wants|requires)/' | sort -u || true)
    [ -n "$aue_wants" ] \
        || die "$aue_unit is not enabled: nothing in $YONDER_SYSTEMD_DIRS wants it at boot"
    log "$aue_unit is enabled for the next boot"
}

enable_unit_offline() {
    euo_unit="$1"
    if [ "$DRY_RUN" != "1" ]; then
        command -v systemctl >/dev/null 2>&1 \
            || die "systemctl is required to enable $euo_unit in the image filesystem"
    fi
    run systemctl --root=/ enable "$euo_unit"
}

service_enable() {
    se_unit="$1"
    if [ "$IMAGE_MODE" = "1" ]; then
        enable_unit_offline "$se_unit"
        assert_unit_enabled "$se_unit"
    elif [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl enable "$se_unit"
    else
        log "skipping systemctl enable $se_unit (dry run or not a systemd host)"
    fi
}

service_disable() {
    sd_unit="$1"
    if [ "$IMAGE_MODE" = "1" ]; then
        # Upstream image enable links may not be tracked by deb-systemd-helper.
        # Inspect and change actual unit state on disk, without a live manager.
        if [ "$DRY_RUN" != "1" ]; then
            command -v systemctl >/dev/null 2>&1 \
                || die "systemctl is required to disable $sd_unit in the image filesystem"
        fi
        try systemctl --root=/ disable "$sd_unit"
    else
        disable_unit_offline "$sd_unit"
    fi
    assert_unit_disabled "$sd_unit"
}

service_daemon_reload() {
    if [ "$IMAGE_MODE" = "1" ]; then
        log "image mode: unit files are on disk; not asking a live systemd manager to reload"
    elif [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl daemon-reload
    else
        log "skipping systemctl daemon-reload (dry run or not a systemd host)"
    fi
}

service_restart() {
    sr_unit="$1"
    if [ "$IMAGE_MODE" = "1" ]; then
        log "image mode: $sr_unit will start on boot; not restarting a live service"
    elif [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl restart "$sr_unit"
    else
        log "skipping systemctl restart $sr_unit (dry run or not a systemd host)"
    fi
}

service_stop() {
    ss_unit="$1"
    if [ "$IMAGE_MODE" = "1" ]; then
        log "image mode: package starts are suppressed; not stopping a live $ss_unit"
    elif [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        try systemctl stop "$ss_unit"
    else
        log "skipping systemctl stop $ss_unit (dry run or not a systemd host)"
    fi
}

# Stop a service whose installed files are about to be replaced. Unlike the
# ordinary best-effort service_stop, this is a safety boundary: a successful
# return proves that no process from the old generation remains runnable.
# A missing unit is the normal fresh-install case.
service_stop_for_replacement() {
    ssfr_unit="$1"
    if [ "$IMAGE_MODE" = "1" ]; then
        log "image mode: no live $ssfr_unit can outlive its replacement"
        return 0
    fi
    if [ "$DRY_RUN" = "1" ]; then
        printf '  + systemctl stop %s\n' "$ssfr_unit"
        log "would require $ssfr_unit to be inactive before replacing its files"
        return 0
    fi
    command -v systemctl >/dev/null 2>&1 \
        || die "systemctl is required to stop $ssfr_unit before replacing its files"
    if ! ssfr_load=$(systemctl show --property=LoadState --value "$ssfr_unit" 2>&1); then
        die "could not determine whether $ssfr_unit exists before replacement: $ssfr_load"
    fi
    if [ "$ssfr_load" = "not-found" ]; then
        log "$ssfr_unit is not installed yet; there is no old process to stop"
        return 0
    fi
    run systemctl stop "$ssfr_unit"
    if ! ssfr_active=$(systemctl show --property=ActiveState --value "$ssfr_unit" 2>&1); then
        die "could not verify $ssfr_unit stopped before replacement: $ssfr_active"
    fi
    case "$ssfr_active" in
        inactive|failed) log "$ssfr_unit is stopped; its files may be replaced" ;;
        *) die "$ssfr_unit remained $ssfr_active after stop; refusing to replace files beneath the old process" ;;
    esac
}

restore_package_service_policy() {
    [ "$PACKAGE_POLICY_ACTIVE" = "1" ] || return 0
    if [ "$PACKAGE_POLICY_HAD_PRIOR" = "1" ]; then
        # ACTIVE and HAD_PRIOR are armed before the original is renamed. If
        # the rename failed, no backup exists and the untouched original must
        # not be removed. If it succeeded, replace our temporary policy (or
        # the empty path left by an immediate signal) with that exact backup.
        if [ -e "$PACKAGE_POLICY_BACKUP" ] || [ -h "$PACKAGE_POLICY_BACKUP" ]; then
            rm -f "$YONDER_POLICY_RC_D" || return 1
            mv "$PACKAGE_POLICY_BACKUP" "$YONDER_POLICY_RC_D" || return 1
        fi
    else
        rm -f "$YONDER_POLICY_RC_D" || return 1
    fi
    PACKAGE_POLICY_ACTIVE=0
    PACKAGE_POLICY_BACKUP=""
    return 0
}

package_policy_exit() {
    ppe_status=$?
    trap - 0
    if ! restore_package_service_policy; then
        printf 'error: could not restore %s after package installation\n' "$YONDER_POLICY_RC_D" >&2
        ppe_status=1
    fi
    exit "$ppe_status"
}

begin_package_service_suppression() {
    [ "$IMAGE_MODE" = "1" ] || return 0
    if [ "$DRY_RUN" = "1" ]; then
        log "would install a temporary policy-rc.d while image packages are configured"
        return 0
    fi
    [ "$PACKAGE_POLICY_ACTIVE" = "0" ] || return 0

    PACKAGE_POLICY_BACKUP="$YONDER_POLICY_RC_D.yonder.$$"
    [ ! -e "$PACKAGE_POLICY_BACKUP" ] && [ ! -h "$PACKAGE_POLICY_BACKUP" ] \
        || die "temporary package-service policy backup already exists: $PACKAGE_POLICY_BACKUP"

    trap 'package_policy_exit' 0
    trap 'exit 129' 1
    trap 'exit 130' 2
    trap 'exit 143' 15

    if [ -e "$YONDER_POLICY_RC_D" ] || [ -h "$YONDER_POLICY_RC_D" ]; then
        PACKAGE_POLICY_HAD_PRIOR=1
        PACKAGE_POLICY_ACTIVE=1
        mv "$YONDER_POLICY_RC_D" "$PACKAGE_POLICY_BACKUP" \
            || die "could not preserve the existing $YONDER_POLICY_RC_D"
    else
        PACKAGE_POLICY_ACTIVE=1
    fi
    ensure_dir "$(dirname "$YONDER_POLICY_RC_D")" 0755
    if ! printf '#!/bin/sh\nexit 101\n' >"$YONDER_POLICY_RC_D"; then
        die "could not install temporary package-service policy at $YONDER_POLICY_RC_D"
    fi
    chmod 0755 "$YONDER_POLICY_RC_D" \
        || die "could not make temporary package-service policy executable"
    log "package service startup is suppressed while the image is installed"
}
