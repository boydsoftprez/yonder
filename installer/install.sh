#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Yonder installer. The single definition of a working system; images are
# produced by running this in a chroot rather than by hand.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
export YONDER_SRC="$HERE/.."
DRY_RUN=0
ONLY=""
IMAGE_MODE=0
IMAGE_HARDWARE_TEST=0
YONDER_TARGET=""

usage() {
    cat <<'EOF'
Usage: install.sh [options]

  --dry-run      print what would be done, change nothing
  --only ROLE    run a single role, for example --only 20-yonder-core
  --image        install into an image-building chroot without live operations
  --target NAME  image target: rpi, radxa-zero3w, or radxa-rock5c
  --hardware-test
                 opt in to the unqualified ROCK 5C bench-image path
  -h, --help     this message
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --only)    shift; [ $# -gt 0 ] || { usage; exit 2; }; ONLY="$1" ;;
        --image)   IMAGE_MODE=1 ;;
        --target)  shift; [ $# -gt 0 ] || { usage; exit 2; }; YONDER_TARGET="$1" ;;
        --hardware-test) IMAGE_HARDWARE_TEST=1 ;;
        -h|--help) usage; exit 0 ;;
        *)         printf 'unknown option: %s\n' "$1" >&2; usage; exit 2 ;;
    esac
    shift
done
export DRY_RUN IMAGE_MODE IMAGE_HARDWARE_TEST YONDER_TARGET

if [ "$IMAGE_MODE" = "1" ] && [ -z "$YONDER_TARGET" ]; then
    printf '%s\n' 'error: --image requires --target rpi, radxa-zero3w, or radxa-rock5c' >&2
    usage >&2
    exit 2
fi
if [ "$IMAGE_MODE" != "1" ] && [ -n "$YONDER_TARGET" ]; then
    printf '%s\n' 'error: --target is only valid with --image' >&2
    usage >&2
    exit 2
fi
case "$YONDER_TARGET" in
    ""|rpi|radxa-zero3w|radxa-rock5c) ;;
    *) printf 'error: unknown target: %s\n' "$YONDER_TARGET" >&2; usage >&2; exit 2 ;;
esac
if [ "$IMAGE_HARDWARE_TEST" = "1" ] \
    && { [ "$IMAGE_MODE" != "1" ] || [ "$YONDER_TARGET" != "radxa-rock5c" ]; }; then
    printf '%s\n' 'error: --hardware-test is only valid with --image --target radxa-rock5c' >&2
    usage >&2
    exit 2
fi

# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"
# shellcheck source=lib/services.sh
. "$HERE/lib/services.sh"
# shellcheck source=lib/seekerhd.sh
. "$HERE/lib/seekerhd.sh"

if [ "$IMAGE_MODE" = "1" ]; then
    target_file="$HERE/targets/$YONDER_TARGET.sh"
    [ -f "$target_file" ] || die "no installer target definition for $YONDER_TARGET"
    # shellcheck source=/dev/null
    . "$target_file"
    target_preflight
    if [ "$YONDER_TARGET" = "radxa-zero3w" ]; then
        seekerhd_validate_payload
    fi
    validate_image_payload "$YONDER_TARGET"
fi

[ "$DRY_RUN" = "1" ] || [ "$(id -u)" = "0" ] || die "must run as root (or use --dry-run)"

begin_package_service_suppression

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
