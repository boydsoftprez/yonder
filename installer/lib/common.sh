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

# The major.minor of the node on PATH, or nothing if there is no node.
node_version() {
    command -v node >/dev/null 2>&1 || return 0
    node -p 'process.versions.node.split(".").slice(0, 2).join(".")' 2>/dev/null || true
}

# Whether the node on PATH is at least <major>[.<minor>]. Silent; returns 1
# when it is too old and 2 when there is no node at all, so a caller can tell
# "wrong version" from "nothing to check".
node_at_least() {
    nal_want="$1"
    nal_want_major=${nal_want%%.*}
    case "$nal_want" in
        *.*) nal_want_minor=${nal_want#*.} ;;
        *)   nal_want_minor=0 ;;
    esac
    nal_have=$(node_version)
    [ -n "$nal_have" ] || return 2
    nal_have_major=${nal_have%%.*}
    nal_have_minor=${nal_have#*.}
    [ "$nal_have_major" -gt "$nal_want_major" ] && return 0
    [ "$nal_have_major" -lt "$nal_want_major" ] && return 1
    [ "$nal_have_minor" -lt "$nal_want_minor" ] && return 1
    return 0
}

# Refuse to build against a node older than the calling role supports. The
# distro package is whatever the release froze — bookworm's is 18 — while the
# daemon is ESM with NodeNext resolution and declares engines.node >= 20.
# Without this the install appears to succeed and the service fails at run
# time.
#
#     require_node <major>[.<minor>]
#
# A minor is accepted because one of the floors here needs one, and a
# major-only check was wrong in a way nothing downstream could catch. The
# console's generated settings.js is CommonJS that `require()`s an ES module;
# node supports that from **22.12**, and on 22.0 through 22.11 it throws
# ERR_REQUIRE_ESM on every start. Node-RED's own floor is 22.9, so
# `require_node 22` admitted three releases — 22.9, 22.10, 22.11 — that pass
# every check this installer makes and produce a console that crash-loops on a
# board. The vendored payload is 24, so this only bites an install running on
# a distro node, which is exactly the install nobody tests before flying.
require_node() {
    want="$1"
    have=$(node_version)
    if [ -z "$have" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            log "no node here; a real run requires node $want or newer"
            return 0
        fi
        die "node was not installed; this step needs node $want or newer"
    fi
    node_at_least "$want" \
        || die "node $have is too old; this step needs node $want or newer"
    log "node $have meets the minimum of $want"
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

# Whether a tree carries a production dependency closure the daemon inside it
# could actually run from.
#
#     prebuilt_deps_present <tree>
#
# The test this replaces was `[ -d "$tree/node_modules" ]` — that the directory
# exists. A checkout that has ever run the test suite satisfies that with a
# node_modules holding nothing but a `.vite` cache, and copying it to a board
# produces a daemon that dies on its first import:
#
#     ERR_MODULE_NOT_FOUND: Cannot find package 'zod' imported from
#     /opt/yonder/packages/yonder-core/dist/schema/config.js
#
# Under Restart=always that is a permanent crash loop with no socket, no
# access point and no console — and the install that produced it reported
# success. So the question asked here is the one that matters: does every
# dependency this package declares actually resolve?
#
# Resolution is pinned *inside* the tree deliberately. These packages live in a
# workspace, so a checkout hoists the daemon's dependencies to the repository
# root, where a resolver allowed to walk upwards finds them and answers yes for
# a tree that ships none of them. The root node_modules is not what gets copied
# to the board; only this one is.
#
# node is the resolver rather than a directory listing because node is what
# will be asked the same question on the board, and it is already a hard
# dependency of the role that calls this. Without one — only possible on a dry
# run, since require_node dies otherwise — the tree cannot be judged, so it is
# not trusted, and the install-and-build path runs instead. That path is always
# correct; it only costs time.
#
# Returns 0 when the tree can be used as-is, 1 with the reason logged when not.
PREBUILT_DEPS_PROBE='
const { createRequire } = require("node:module");
const { readFileSync, statSync } = require("node:fs");
const { resolve, sep } = require("node:path");
const root = resolve(process.env.YONDER_TREE);
const manifest = root + sep + "package.json";
const deps = Object.keys(JSON.parse(readFileSync(manifest, "utf8")).dependencies || {});
const inside = root + sep + "node_modules" + sep;
const req = createRequire(manifest);
const missing = [];
for (const name of deps) {
  let where;
  try {
    where = req.resolve(name);
  } catch (e) {
    // A package whose exports map offers no require entry still ships a
    // package.json. The question is whether it is here, not how it is entered.
    try { statSync(inside + name + sep + "package.json"); where = inside + name; }
    catch (e2) { missing.push(name + " is not installed"); continue; }
  }
  if (!where.startsWith(inside)) missing.push(name + " resolves to " + where + ", outside the tree");
}
if (missing.length > 0) { console.error(missing.join("; ")); process.exit(1); }
'

prebuilt_deps_present() {
    pdp_tree="$1"
    if ! command -v node >/dev/null 2>&1; then
        log "no node here to check the dependency tree in $pdp_tree"
        return 1
    fi
    if pdp_why=$(YONDER_TREE="$pdp_tree" node -e "$PREBUILT_DEPS_PROBE" 2>&1); then
        return 0
    fi
    log "the node_modules in $pdp_tree is not a dependency tree the daemon could run from: $pdp_why"
    return 1
}

# The post-condition on the tree this installer has just installed: the entry
# point systemd is about to start, and every module it imports, actually load.
#
#     assert_module_graph <tree> <entry, relative to the tree> <node binary>
#
# The sibling of assert_unit_exec, one layer in. That check answers "is there
# an executable at the path ExecStart names"; this one answers "and can it get
# past its own imports". A tree missing its dependencies passes every check
# short of this one — the file named by ExecStart exists, the node binary
# exists, the daemon's entry point exists — and still fails at the first
# import, on a board, under Restart=always. Nothing before this could see that,
# because the only thing that can is node resolving the graph for real.
#
# Run against the installed copy with the node the unit names, not against the
# source tree with whatever node is on PATH: the pair systemd will use is the
# pair worth proving.
#
# No arguments are passed to node, on purpose. The daemon starts itself only
# when `import.meta.url` matches `process.argv[1]`, and with `node -e` and no
# arguments there is no argv[1] to match — so importing the entry point loads
# the whole graph and starts no server, binds no socket and touches no radio.
#
# The dry-run split follows assert_unit_exec: the check needs a real installed
# tree and a real node, and on a dry run there is neither, so it says what it
# would have checked.
MODULE_GRAPH_PROBE='
const { pathToFileURL } = require("node:url");
import(pathToFileURL(process.env.YONDER_ENTRY).href).catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
});
'

