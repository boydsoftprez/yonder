# SPDX-License-Identifier: GPL-3.0-or-later
# Install the service that owns the serial port, from the offline payload,
# and leave it off. R-CFG-07, R-MAV-06, R-MAV-17.
# shellcheck shell=sh

# **15, and the number is the whole of one defect.**
#
# Roles are picked up by a plain `roles/*.sh` glob, so the prefix is the
# ordering, and this role has to run *before* 20-yonder-core.sh — which ends
# by restarting the daemon.
#
# yonder-core.service is `ProtectSystem=strict` with `ReadWritePaths`, and a
# unit's mount namespace is built **when the unit starts**. A directory
# created after that is not in the namespace the running daemon holds: it is
# there on the filesystem and read-only inside the service, for as long as
# that process lives. Creating /etc/mavlink-router from a 40-* role therefore
# left the very first render failing
#
#     EROFS: read-only file system, open '/etc/mavlink-router/main.conf.tmp'
#
# on a board where every check in this installer had passed — observed by
# hand on 2026-09-06, which is the only reason it is written down here rather
# than discovered again. Running before 20-yonder-core.sh means the directory
# exists before the namespace that has to contain it is built, and the
# daemon's own restart at the end of that role is what picks it up.
#
# 10 is the base system, 20 is the daemon, 30 is the console, 40 is optional
# hardware. 15 says what it is: a thing the daemon needs in place before it
# starts.

# First, and deliberately not inside the payload check below.
#
# This is where MavlinkRenderer writes main.conf (R-MAV-01, R-CFG-13), and it
# is named in yonder-core.service's ReadWritePaths with a leading `-` so a
# board flashed before this role existed still starts its daemon. The dash
# means "ignore if missing", and a missing directory is therefore not an
# error — it is a daemon that silently cannot write here at all.
#
# So the directory is created whether or not a router came with the payload.
# A board with no router still renders, still fails to start a service that
# is not installed, and reports that as the telemetry fault it is (R-MAV-16).
# What it must not do is report EROFS instead, which names the wrong problem
# and sends whoever reads it looking at systemd sandboxing rather than at an
# empty vendor directory.
#
# Root, 0755: the daemon runs as root, and nothing else reads this file. It
# holds ground-station addresses, not secrets — those stay in
# /etc/yonder/secrets.yaml at 0600 (R-CFG-04).
mr_conf_dir="$YONDER_MAVLINK_ETC"
mr_conf_dir_existed=0
[ -d "$mr_conf_dir" ] && mr_conf_dir_existed=1
log "$mr_conf_dir is where yonder-core generates the router's configuration"
ensure_dir "$mr_conf_dir" 0755

# Said once, at the moment it becomes true, because the failure it warns
# about is silent and the fix is not obvious. A running daemon keeps the
# namespace it started with; only a restart gives it this directory. The next
# role does exactly that, so a whole install needs no action — but
# `--only 15-mavlink-router` does, and that is the invocation somebody
# reaches for when they are fixing this by hand.
if [ "$mr_conf_dir_existed" = "0" ] && [ "$DRY_RUN" != "1" ] \
    && command -v systemctl >/dev/null 2>&1 \
    && systemctl is-active --quiet yonder-core.service 2>/dev/null; then
    log "yonder-core is running and was started before $mr_conf_dir existed, so it cannot write there yet;"
    log "  20-yonder-core.sh restarts it later in this run. Running this role alone needs: systemctl restart yonder-core"
fi

mr_src="$YONDER_SRC/vendor/mavlink-router"

# Not an error, exactly as 40-zerotier.sh treats a payload with no mesh
# client. R-CFG-08 says a freshly flashed device reaches a joinable, usable
# state regardless, and a device without a router is a device with a console,
# an access point and no telemetry — which is a fault the page reports
# (R-MAV-16), not an install to abandon halfway through.
if [ ! -d "$mr_src" ]; then
    log "no mavlink-router in the payload; skipping"
    log "  build one with: installer/make-payload.sh --arch <linux-arm64|linux-x64>"
    return 0
fi

mr_bin="$mr_src/mavlink-routerd"
mr_dest="$YONDER_MAVLINK_BIN"
[ -f "$mr_bin" ] || die "$mr_src exists but carries no mavlink-routerd"

# The pre-condition, before anything is copied anywhere.
#
# An x86-64 binary staged into an arm64 payload passes every other check this
# installer makes — the file is there, it is executable, its ExecStart names
# it — and fails on the board with `Exec format error`, status=203, on every
# start. Nothing else in this installer would say so, and the same mistake is
# possible for vendor/node today.
#
# Compared against a binary this root is demonstrably already running rather
# than against `uname -m`, which reports the *host* kernel's machine inside
# the chroot an image is built in and would fail every arm64 image built on
# an x86 machine. See elf_machine in lib/common.sh.
mr_have=$(elf_machine "$mr_bin")
[ -n "$mr_have" ] \
    || die "$mr_bin is not a little-endian ELF executable; the payload is not a payload"
