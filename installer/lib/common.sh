# SPDX-License-Identifier: GPL-3.0-or-later
# Shared helpers for installer roles. Sourced, never executed.
# shellcheck shell=sh

: "${DRY_RUN:=0}"
: "${YONDER_PREFIX:=/opt/yonder}"
: "${YONDER_ETC:=/etc/yonder}"

# The one path the systemd unit's ExecStart names, and a symlink this
# installer points at whichever node the install actually resolved.
#
# Deliberately not overridable from the environment: it is half of a pair with
# `ExecStart=` in systemd/yonder-core.service, and a value the two halves can
# disagree about is the defect this constant exists to close. A bundled node
# installs to $YONDER_PREFIX/node/bin/node and a distro one to /usr/bin/node;
# systemd resolves neither, because a unit's ExecStart is an absolute path and
# systemd knows nothing of the PATH this installer sets for its own run. So
# the unit names a fixed path, and link_node makes that path mean the right
# thing on both install routes.
YONDER_NODE_LINK=/usr/local/bin/yonder-node

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

# Point $YONDER_NODE_LINK at the node this run resolved.
#
# The unit used to name /usr/bin/node directly, which is true only on the
# route that installs the distro package. On the offline route
# install_bundled_node unpacks a runtime to $YONDER_PREFIX/node and prepends
# it to PATH *for this script*; systemd inherits none of that, so the service
# hit `Unable to locate executable '/usr/bin/node'` and, under Restart=always,
# crash-looped for ever. One symlink at a fixed path makes both routes
# identical from systemd's point of view and depends on no PATH at all.
#
# Fails here, loudly, rather than leaving a unit that cannot start: an
# installer that reports success and hands back a device in a restart loop is
# worse than one that stops with the reason.
#
# Idempotent: the link is removed and recreated, so re-running the installer
# after switching between the bundled and the packaged node repoints it
# instead of failing on an existing file.
link_node() {
    node_bin=$(command -v node 2>/dev/null || true)
    if [ -z "$node_bin" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            log "no node here; a real run would link $YONDER_NODE_LINK -> the node it resolved"
            return 0
        fi
        die "no node on PATH to link at $YONDER_NODE_LINK; the service would not start"
    fi
    if [ "$DRY_RUN" != "1" ] && [ ! -x "$node_bin" ]; then
        die "$node_bin is not executable; refusing to point $YONDER_NODE_LINK at it"
    fi
    log "linking $YONDER_NODE_LINK -> $node_bin"
    ensure_dir "$(dirname "$YONDER_NODE_LINK")"
    # rm then ln, not `ln -sfn`: -n is not POSIX, and without it `ln -sf` on an
    # existing symlink-to-a-directory creates the link *inside* it.
    run rm -f "$YONDER_NODE_LINK"
    run ln -s "$node_bin" "$YONDER_NODE_LINK"
}

# The post-condition on a unit this installer has just written: the binary its
# ExecStart names is the one this installer prepared, and it can be executed.
#
#     assert_unit_exec <unit-file> [path ExecStart is expected to name]
#
# systemd resolves nothing for you. An ExecStart naming a path that is not
# there is `status=203/EXEC` on every start, and with Restart=always that is a
# board that boots, fails, and boots again for ever — discovered after the
# flash, on hardware, rather than here where the message can say what is
# wrong. This check is what would have caught that before the board booted.
#
# The two halves fail at different times on purpose. The expected-path
# comparison is pure string work, so it runs on a dry run too and catches the
# unit and the installer drifting apart in CI, on a machine with no systemd
# and no node. The executability check needs the real filesystem the service
# will start against, so on a dry run it says what it would have checked.
assert_unit_exec() {
    unit="$1"
    want_exec="${2:-}"
    # ExecStart may carry arguments; the executable is the first word. A
    # leading '-' or '@' modifier is not used by any unit here, so the first
    # word is the path.
    unit_exec=$(sed -n 's/^ExecStart=\([^ ]*\).*/\1/p' "$unit" | head -n 1)
    [ -n "$unit_exec" ] || die "$unit has no ExecStart; the service would not start"
    if [ -n "$want_exec" ] && [ "$unit_exec" != "$want_exec" ]; then
        die "$unit starts $unit_exec, but this installer prepares $want_exec; the unit and the installer have drifted apart"
    fi
    if [ "$DRY_RUN" = "1" ]; then
        log "would check that $unit_exec exists and is executable (ExecStart of $unit)"
        return 0
    fi
    [ -x "$unit_exec" ] || die "$unit starts $unit_exec, which is not an executable file; the service would fail at step EXEC (203) on every boot"
    log "$unit starts $unit_exec, which is executable"
}
