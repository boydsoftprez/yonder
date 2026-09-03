#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Exercise installer/lib/common.sh the way install.sh does: sourced into the
# running shell, with commands that actually execute.
#
# What it stands between: `--dry-run` and a board. A dry run proves the roles
# parse and that they call what they mean to call, and it proves nothing at all
# about what happens when one of those calls fails - `run` short-circuits to a
# `printf` before executing anything, so every failure path in this library is
# invisible to it. That gap shipped a defect: `run systemctl stop zerotier-one
# || true` in the ZeroTier role, which reads as "ignore a failure" and is not.
# `run` calls `die`, `die` calls `exit`, roles are *sourced* rather than run in
# a subshell, so `exit` ends the install and the `||` never runs. Two lines
# whose whole point was to be allowed to fail could abort an entire install,
# and nothing in this repository would have said so.
#
# The second defect it stands between is the opposite shape, and the reason
# the cases below run against a stub PATH. `try systemctl disable
# zerotier-one` never failed in the chroot an image is built in - systemctl
# answers "Running in chroot, ignoring request" and exits 0 - so `try` had
# nothing to report and the unit shipped enabled. A test that asks whether the
# command failed cannot see that. These ask which command was called and what
# was left on disk afterwards.
#
#     ./scripts/verify-installer-lib.sh
#
# Requires nothing but a POSIX shell.
set -u

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH='' cd -- "$HERE/.." && pwd)

