# SPDX-License-Identifier: GPL-3.0-or-later
# Install the core configuration service and its unit.
# shellcheck shell=sh

# A vendored Node avoids the network entirely; ensure_pkgs nodejs is only
# needed when there is none.
install_bundled_node || ensure_pkgs nodejs
command -v npm >/dev/null 2>&1 || ensure_pkgs npm
require_node 20

# Now that a node is resolved, give systemd a fixed path to it. The unit
# cannot name either candidate directly: the bundled runtime lives under
# $YONDER_PREFIX and is only on PATH inside this script, and the packaged one
# is only present on the route that installed it.
link_node

yc_src="$YONDER_SRC/packages/yonder-core"
yc_dest="$YONDER_PREFIX/packages/yonder-core"

log "installing yonder-core into $yc_dest"
ensure_dir "$YONDER_PREFIX/packages" 0755
ensure_dir "$yc_dest" 0755
run rm -rf "$yc_dest/src"
run cp "$yc_src/package.json" "$yc_dest/package.json"
run cp "$yc_src/package-lock.json" "$yc_dest/package-lock.json"
run cp "$yc_src/tsconfig.json" "$yc_dest/tsconfig.json"

# A prebuilt tree needs both dist/ (the compiled daemon) and node_modules/
# (its production dependencies) - either alone cannot run, so both must be
# present before this path is trusted. One without the other falls back to
# installing and building instead, same as neither being present.
yc_prebuilt=0
if [ -f "$yc_src/dist/daemon/server.js" ] && [ -d "$yc_src/node_modules" ]; then
    yc_prebuilt=1
elif [ -f "$yc_src/dist/daemon/server.js" ] || [ -d "$yc_src/node_modules" ]; then
    log "prebuilt tree in $yc_src is missing dist/ or node_modules/ (both are required to use it); installing and building instead"
fi

if [ "$yc_prebuilt" = "1" ]; then
    log "prebuilt dist/ and node_modules/ found in $yc_src; using them, skipping install and build"
    # src/ is TypeScript, only needed to build it. Nothing at $yc_dest reads
    # it once dist/ exists, so copying it here would be the same dead weight
    # the installer already carries by shipping *.test.ts inside src/ on the
    # network path below - no reason to repeat that on the one path that can
    # just skip it.
    run rm -rf "$yc_dest/dist"
    run cp -r "$yc_src/dist" "$yc_dest/dist"
    run rm -rf "$yc_dest/node_modules"
    run cp -r "$yc_src/node_modules" "$yc_dest/node_modules"
else
    run cp -r "$yc_src/src" "$yc_dest/src"

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
fi

if [ "$DRY_RUN" != "1" ] && [ ! -f "$yc_dest/dist/daemon/server.js" ]; then
    die "build produced no $yc_dest/dist/daemon/server.js; the service would not start"
fi

# A board with no configuration has nothing for the daemon to load: it throws
# before it can listen, and Restart=always turns that into a restart loop
# rather than a working device. Seed the shipped default, once.
#
# An operator's own file is never overwritten. After the first install this
# file belongs to the device, and the daemon is its only writer.
yc_default_config="$YONDER_SRC/config/defaults/config.yaml"
ensure_dir "$YONDER_ETC" 0750
if [ -f "$YONDER_ETC/config.yaml" ]; then
    log "configuration already present, leaving it alone: $YONDER_ETC/config.yaml"
elif [ -f "$yc_default_config" ]; then
    log "seeding $YONDER_ETC/config.yaml from the shipped default"
    run cp "$yc_default_config" "$YONDER_ETC/config.yaml"
    run chmod 0644 "$YONDER_ETC/config.yaml"
else
    die "no default configuration at $yc_default_config"
fi

if [ -f "$YONDER_SRC/systemd/yonder-core.service" ]; then
    run cp "$YONDER_SRC/systemd/yonder-core.service" /etc/systemd/system/yonder-core.service

    # Post-condition, before anything is enabled or started: the unit systemd
    # is about to run names a binary that is there. A board whose ExecStart
    # points at nothing does not fail visibly — it fails at step EXEC with
    # status=203 and, under Restart=always, keeps failing, which is discovered
    # by fetching the aircraft back and reading its journal. Checked against
    # the copy systemd will actually read; on a dry run there is none, so the
    # source it was copied from stands in.
    if [ "$DRY_RUN" = "1" ]; then
        yc_unit="$YONDER_SRC/systemd/yonder-core.service"
    else
        yc_unit=/etc/systemd/system/yonder-core.service
    fi
    assert_unit_exec "$yc_unit" "$YONDER_NODE_LINK"

    if [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl daemon-reload
        run systemctl enable yonder-core.service
        # Enabling only arms the next boot. Without a start, a freshly flashed
        # board sits there running nothing until someone reboots it, and the
        # access point never appears. `restart` rather than `start` so
        # re-running the installer also picks up the daemon just rebuilt
        # above, instead of leaving the previous process in place.
        run systemctl restart yonder-core.service
    else
        log "skipping systemctl (dry run or not a systemd host)"
    fi
fi
