# SPDX-License-Identifier: GPL-3.0-or-later
# Install the core configuration service and its unit.
# shellcheck shell=sh

# A vendored Node avoids the network entirely; ensure_pkgs nodejs is only
# needed when there is none.
ensure_pkgs whois sudo openssh-server
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

# Check the helper's unit inputs while the installed generation is still
# running. A failed upgrade must not take a working core offline merely to
# discover that its replacement payload is incomplete.
for yc_admin_unit in yonder-admin.service yonder-admin.socket yonder-admin.tmpfiles yonder-owner-setup.service yonder-owner-getty.conf; do
    [ -f "$YONDER_SRC/systemd/$yc_admin_unit" ] \
        || die "required administration unit is missing: $yc_admin_unit"
done

log "installing yonder-core into $yc_dest"

# A prebuilt tree needs both dist/ (the compiled daemon) and a node_modules/
# that actually holds its production dependencies - either alone cannot run,
# so both must be present before this path is trusted. Anything less falls
# back to installing and building, same as neither being present.
#
# "Actually holds", not "is a directory". A checkout that has ever run the
# test suite has a packages/yonder-core/node_modules containing one entry,
# `.vite`, while the daemon's real dependencies are hoisted to the workspace
# root - so a directory test selects this path and copies a tree with no
# dependencies in it to a board. See prebuilt_deps_present.
yc_prebuilt=0
if [ -f "$yc_src/dist/daemon/server.js" ]; then
    if prebuilt_deps_present "$yc_src"; then
        [ -f "$yc_src/dist/admin/main.js" ] \
            || die "prebuilt yonder-core is missing dist/admin/main.js; refusing to replace the running administration helper"
        yc_prebuilt=1
    fi
else
    log "no compiled daemon at $yc_src/dist/daemon/server.js"
fi
[ "$yc_prebuilt" = "1" ] || [ "$IMAGE_MODE" != "1" ] \
    || die "image mode requires a prebuilt yonder-core dist/ with standalone production dependencies; refusing npm/source fallback"

# A socket restart alone leaves an already activated yonder-admin.service
# running from the old files. Stop core first so it cannot issue another
# request, then stop the helper and its activation socket before replacing
# either entry point. A failed stop aborts the upgrade; continuing would leave
# an old privileged process serving requests against newly replaced files.
service_stop_for_replacement yonder-core.service
service_stop_for_replacement yonder-admin.socket
service_stop_for_replacement yonder-admin.service

ensure_dir "$YONDER_PREFIX/packages" 0755
ensure_dir "$yc_dest" 0755
run rm -rf "$yc_dest/src"
run cp "$yc_src/package.json" "$yc_dest/package.json"
run cp "$yc_src/package-lock.json" "$yc_dest/package-lock.json"
run cp "$yc_src/tsconfig.json" "$yc_dest/tsconfig.json"

if [ "$yc_prebuilt" = "1" ]; then
    log "prebuilt dist/ and a complete node_modules/ found in $yc_src; using them, skipping install and build"
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
    # **`scripts/` too, because `npm run build` runs one of them.** The build
    # is `tsc` followed by `scripts/copy-assets.mjs`, which carries every
    # `assets/` directory under src/ into dist — the setup page among them.
    # Copying src/ and not scripts/ made this path fail outright on a board
    # with `Cannot find module .../scripts/copy-assets.mjs`, after `npm ci`
    # had already run: far enough in to look like it was working. It is
    # asserted in installer.test.ts against package.json's own build script,
    # so a build step that reaches for another directory fails there rather
    # than here.
    run cp -r "$yc_src/scripts" "$yc_dest/scripts"

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

# Both routes end here, and neither is trusted to have produced something that
# runs. The file existing was the whole of this check and it is not enough: an
# entry point is a file whether or not the packages it imports are underneath
# it, and the failure a missing one produces is ERR_MODULE_NOT_FOUND on every
# start rather than anything visible here. So the entry point is loaded, with
# the node the unit names, from the tree systemd will read.
assert_module_graph "$yc_dest" dist/daemon/server.js "$YONDER_NODE_LINK"
assert_module_graph "$yc_dest" dist/admin/main.js "$YONDER_NODE_LINK"
assert_module_graph "$yc_dest" dist/owner-access/cli.js "$YONDER_NODE_LINK"

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
    # Fresh installs need a readable empty secret bag before the root helper
    # can atomically seed the first generation. Never replace existing secrets.
    if [ ! -e "$YONDER_ETC/secrets.yaml" ]; then
        run install -m 0600 /dev/null "$YONDER_ETC/secrets.yaml"
    fi
else
    die "no default configuration at $yc_default_config"
fi

# Core's persistent mutations go through this private socket. Missing helper
# files must fail installation, rather than produce a daemon that cannot boot.
ensure_dir /var/lib/yonder-state 0700
ensure_dir /usr/lib/tmpfiles.d 0755
run cp "$YONDER_SRC/systemd/yonder-admin.tmpfiles" /usr/lib/tmpfiles.d/yonder-admin.conf
# Needed before live socket activation; boot recreates it through tmpfiles.
ensure_dir /run/sshd 0755
for yc_admin_unit in yonder-admin.service yonder-admin.socket; do
    run cp "$YONDER_SRC/systemd/$yc_admin_unit" "/etc/systemd/system/$yc_admin_unit"
done
if [ "$DRY_RUN" = "1" ]; then
    yc_admin_service="$YONDER_SRC/systemd/yonder-admin.service"
else
    yc_admin_service=/etc/systemd/system/yonder-admin.service
fi
assert_unit_exec "$yc_admin_service" "$YONDER_NODE_LINK"
assert_unit_accounts "$yc_admin_service"
# A conventional upgrade can carry the pre-generation rollback journal at
# /var/lib/yonder/apply.json. yonder-admin consumes and clears it after the
# imported state is durable; under ProtectSystem=strict that exact legacy
# directory must be writable or every activation retries on EROFS.
assert_daemon_can_write "$yc_admin_service" /var/lib/yonder/apply.json
run cp "$YONDER_SRC/systemd/yonder-owner-setup.service" /etc/systemd/system/yonder-owner-setup.service
ensure_dir /etc/systemd/system/getty@tty1.service.d 0755
run cp "$YONDER_SRC/systemd/yonder-owner-getty.conf" /etc/systemd/system/getty@tty1.service.d/70-yonder-owner.conf
run install -m 0755 "$YONDER_SRC/installer/payload/yonder-owner-setup" /usr/local/sbin/yonder-owner-setup

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

    # The other half of the same post-condition. This unit carries
    # `Group=yonder` so the socket it binds is reachable by the console
    # (K-01), and a Group= naming an account that does not exist is
    # status=217/USER on every start — the same crash loop as a missing
    # ExecStart, arriving from a different field. 10-base.sh creates the
    # account; this is the check that it did.
    assert_unit_accounts "$yc_unit"

    if command -v service_enable >/dev/null 2>&1; then
        service_daemon_reload
        service_enable yonder-owner-setup.service
        service_enable yonder-admin.socket
        service_restart yonder-admin.socket
        service_enable yonder-core.service
        service_restart yonder-core.service
    elif [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl daemon-reload
        run systemctl enable yonder-owner-setup.service
        run systemctl enable yonder-admin.socket
        run systemctl restart yonder-admin.socket
        run systemctl enable yonder-core.service
        run systemctl restart yonder-core.service
    else
        log "skipping systemctl (dry run or not a systemd host)"
    fi
fi
