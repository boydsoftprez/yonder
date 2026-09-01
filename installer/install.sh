#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Yonder installer. The single definition of a working system; images are
# produced by running this in a chroot rather than by hand.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
export YONDER_SRC="$HERE/.."
DRY_RUN=0
ONLY=""

usage() {
    cat <<'EOF'
Usage: install.sh [options]

  --dry-run      print what would be done, change nothing
  --only ROLE    run a single role, for example --only 20-yonder-core
  -h, --help     this message
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --only)    shift; [ $# -gt 0 ] || { usage; exit 2; }; ONLY="$1" ;;
        -h|--help) usage; exit 0 ;;
        *)         printf 'unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
    esac
    shift
done
export DRY_RUN

# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

[ "$DRY_RUN" = "1" ] || [ "$(id -u)" = "0" ] || die "must run as root (or use --dry-run)"

for role in "$HERE"/roles/*.sh; do
    [ -f "$role" ] || continue
    name=$(basename "$role" .sh)
    if [ -n "$ONLY" ] && [ "$name" != "$ONLY" ]; then
        continue
    fi
    step "$name"
    # shellcheck source=/dev/null
    . "$role"
done

step "done"
log "configuration: $YONDER_ETC/config.yaml"
