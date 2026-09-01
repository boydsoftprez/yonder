# SPDX-License-Identifier: GPL-3.0-or-later
# Base system packages and the directories Yonder owns.
# shellcheck shell=sh

ensure_pkgs ca-certificates curl

ensure_dir "$YONDER_ETC" 0755
ensure_dir /var/lib/yonder 0750
ensure_dir "$YONDER_PREFIX" 0755
