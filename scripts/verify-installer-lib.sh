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

if grep -q '^try systemctl stop zerotier-one$' "$REPO/installer/roles/40-zerotier.sh" \
    && grep -q '^try systemctl disable zerotier-one$' "$REPO/installer/roles/40-zerotier.sh"; then
    ok "installed and off is asked for with try, so a chroot cannot abort the install"
else
    bad "the role no longer stops and disables the unit with try (R-VPN-08)"
fi

printf '\n== result\n'
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