mr_want=$(elf_machine "$YONDER_ELF_REFERENCE")
if [ -z "$mr_want" ]; then
    log "no ELF reference at $YONDER_ELF_REFERENCE to compare against; installing $(basename "$mr_bin") (ELF machine $mr_have) unchecked"
elif [ "$mr_have" != "$mr_want" ]; then
    die "$mr_bin is built for ELF machine $mr_have and this system runs $mr_want ($YONDER_ELF_REFERENCE);
the payload was staged for a different architecture, and the service would fail with Exec format error (203) on every start.
Rebuild it with: installer/make-payload.sh --arch <linux-arm64|linux-x64>"
else
    log "$(basename "$mr_bin") is built for ELF machine $mr_have, the same as $YONDER_ELF_REFERENCE"
fi

# Copy then rename, never a copy straight over the destination.
#
# This installer is re-run to upgrade, and on an upgrade the destination is a
# **running** executable: writing into it is ETXTBSY, "Text file busy", and
# the install stops. A rename replaces the directory entry instead, so the
# running router keeps its own inode and carries on.
#
# And it *should* carry on. Nothing here restarts the router onto the new
# binary, deliberately: an upgrade must not drop every ground station
# mid-flight to install a version of a program that is already working
# (R-MAV-06, and the K-37 irony that the tool for reaching a device is what
# takes it away). The new binary is picked up at the next restart — a reboot,
# a re-detection, or an apply that changes what is generated.
#
# `.new` is removed before this starts and after any step fails. Before,
# because a previous attempt that died between its `cp` and its `mv` — a
# full disk, a permissions problem, anything — leaves one behind, and
# nothing else in this role ever looks for it again. After, so a failure
# here does not leave an executable-looking stray file next to the real
# binary for whoever finds it next to wonder about. `run` turns a nonzero
# return from this function straight into `die`, so the cleanup has to
# happen inside the function — nothing runs afterward to do it.
mr_install_bin() {
    rm -f "$2.new"
    cp "$1" "$2.new" || { rm -f "$2.new"; return 1; }
    chmod 0755 "$2.new" || { rm -f "$2.new"; return 1; }
    mv "$2.new" "$2" || { rm -f "$2.new"; return 1; }
}

log "installing $(basename "$mr_bin") to $mr_dest"
run mr_install_bin "$mr_bin" "$mr_dest"

if [ -f "$YONDER_SRC/systemd/mavlink-router.service" ]; then
    run cp "$YONDER_SRC/systemd/mavlink-router.service" /etc/systemd/system/mavlink-router.service
else
    die "no unit at $YONDER_SRC/systemd/mavlink-router.service; the router would never be started by anything"
fi

# Post-conditions, before anything touches systemd. Checked against the copy
# systemd will actually read; on a dry run there is none, so the source it
# was copied from stands in — the same split 20-yonder-core.sh uses.
if [ "$DRY_RUN" = "1" ]; then
    mr_unit="$YONDER_SRC/systemd/mavlink-router.service"
else
    mr_unit=/etc/systemd/system/mavlink-router.service
fi
assert_unit_exec "$mr_unit" "$mr_dest"
# Names no User= or Group=, and says so out loud rather than by silence: the
# router runs as root because it opens a serial device and binds ports, and a
# reader of an install log should be told that rather than left to notice the
# absence of a line.
assert_unit_accounts "$mr_unit"

# Installed, and off.
#
# The R-VPN-08 precedent, for a different reason than ZeroTier's. There the
# harm was a client holding sessions with a vendor's root servers unasked;
# here it is the serial port. The router opens it and keeps it, and detection
# needs the same port — so a unit enabled at install would win that race at
# every boot, and yonder-core would adopt whatever port and speed the last
# generated configuration named instead of measuring the one now in front of
# it (R-MAV-17, R-MAV-16). On a freshly flashed board there is no generated
# configuration at all, and `Restart=on-failure` would turn that into a
# restart loop before the console ever came up.
#
# `disable_unit_offline` rather than `systemctl disable`, because an image is
# built in a chroot where systemctl's unit-file verbs answer "Running in
# chroot, ignoring request" and exit 0 — a success that did nothing, which is
# how M2a shipped an image with a mesh client enabled. See lib/common.sh.
#
# **Nothing here stops a running router**, and that is the difference from
# 40-zerotier.sh, which does. Disabling arms the next boot and leaves this
# one alone, so an operator upgrading a device that is carrying telemetry
# keeps carrying it. ZeroTier needs an ownership record to decide that;
# this role needs none, because it never asks the question — the only
# lifecycle verb it uses is the one that changes nothing about the process
# running now.
if [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
    run systemctl daemon-reload
else
    log "skipping systemctl daemon-reload (dry run or not a systemd host)"
fi

log "leaving mavlink-router disabled; yonder-core starts it, and only once a link has been found"
disable_unit_offline mavlink-router.service
assert_unit_disabled mavlink-router.service