assert_module_graph() {
    amg_tree="$1"
    amg_entry="$2"
    amg_node="$3"
    if [ "$DRY_RUN" = "1" ]; then
        log "would check that $amg_tree/$amg_entry and everything it imports load under $amg_node"
        return 0
    fi
    [ -f "$amg_tree/$amg_entry" ] \
        || die "$amg_tree/$amg_entry was not produced; the service would not start"
    if amg_why=$(YONDER_ENTRY="$amg_tree/$amg_entry" "$amg_node" -e "$MODULE_GRAPH_PROBE" 2>&1); then
        log "$amg_entry and everything it imports load"
        return 0
    fi
    die "$amg_tree/$amg_entry cannot be loaded by $amg_node: $amg_why
the daemon would fail on its first import on every start, and under Restart=always that is a crash loop with no socket, no access point and no console"
}

# The post-condition on a unit that names an account: the account is there.
#
#     assert_unit_accounts <unit-file>
#
# The sibling of assert_unit_exec, one field over. That one answers "is there
# an executable at the path ExecStart names"; this one answers "and is there a
# user and a group for systemd to run it as". A `User=` or `Group=` naming an
# account that does not exist is not a warning — the service fails at step
# USER with status=217 before it executes anything, on every start, and under
# Restart=always that is a board that boots, fails and boots again for ever.
#
# For yonder-core that failure is total: no daemon means no render, so no
# access point, so no console and no way in at all. It is the same class of
# defect assert_unit_exec was written for and it is load-bearing against rule
# 6, which is why it is checked here rather than discovered after a flash.
#
# Split like assert_unit_exec, and for the same reason. Reading the unit is
# pure string work and happens on a dry run too, so a unit and the installer
# drifting apart is caught in CI on a machine with no systemd and no account
# database. Resolving the accounts needs the real system the service will
# start against, so on a dry run it says what it would have checked.
assert_unit_accounts() {
    aua_unit="$1"
    [ -f "$aua_unit" ] || die "$aua_unit is not there to check"

    # The first word of the value: systemd accepts `User=yonder` and a numeric
    # id equally, and either is something getent can be asked about.
    aua_users=$(sed -n 's/^User=[[:space:]]*\([^[:space:]]\{1,\}\).*/\1/p' "$aua_unit")
    aua_groups=$(sed -n 's/^Group=[[:space:]]*\([^[:space:]]\{1,\}\).*/\1/p' "$aua_unit")

    if [ -z "$aua_users" ] && [ -z "$aua_groups" ]; then
        log "$aua_unit names no User= or Group=; it runs as root"
        return 0
    fi

    if [ "$DRY_RUN" = "1" ]; then
        for aua_name in $aua_users; do
            log "would check that the user $aua_name exists (User= in $aua_unit)"
        done
        for aua_name in $aua_groups; do
            log "would check that the group $aua_name exists (Group= in $aua_unit)"
        done
        return 0
    fi

    # Stopping here is deliberate. The alternative to a check that cannot run
    # is not "no check": it is enabling a unit nobody has verified, which is
    # the crash loop this function exists to prevent. A loud failure during an
    # install, where the message can be read, beats a silent one on a board
    # that has already been fitted to an aircraft.
    command -v getent >/dev/null 2>&1 \
        || die "no getent here, so the accounts $aua_unit names cannot be checked; refusing to enable a unit that may fail at step USER (217) on every start"

    for aua_name in $aua_users; do
        getent passwd "$aua_name" >/dev/null 2>&1 \
            || die "$aua_unit runs as user '$aua_name', which does not exist; the service would fail at step USER (217) on every start"
        log "$aua_unit runs as user $aua_name, which exists"
    done
    for aua_name in $aua_groups; do
        getent group "$aua_name" >/dev/null 2>&1 \
            || die "$aua_unit runs as group '$aua_name', which does not exist; the service would fail at step USER (217) on every start"
        log "$aua_unit runs as group $aua_name, which exists"
    done
}

