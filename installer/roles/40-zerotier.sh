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

# The whole point of this role's last two lines.
#
# The package enables and starts itself, and a zerotier-one with *zero networks
# joined* still holds live sessions with ZeroTier's root servers - a board
# printed four of them, unprompted, moments after the package landed. A device
# that talks to a company's infrastructure because software is merely present
# contradicts the first thing this project claims about itself.
#
# So the client ships installed and off. yonder-core starts it when, and only
# when, a network id is configured, and stops it again on leave (R-VPN-05,
# R-VPN-08).
# `try`, not `run ... || true`: roles are sourced, so `die`'s `exit` inside
# `run` terminates the whole install and the `||` never sees it. Both of these
# legitimately fail where an image is built - a chroot with no running systemd
# answers neither - and neither is worth an install for.
log "stopping and disabling zerotier-one until a network is configured"
try systemctl stop zerotier-one
try systemctl disable zerotier-one