pass=0
fail=0
ok()  { pass=$((pass + 1)); printf '  ok    %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$*"; }

# Each case runs in its own shell, because the defect under test is one that
# ends the shell: a case that failed inside this one would take the harness
# with it and report nothing.
case_out=$(mktemp "${TMPDIR:-/tmp}/yonder-lib.XXXXXX")
trap 'rm -f "$case_out"' EXIT

# Runs a snippet against the real library, and reports what it printed and
# what it exited with.
in_shell() {
    # `$0` inside the -c script is the repository path passed after it; `$1`
    # here is this function's own argument, interpolated into the script text.
    /bin/sh -c ". \"\$0/installer/lib/common.sh\"; $1" "$REPO" >"$case_out" 2>&1
    printf '%s' "$?"
}

printf '\n== installer/lib/common.sh\n'

status=$(in_shell "try false; printf REACHED")
if [ "$status" = "0" ] && grep -q REACHED "$case_out"; then
    ok "try: a command that fails does not end the install"
else
    bad "try: a failing command ended the shell (exit $status)"
    sed 's/^/      /' "$case_out"
fi

status=$(in_shell "try false")
if grep -q 'carrying on' "$case_out"; then
    ok "try: and it says which command it ignored"
else
    bad "try: a failure was ignored silently"
    sed 's/^/      /' "$case_out"
fi

status=$(in_shell "try true && printf RAN")
if [ "$status" = "0" ] && grep -q RAN "$case_out"; then
    ok "try: a command that succeeds still succeeds"
else
    bad "try: a successful command did not report success (exit $status)"
fi

status=$(in_shell "DRY_RUN=1 try systemctl stop zerotier-one; printf REACHED")
if grep -q '+ systemctl stop zerotier-one' "$case_out" && grep -q REACHED "$case_out"; then
    ok "try: a dry run prints the command and runs nothing"
else
    bad "try: a dry run did not print what it would have run"
    sed 's/^/      /' "$case_out"
fi

# The other half of the pair, and the reason `try` had to exist: `run` really
# does end the install, and no `|| true` at the call site can change that.
status=$(in_shell "run false || true; printf REACHED")
if [ "$status" != "0" ] && ! grep -q REACHED "$case_out"; then
    ok "run: a failure ends the install, and '|| true' cannot intercept it"
else
    bad "run: a failing command did not end the install (exit $status)"
    sed 's/^/      /' "$case_out"
fi

# The role this was written for. Nothing here executes systemctl: `try` is
# given a command that is certain to fail on any machine, which is exactly the
# shape of `systemctl stop` in a chroot with no running systemd.
printf '\n== installer/roles/40-zerotier.sh\n'

if grep -q 'run systemctl.*|| true' "$REPO/installer/roles/40-zerotier.sh"; then
    bad "the role still uses 'run ... || true', which cannot ignore a failure"
else
    ok "the role does not use 'run ... || true'"
fi

if grep -qE '^[[:space:]]*try systemctl stop zerotier-one$' "$REPO/installer/roles/40-zerotier.sh"; then
    ok "stop is asked for with try, so a chroot cannot abort the install"
else
    bad "the role no longer stops the unit with try (R-VPN-08)"
fi

# `systemctl disable` is the defect, not the fix. It is a no-op in the chroot
# an image is built in, so the role must not reach for it at all.
if grep -qE '^[[:space:]]*(try|run)[[:space:]]+systemctl[[:space:]]+disable' "$REPO/installer/roles/40-zerotier.sh"; then
    bad "the role disables with systemctl, which does nothing in the chroot an image is built in (R-VPN-08)"
else
    ok "the role does not disable with systemctl"
fi

if grep -qE '^[[:space:]]*disable_unit_offline zerotier-one.service$' "$REPO/installer/roles/40-zerotier.sh" \
    && grep -qE '^[[:space:]]*assert_unit_disabled zerotier-one.service$' "$REPO/installer/roles/40-zerotier.sh"; then
    ok "the role disables offline and then checks that it worked (R-VPN-05, R-VPN-08)"
else
    bad "the role no longer disables the unit offline and asserts the result (R-VPN-05, R-VPN-08)"
fi

# Raised in review of PR #1: this installer is documented as idempotent and is
# re-run to upgrade, and 20-yonder-core restarts the daemon before this role
# runs. That daemon's start-up render enables and joins the configured mesh, so
# a role that then unconditionally stops the unit takes the mesh away from the
# operator upgrading over it — and nothing later re-renders. The ownership
# record is the same source of truth the renderer uses.
# shellcheck disable=SC2016  # the $zt_record is a literal to grep for, not a variable to expand
if grep -q 'zt_record=/var/lib/yonder/remote.json' "$REPO/installer/roles/40-zerotier.sh" \
    && grep -qE 'if \[ -f "\$zt_record" \]' "$REPO/installer/roles/40-zerotier.sh"; then
    ok "the role leaves a mesh yonder-core owns alone on a re-run (R-VPN-05, R-VPN-08)"
else
    bad "the role stops the unit unconditionally, so re-running the installer over a mesh drops it"
fi

# Which command gets called, recorded by the command itself. Nothing here is
# systemd: the stubs write their argv to a file and the case reads it, so the
# choice of mechanism is observable on a machine with no systemd at all.
printf '\n== disable_unit_offline\n'

stub=$(mktemp -d "${TMPDIR:-/tmp}/yonder-stub.XXXXXX")
called="$stub/called"
trap 'rm -f "$case_out"; rm -rf "$stub"' EXIT

make_stub() {
    cat >"$stub/$1" <<EOF
#!/bin/sh
printf '$1 %s\\n' "\$*" >>"$called"
exit ${2:-0}
EOF
    chmod +x "$stub/$1"
}

# The real deb-systemd-helper's one load-bearing behaviour, and the one a
# plain always-succeeds stub cannot exercise: it refuses to do anything at
# all unless DPKG_MAINTSCRIPT_PACKAGE is set, and says so on stderr with exit
# 1 - verbatim what a real board answered when this role called it without
# that variable, leaving the unit enabled with `try` reporting nothing worse
# than a carried-on failure. A stub that always exits 0 would pass whether or
# not disable_unit_offline sets the variable, which is exactly how the
# regression this guards against shipped unnoticed. This one records argv
# only when the gate is satisfied, so a case that forgets the variable sees
# an empty $called rather than a false pass.
make_dsh_stub() {
    cat >"$stub/deb-systemd-helper" <<EOF
#!/bin/sh
if [ -z "\${DPKG_MAINTSCRIPT_PACKAGE:-}" ]; then
    printf '%s\\n' "/usr/bin/deb-systemd-helper was not called from dpkg. Exiting." >&2
    exit 1
fi
printf 'deb-systemd-helper %s (DPKG_MAINTSCRIPT_PACKAGE=%s)\\n' "\$*" "\$DPKG_MAINTSCRIPT_PACKAGE" >>"$called"
exit 0
EOF
    chmod +x "$stub/deb-systemd-helper"
}

make_dsh_stub
make_stub systemctl

: >"$called"
status=$(in_shell "PATH=\"$stub:\$PATH\"; disable_unit_offline zerotier-one.service")
if [ "$status" = "0" ] \
    && grep -q '^deb-systemd-helper disable zerotier-one.service (DPKG_MAINTSCRIPT_PACKAGE=zerotier-one)$' "$called" \
    && ! grep -q '^systemctl' "$called"; then
    ok "disables with deb-systemd-helper, the offline mechanism the postinst enabled with"
else
    bad "disable_unit_offline did not call deb-systemd-helper (exit $status)"
    sed 's/^/      called: /' "$called"
    sed 's/^/      /' "$case_out"
    grep -q 'was not called from dpkg' "$case_out" \
        && printf '      (this is the board defect: DPKG_MAINTSCRIPT_PACKAGE was not set, R-VPN-08)\n'
fi

# PATH is the stub directory alone, so deb-systemd-helper is genuinely absent
# whatever this machine happens to carry. disable_unit_offline needs no
# external command to reach its decision.
: >"$called"
rm -f "$stub/deb-systemd-helper"
status=$(in_shell "PATH=\"$stub\"; disable_unit_offline zerotier-one.service")
if [ "$status" = "0" ] && grep -q '^systemctl --root=/ disable zerotier-one.service$' "$called"; then
    ok "falls back to systemctl --root=/, which also needs no running systemd"
else
    bad "disable_unit_offline did not fall back to systemctl --root=/ (exit $status)"
    sed 's/^/      called: /' "$called"
    sed 's/^/      /' "$case_out"
fi
make_stub deb-systemd-helper

# The post-condition, against a filesystem laid out the way the package's
# postinst leaves one: the .wants symlink deb-systemd-helper enable writes.
printf '\n== assert_unit_disabled\n'

root="$stub/root"
wants="$root/etc/systemd/system/multi-user.target.wants"
enable_unit() {
    mkdir -p "$wants"
    ln -sf /usr/lib/systemd/system/zerotier-one.service "$wants/zerotier-one.service"
}
dirs="$root/etc/systemd/system $root/usr/lib/systemd/system"

# What the shipped installer did until this was fixed: a systemctl that
# ignores the request and exits 0, exactly as one does in a chroot. `try` sees
# success, and the unit is still enabled. This case fails against that code.
enable_unit
status=$(in_shell "YONDER_SYSTEMD_DIRS=\"$dirs\"; try true; assert_unit_disabled zerotier-one.service")
if [ "$status" != "0" ] && grep -q 'still enabled' "$case_out"; then
    ok "a disable that did nothing is caught, not reported as success (R-VPN-08)"
else
    bad "a unit left enabled passed the check (exit $status)"
    sed 's/^/      /' "$case_out"
fi

# And the real mechanism's effect: the symlink gone.
rm -f "$wants/zerotier-one.service"
status=$(in_shell "YONDER_SYSTEMD_DIRS=\"$dirs\"; assert_unit_disabled zerotier-one.service")
if [ "$status" = "0" ] && grep -q 'is disabled' "$case_out"; then
    ok "a unit nothing wants at boot passes"
else
    bad "a disabled unit did not pass the check (exit $status)"
    sed 's/^/      /' "$case_out"
fi

# A mask is more off, not less, and must not read as still enabled.
mkdir -p "$root/etc/systemd/system"
ln -sf /dev/null "$root/etc/systemd/system/zerotier-one.service"
status=$(in_shell "YONDER_SYSTEMD_DIRS=\"$dirs\"; assert_unit_disabled zerotier-one.service")
if [ "$status" = "0" ]; then
    ok "a masked unit is not mistaken for an enabled one"
else
    bad "a masked unit was reported as enabled (exit $status)"
    sed 's/^/      /' "$case_out"
fi
rm -f "$root/etc/systemd/system/zerotier-one.service"

# A dry run inspects nothing: it runs on a build machine with no board.
enable_unit
status=$(in_shell "DRY_RUN=1 YONDER_SYSTEMD_DIRS=\"$dirs\" assert_unit_disabled zerotier-one.service")
if [ "$status" = "0" ] && grep -q 'would check' "$case_out"; then
    ok "a dry run says what it would have checked and checks nothing"
else
    bad "a dry run did not hold off (exit $status)"
    sed 's/^/      /' "$case_out"
fi

printf '\n== result\n'
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
