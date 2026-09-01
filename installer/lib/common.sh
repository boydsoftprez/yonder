# SPDX-License-Identifier: GPL-3.0-or-later
# Shared helpers for installer roles. Sourced, never executed.
# shellcheck shell=sh

: "${DRY_RUN:=0}"
: "${YONDER_PREFIX:=/opt/yonder}"
: "${YONDER_ETC:=/etc/yonder}"

APT_UPDATED=0

log()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Run a command, or print it when DRY_RUN=1.
run() {
    if [ "$DRY_RUN" = "1" ]; then
        printf '  + %s\n' "$*"
    else
        "$@" || die "command failed: $*"
    fi
}

# True when a package is already installed.
have_pkg() {
    dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'
}

# Refresh the package lists, at most once per run. A freshly debootstrapped
# chroot has no lists at all, so apt-get install has nothing to resolve
# against and fails before it installs anything.
apt_update_once() {
    if [ "$APT_UPDATED" = "1" ]; then
        return 0
    fi
    run env DEBIAN_FRONTEND=noninteractive apt-get update
    APT_UPDATED=1
}

# Install packages, skipping any already present. Idempotent.
ensure_pkgs() {
    missing=""
    for p in "$@"; do
        have_pkg "$p" || missing="$missing $p"
    done
    if [ -z "$missing" ]; then
        log "packages already present: $*"
        return 0
    fi
    apt_update_once
    log "installing:$missing"
    # shellcheck disable=SC2086
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing
}

ensure_dir() {
    if [ -d "$1" ]; then
        log "directory exists: $1"
    else
        run mkdir -p "$1"
    fi
    [ -n "${2:-}" ] && run chmod "$2" "$1"
    return 0
}

# A prebuilt Node.js distribution vendored at $YONDER_SRC/vendor/node, when
# present. Installing it lets a role satisfy its node dependency without
# `ensure_pkgs nodejs` touching the network — the same offline requirement
# that gives 20-yonder-core.sh a prebuilt-tree path for yonder-core itself.
# Copies the whole distribution (bin/, lib/, and the npm it carries) to
# $YONDER_PREFIX/node and prepends it to PATH for the rest of this run.
# Idempotent: re-running replaces any previously installed copy with
# whatever vendor/node currently holds.
#
# Returns 1 with nothing changed when there is no vendored node, so the
# caller falls back to ensure_pkgs nodejs.
install_bundled_node() {
    # shellcheck disable=SC2153 # YONDER_SRC is exported by install.sh, not a typo of YONDER_ETC
    vendor_node="$YONDER_SRC/vendor/node"
    [ -f "$vendor_node/bin/node" ] || return 1

    log "bundled node found at $vendor_node; installing to $YONDER_PREFIX/node, skipping ensure_pkgs nodejs"
    run rm -rf "$YONDER_PREFIX/node"
    run cp -r "$vendor_node" "$YONDER_PREFIX/node"
    PATH="$YONDER_PREFIX/node/bin:$PATH"
    export PATH
    return 0
}

# The major version of the node on PATH, or nothing if there is no node.
node_major() {
    command -v node >/dev/null 2>&1 || return 0
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true
}

# Refuse to build against a node older than yonder-core supports. The distro
# package is whatever the release froze — bookworm's is 18 — while the daemon
# is ESM with NodeNext resolution and declares engines.node >= 20. Without this
# the install appears to succeed and the service fails at run time.
require_node() {
    want="$1"
    major=$(node_major)
    if [ -z "$major" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            log "no node here; a real run requires node $want or newer"
            return 0
        fi
        die "node was not installed; yonder-core needs node $want or newer"
    fi
    if [ "$major" -lt "$want" ]; then
        die "node $major is too old; yonder-core needs node $want or newer"
    fi
    log "node $major meets the minimum of $want"
}
