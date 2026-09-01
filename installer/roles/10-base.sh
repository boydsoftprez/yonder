# SPDX-License-Identifier: GPL-3.0-or-later
# Base system packages and the directories Yonder owns.
# shellcheck shell=sh

ensure_pkgs ca-certificates curl

# 0750, not 0755: this directory holds secrets.yaml. The file is 0600, but a
# world-readable directory still tells anyone with a shell what is in it.
ensure_dir "$YONDER_ETC" 0750
ensure_dir /var/lib/yonder 0750
ensure_dir "$YONDER_PREFIX" 0755
