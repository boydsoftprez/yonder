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
# So the client ships installed and off. yonder-core starts it when, and only
# when, a network id is configured, and stops it again on leave (R-VPN-05,
# R-VPN-08). Nothing else will: the renderer acts only on a client it has a
# record of starting, and on a freshly flashed image it has none, so a unit
# left enabled here is left enabled for ever.
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
# ...but only where nothing has claimed it yet.
#
# Raised in review of PR #1. This installer is documented as idempotent and is
# re-run to upgrade. Roles run in order, so 20-yonder-core has already
# restarted the daemon by the time this one executes, and that daemon's
# start-up render enables and joins whatever mesh the configuration names. This
# role then stopped it, disabled it, and no later role re-renders — so an
# operator upgrading a device *over* its mesh lost the mesh, and it stayed down
# until the next apply or reboot. The same irony as K-37: the tool for reaching
# a device is what takes it away.
#
# The ownership record is the same source of truth the renderer uses: it exists
# only when yonder-core started this client, so its presence means the daemon
# owns the service and this role must keep its hands off. Absent — a fresh
# flash, or a device with no mesh — and "installed and off" applies.
zt_record=/var/lib/yonder/remote.json
if [ -f "$zt_record" ]; then
    log "yonder-core owns zerotier-one (a mesh is configured); leaving it running"
else
    log "stopping and disabling zerotier-one until a network is configured"
    try systemctl stop zerotier-one
    disable_unit_offline zerotier-one.service
    assert_unit_disabled zerotier-one.service
fi
