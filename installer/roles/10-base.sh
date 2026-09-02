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

# Nothing here creates /etc/NetworkManager/dnsmasq-shared.d, and nothing
# should. NetworkManager passes --conf-dir at that directory every time it
# starts the dnsmasq behind `ipv4.method shared`, so it has to exist - but it
# arrives with the network-manager package installed above, and a board that
# served DHCP to a joined client confirmed it. Yonder writes nothing into it
# either way: the DHCP drop-in that used to live here was overridden by
# NetworkManager's own command line and has been removed (K-15).
