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

# 0750, not 0755: this directory holds secrets.yaml. The file is 0600, but a
# world-readable directory still tells anyone with a shell what is in it.
ensure_dir "$YONDER_ETC" 0750
ensure_dir /var/lib/yonder 0750
ensure_dir "$YONDER_PREFIX" 0755

# NetworkManager passes --conf-dir at this directory every time it starts the
# dnsmasq behind `ipv4.method shared`, so it has to exist. Yonder no longer
# writes anything into it: the DHCP drop-in that used to live here was
# overridden by NetworkManager's own command line and has been removed
# (K-14). The directory comes with the network-manager package; created here
# anyway, because the cost is one mkdir and the cost of being wrong is an
# access point that hands out no addresses on a device whose only way in is
# that access point.
