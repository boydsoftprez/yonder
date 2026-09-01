# SPDX-License-Identifier: GPL-3.0-or-later
# Install the core configuration service and its unit.
# shellcheck shell=sh

ensure_pkgs nodejs
command -v npm >/dev/null 2>&1 || ensure_pkgs npm
require_node 20

yc_src="$YONDER_SRC/packages/yonder-core"
yc_dest="$YONDER_PREFIX/packages/yonder-core"

log "installing yonder-core into $yc_dest"
ensure_dir "$YONDER_PREFIX/packages" 0755
ensure_dir "$yc_dest" 0755
run rm -rf "$yc_dest/src"
run cp -r "$yc_src/src" "$yc_dest/src"
run cp "$yc_src/package.json" "$yc_dest/package.json"
run cp "$yc_src/package-lock.json" "$yc_dest/package-lock.json"
run cp "$yc_src/tsconfig.json" "$yc_dest/tsconfig.json"

# The unit starts dist/daemon/server.js, which is generated, and the daemon's
# dependencies live in the workspace root when the tree is a checkout. Neither
# is present on a board, so build here and leave behind only what the service
# needs to run. `npm ci` rather than `npm install`: it requires the lockfile
# copied above and installs exactly the versions it pins, so two boards
# imaged a week apart get the same dependency tree instead of whatever the
# registry serves at flash time.
log "installing dependencies and building"
run env npm --prefix "$yc_dest" ci --no-audit --no-fund
run env npm --prefix "$yc_dest" run build
run env npm --prefix "$yc_dest" prune --omit=dev

if [ "$DRY_RUN" != "1" ] && [ ! -f "$yc_dest/dist/daemon/server.js" ]; then
    die "build produced no $yc_dest/dist/daemon/server.js; the service would not start"
fi

if [ -f "$YONDER_SRC/systemd/yonder-core.service" ]; then
    run cp "$YONDER_SRC/systemd/yonder-core.service" /etc/systemd/system/yonder-core.service
    if [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl daemon-reload
        run systemctl enable yonder-core.service
    else
        log "skipping systemctl (dry run or not a systemd host)"
    fi
fi