# The post-condition that would have caught the defect it exists for.
#
#     assert_daemon_can_write <unit-file> <path> [<path> ...]
#
# yonder-core.service runs ProtectSystem=strict, so the only paths it may
# write are the ones its ReadWritePaths names. The daemon's ConsoleRenderer
# writes settings.js and theme.css — and while those lived under /opt, every
# one of those writes was EROFS from inside the service.
#
# Nothing caught it, because the installer generates settings.js as root
# *outside* systemd, where the sandbox does not apply. So a fresh install
# reported success at every step, the console came up and served its setup
# page, and the failure appeared only when an operator set an administrator
# password: the daemon stored it, then could not rewrite the console to match.
#
#     could not restart the console after the password was set:
#     EROFS: read-only file system, open '/opt/yonder/console/public/theme.css.tmp'
#
# The daemon was provisioned and the console was not. The one page it served
# was the setup page, whose POST now answers 409, so it contradicted itself on
# screen — and the only way back in was to take the card out. Found on the
# first board this project ever installed on, by an operator clicking the one
# button the device offers.
#
# Static on purpose: it compares two files this repository ships, so it fails
# in CI, on a machine with no systemd and no board, rather than in a field.
assert_daemon_can_write() {
    adcw_unit="$1"
    shift
    [ -f "$adcw_unit" ] || die "no unit at $adcw_unit to check writable paths against"

    # Not sandboxed means not constrained, and nothing to check.
    if ! grep -q '^ProtectSystem=strict' "$adcw_unit"; then
        log "$(basename "$adcw_unit") is not ProtectSystem=strict; nothing constrains its writes"
        return 0
    fi

    adcw_roots=$(sed -n 's/^ReadWritePaths=//p' "$adcw_unit" | tr ' ' '\n' | grep -v '^$' || true)
    [ -n "$adcw_roots" ] \
        || die "$adcw_unit is ProtectSystem=strict and names no ReadWritePaths; it can write nothing at all"

    for adcw_want in "$@"; do
        adcw_ok=0
        for adcw_root in $adcw_roots; do
            case "$adcw_want" in
                "$adcw_root"|"$adcw_root"/*) adcw_ok=1; break ;;
            esac
        done
        if [ "$adcw_ok" != "1" ]; then
            die "$(basename "$adcw_unit") writes $adcw_want, but ProtectSystem=strict and ReadWritePaths only covers: $(echo "$adcw_roots" | tr '\n' ' ')
that write is EROFS from inside the service. The install would still succeed — the installer runs outside the sandbox — and the console would never leave setup mode."
        fi
        log "$adcw_want is inside $(basename "$adcw_unit")'s writable paths"
    done
}
