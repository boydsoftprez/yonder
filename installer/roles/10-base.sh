# SPDX-License-Identifier: GPL-3.0-or-later
# Base system packages and the directories Yonder owns.
# shellcheck shell=sh

ensure_pkgs ca-certificates curl
ensure_pkgs network-manager

# dnsmasq-base, explicitly. NetworkManager only *Recommends* it, and every
# apt-get in this installer passes --no-install-recommends, so on a base image
# where this installer is what brings NetworkManager in, it does not arrive.
#
# `ipv4.method shared` — how the access point serves addresses — is
# NetworkManager starting its own dnsmasq. Without this package the access
# point comes up and is visible, no client is ever given an address, the
# console is unreachable, and the fallback watchdog's only action is to raise
# that same access point again (R-NET-02).
ensure_pkgs dnsmasq-base

# mDNS, so the device answers to a name and not only to an address.
#
# This is what stands behind the one instruction an operator needs after they
# join a Wi-Fi network from the console: the access point goes away, the board
# takes a DHCP address on the new network, and they have to find it again.
# avahi-daemon publishes the system hostname — which yonder-core's
# HostnameRenderer sets from `system.hostname` — as `<hostname>.local`.
#
# **What this does not guarantee is that the operator's device can resolve
# it.** That needs an mDNS resolver on their side. macOS and iOS have always
# had one; Windows has had one since Windows 10; Android's support has varied
# by version and by app. Yonder cannot test any of that from here, so the
# console's own wording says the name *may* work and gives the address as the
# answer that always does. A printed instruction that does not work costs an
# operator the time to discover it is wrong.
#
# libnss-mdns is deliberately not installed. It would let *this* board resolve
# other .local names, which nothing here needs, and it edits nsswitch.conf —
# a change to name resolution on a device whose reachability is the thing this
# project is most careful about.
ensure_pkgs avahi-daemon

if [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
    # Enabled and started, like every other unit here: enabling alone arms the
    # next boot, and R-CFG-08 says a freshly flashed board is usable with no
    # operator input.
    run systemctl enable avahi-daemon.service
    run systemctl restart avahi-daemon.service
else
    log "skipping systemctl for avahi-daemon (dry run or not a systemd host)"
fi

# The modem service, from Debian.
#
# ZeroTier needed an offline payload, a pinned fingerprint and a signature
# check because it is not in Debian. This is: `modemmanager 1.24.0-1+deb13u1`
# in trixie/main, installed in the same chroot, with a network, as every other
# package here. None of that machinery applies.
#
# It is what makes a modem visible at all. Without it a board with a modem
# plugged in has a `wwan0` link that NetworkManager cannot see and does not
# list - inert rather than broken, and with nothing saying so.
ensure_pkgs modemmanager

# The account the console runs as, and the group that is the access control
# on the daemon's socket.
#
# yonder-core stays root: it drives NetworkManager, and nothing about that is
# safe to drop privileges for. The console is the opposite — it is the
# internet-adjacent surface, it runs unprivileged, and it must still be able
# to open /run/yonder/core.sock to ask the daemon a question. A shared group
# is what expresses that: yonder-core carries `Group=yonder` so systemd
# creates /run/yonder as root:yonder 0750 and the socket inherits the group,
# and the console runs as a user in it (K-01, R-SEC-04).
#
# Created here rather than in 30-console.sh because yonder-core names the
# group and yonder-core installs first. A unit naming an account that does
# not exist fails at step USER with status=217 on every start, which for
# yonder-core means a board with no network at all.
#
# Idempotent: re-running the installer must not fail on an account that is
# already there, so each is tested for before it is created. `getent` is the
# test rather than a grep of /etc/passwd, because the account may come from
# somewhere other than a file.
#
# --system, so the account gets a UID below the login range and no ageing
# information; no login shell and no home directory of its own — /var/lib/
# yonder already exists and is created below.
if getent group yonder >/dev/null 2>&1; then
    log "group yonder already exists"
else
    log "creating the system group yonder"
    run groupadd --system yonder
fi

if getent passwd yonder >/dev/null 2>&1; then
    log "user yonder already exists"
else
    log "creating the system user yonder"
    run useradd --system --gid yonder --home-dir /var/lib/yonder \
        --no-create-home --shell /usr/sbin/nologin \
        --comment "Yonder console" yonder
fi

# 0750, not 0755: this directory holds secrets.yaml. The file is 0600, but a
# world-readable directory still tells anyone with a shell what is in it.
ensure_dir "$YONDER_ETC" 0750
ensure_dir /var/lib/yonder 0750

# root:yonder, not root:root. The console's own state directory lives under
# this one, and 0750 root:root is a directory the yonder user cannot even
# traverse - so the console could not open its own userDir and Node-RED would
# fail to start. Set here rather than left to systemd: `StateDirectory=yonder`
# on yonder-core.service would arrive at the same ownership, but only once
# that unit has started, and the console must not depend on the order two
# services happened to come up in.
#
# Still 0750, so the group can read and traverse and nobody else can. The
# secrets this device holds are in /etc/yonder, which stays root-only.
if getent group yonder >/dev/null 2>&1 || [ "$DRY_RUN" = "1" ]; then
    run chgrp yonder /var/lib/yonder
fi
ensure_dir "$YONDER_PREFIX" 0755

# Nothing here creates /etc/NetworkManager/dnsmasq-shared.d, and nothing
# should. NetworkManager passes --conf-dir at that directory every time it
# starts the dnsmasq behind `ipv4.method shared`, so it has to exist - but it
# arrives with the network-manager package installed above, and a board that
# served DHCP to a joined client confirmed it. Yonder writes nothing into it
# either way: the DHCP drop-in that used to live here was overridden by
# NetworkManager's own command line and has been removed (K-15).
