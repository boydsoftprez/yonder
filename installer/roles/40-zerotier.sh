# SPDX-License-Identifier: GPL-3.0-or-later
# Install the primary mesh client from the offline payload, and leave it off.
# shellcheck shell=sh

zt_src="$YONDER_SRC/vendor/zerotier"

# Not an error. A payload built without ZeroTier is a valid payload - the
# client is only needed by a device that will use a mesh - and R-CFG-08 says a
# freshly flashed device reaches a usable state regardless. So this role says
# what is missing and stops, rather than failing an install that is otherwise
# complete.
if [ ! -d "$zt_src" ]; then
    log "no zerotier in the payload; skipping"
    log "  build one with: installer/make-payload.sh --arch <linux-arm64|linux-x64>"
    return 0
fi

# shellcheck disable=SC2012
zt_deb=$(ls "$zt_src"/zerotier-one_*.deb 2>/dev/null | head -n 1)
[ -n "$zt_deb" ] || die "$zt_src exists but carries no zerotier-one .deb"

if command -v zerotier-cli >/dev/null 2>&1; then
    log "zerotier-one is already installed"
else
    log "installing $(basename "$zt_deb")"
    # apt-get, not dpkg -i: the three dependencies are all in Debian base and
    # already present on a stock board, but apt resolves them if they are not
    # and reports honestly if it cannot.
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y "$zt_deb" \
        || die "could not install $(basename "$zt_deb")"
fi

# The whole point of this role's last three lines.
#
# The package enables and starts itself, and a zerotier-one with *zero networks
# joined* still holds live sessions with ZeroTier's root servers - a board
# printed four of them, unprompted, moments after the package landed. A device
# that talks to a company's infrastructure because software is merely present
# contradicts the first thing this project claims about itself.
#
# So the client ships installed and off. The root durable-state projector
# starts it only when the captured, validated membership set is non-empty and
# stops it when that set becomes empty (R-VPN-05, R-VPN-08).
#
# `stop` keeps `try`, and needs it. `try`, not `run ... || true`: roles are
# sourced, so `die`'s `exit` inside `run` terminates the whole install and the
# `||` never sees it. Stopping a service that is not running, in a chroot with
# no systemd to ask, is a legitimate no-op and not worth an install for.
#
# `disable` does not, because on that same chroot systemctl answers "Running
# in chroot, ignoring request" and exits 0 - a success that did nothing, which
# `try` cannot report and which shipped an image that booted the client
# enabled. deb-systemd-helper is what the package's own postinst enabled the
# unit with, and it works with or without a running systemd; the assertion
# after it is what makes "installed and off" a checked claim rather than a
# hoped-for one. See lib/common.sh for both.
# Image assembly has no live helper. Package starts are suppressed there and
# the unit is disabled on disk; first boot lets yonder-admin generate and
# project the per-device identity before anything can join.
if [ "$IMAGE_MODE" = "1" ]; then
    log "stopping and disabling zerotier-one until first-boot state projection"
    service_stop zerotier-one.service
    service_disable zerotier-one.service
else
    # Role 20 starts the helper before this later role installs ZeroTier. A
    # fresh helper therefore observed no idtool and correctly bootstrapped a
    # null mesh. Restart it now: its fixed adapter captures an existing
    # upgrade identity or generates a fresh one offline, merges the configured
    # membership, and projects the service state from the checked generation.
    # This replaces remote.json, whose absence after the renderer cutover must
    # never be read as permission to stop a configured upgrade over its mesh.
    if command -v service_restart >/dev/null 2>&1; then
        service_restart yonder-admin.service
        if [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
            run systemctl is-active --quiet yonder-admin.service
        fi
    else
        die "the yonder-admin lifecycle helper is unavailable after installing zerotier-one"
    fi
    log "yonder-admin reconciled zerotier-one from canonical durable state"
fi
