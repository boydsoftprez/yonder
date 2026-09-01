# SPDX-License-Identifier: GPL-3.0-or-later
# Install the core configuration service and its unit.
# shellcheck shell=sh

ensure_pkgs nodejs

log "copying yonder-core to $YONDER_PREFIX"
ensure_dir "$YONDER_PREFIX/packages" 0755
run cp -r "$YONDER_SRC/packages/yonder-core" "$YONDER_PREFIX/packages/"

if [ -f "$YONDER_SRC/systemd/yonder-core.service" ]; then
    run cp "$YONDER_SRC/systemd/yonder-core.service" /etc/systemd/system/yonder-core.service
    if [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl daemon-reload
        run systemctl enable yonder-core.service
    else
        log "skipping systemctl (dry run or not a systemd host)"
    fi
fi
