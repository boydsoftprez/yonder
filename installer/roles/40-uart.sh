# SPDX-License-Identifier: GPL-3.0-or-later
# Give the flight controller the Pi's good UART, and take the login console
# and Bluetooth off it. R-MAV-02, R-HW-04.
# shellcheck shell=sh

# Two boot layouts. A Raspberry Pi's /boot/firmware holds config.txt and
# cmdline.txt (R-HW-01, R-HW-02); Armbian, which R-HW-03's Radxa boards run,
# holds one armbianEnv.txt u-boot reads (R-HW-04: which is decided by what
# is on disk, never by a board name). A root that carries neither is not a
# broken install to stop over — it is a target this role has nothing to do
# on, the same reasoning 40-zerotier.sh applies to a payload that was never
# built: say what is missing, and leave the rest of the install to finish.
if [ -f "$YONDER_ARMBIAN_ENV" ]; then
    # What the bench found on a Radxa Zero 3W, and what this arm reverses:
    # ttyS1 is Bluetooth's, UART2 is the boot console reached through the
    # FIQ debugger on ttyFIQ0, and every other UART is disabled in the device
    # tree. The image ships rk3568-uart2-m0.dtbo — compatible with
    # radxa,zero3; it enables uart2 and disables fiq_debugger — and only
    # user_overlays= resolves on this image: overlays= looks for
    # rk35xx-*.dtbo, of which there are none. See
    # docs/hardware/rockchip-video-shipped.md.
    ua_dtbo="$YONDER_DTB_OVERLAY_DIR/rk3568-uart2-m0.dtbo"
    ua_user="$YONDER_USER_OVERLAY_DIR/uart2-m0.dtbo"
    [ -f "$ua_dtbo" ] || die "no rk3568-uart2-m0.dtbo under $YONDER_DTB_OVERLAY_DIR; this image cannot free the header UART, and the autopilot would have no UART to answer on"
    ensure_dir "$YONDER_USER_OVERLAY_DIR" 0755
    if [ -f "$ua_user" ]; then
        log "$ua_user already present"
    else
        log "copying the UART2 overlay to $ua_user"
        run cp "$ua_dtbo" "$ua_user"
    fi

    # user_overlays= is a space-separated list; the token is added once, the
    # rest of the line and every other line left exactly as they were.
    ua_names_overlay() {
        # shellcheck disable=SC2020 # space and tab both mapped to newline, on purpose
        sed -n 's/^user_overlays=//p' "$1" | tr ' \t' '\n\n' | grep -qxF "$2"
    }
    ua_add_overlay() {
        awk -v tok="$2" '
            BEGIN { done = 0 }
            /^user_overlays=/ {
                rest = substr($0, 15)
                $0 = (rest == "" ? "user_overlays=" tok : "user_overlays=" rest " " tok)
                done = 1
            }
            { print }
            END { if (!done) print "user_overlays=" tok }
        ' "$1" > "$1.new" && mv "$1.new" "$1"
    }
    if ua_names_overlay "$YONDER_ARMBIAN_ENV" uart2-m0; then
        log "$YONDER_ARMBIAN_ENV already carries uart2-m0 in user_overlays"
    else
        log "adding uart2-m0 to user_overlays in $YONDER_ARMBIAN_ENV"
        run ua_add_overlay "$YONDER_ARMBIAN_ENV" uart2-m0
    fi

    # console=both and console=serial put a login console on UART2 at
    # 1500000 baud — the same two pins — and it would answer the autopilot.
    # console=display keeps tty1 and drops console=ttyS2 from the command
    # line. Only that one value is rewritten.
    ua_drop_serial_console() {
        sed -E 's/^console=(both|serial)$/console=display/' "$1" > "$1.new" && mv "$1.new" "$1"
    }
    if grep -Eq '^console=(both|serial)$' "$YONDER_ARMBIAN_ENV"; then
        log "setting console=display in $YONDER_ARMBIAN_ENV; R-NET-07's access point, not this port, is the way back into a board that will not boot"
        run ua_drop_serial_console "$YONDER_ARMBIAN_ENV"
    else
        log "$YONDER_ARMBIAN_ENV puts no serial console on the UART"
    fi

    # The getty the FIQ debugger's console carries. Disabled for the next
    # boot, not stopped now, for the reason the Pi arm gives below: this
    # install may be running from that very console.
    log "disabling the getty on ttyFIQ0 for next boot, without stopping it now"
    disable_unit_offline serial-getty@ttyFIQ0.service
    assert_unit_disabled serial-getty@ttyFIQ0.service

    if [ "$DRY_RUN" = "1" ]; then
        log "would check that $ua_user exists, that user_overlays names uart2-m0, and that no serial console remains"
    else
        [ -f "$ua_user" ] || die "$ua_user is not there; the overlay would not load"
        ua_names_overlay "$YONDER_ARMBIAN_ENV" uart2-m0 \
            || die "$YONDER_ARMBIAN_ENV does not name uart2-m0; the UART would stay the boot console's"
        if grep -Eq '^console=(both|serial)$' "$YONDER_ARMBIAN_ENV"; then
            die "$YONDER_ARMBIAN_ENV still puts a login console on the UART; it would answer the autopilot instead of mavlink-router"
        fi
        log "UART2 is staged for the autopilot, as /dev/ttyS2; it takes hardware effect at the next boot"
    fi
    return 0
fi

ua_cfg="$YONDER_BOOT_DIR/config.txt"
ua_cmdline="$YONDER_BOOT_DIR/cmdline.txt"
if [ ! -f "$ua_cfg" ] || [ ! -f "$ua_cmdline" ]; then
    log "no config.txt/cmdline.txt under $YONDER_BOOT_DIR and no $YONDER_ARMBIAN_ENV; neither boot layout, skipping"
    return 0
fi

# One marked stanza, owned outright — the discipline
# scripts/pocket2/enable-gadget-mode.sh already established for the USB-C
# port, applied here to the header pins instead. That script removes and
# re-appends its stanza on every run; this role instead checks for the
# marker and, once it is there, leaves it alone — the check-then-skip idiom
# the rest of this installer already uses (have_pkg; 40-zerotier.sh's
# "already installed"). Never rewriting the stanza once it is written is a
# stricter reading of "never touch the rest of the file" than removing and
# recreating it, and it carries no risk of a range-delete consuming one line
# too many, or too few, should this stanza ever grow a third.
ua_marker='# yonder-uart'
ua_line1='enable_uart=1'
ua_line2='dtoverlay=disable-bt'

ua_append_stanza() {
    printf '\n%s\n%s\n%s\n' "$ua_marker" "$ua_line1" "$ua_line2" >> "$1"
}

if grep -qxF "$ua_marker" "$ua_cfg"; then
    log "config.txt already carries the $ua_marker stanza"
else
    log "appending $ua_line1 and $ua_line2 to config.txt, under $ua_marker"
    run ua_append_stanza "$ua_cfg"
fi

# console=serial0[,<baud>] is a login console on the same two pins, and it
# answers the autopilot's traffic if it is left there — the exact thing this
# role exists to prevent. Matched without pinning the baud to 115200 so the
# same check holds against an image that ever ships a different one; only
# this one token is removed. Everything else on the line — root=,
# rootfstype=, the tty1 console that is not on these pins and stays — is
# left in exactly the order it was. What is not preserved, on a line where a
# removal actually happens, is the line's exact whitespace: every run of
# spaces or tabs comes out as one space, and any leading or trailing space is
# trimmed. cmdline.txt has no syntax in which that width carries meaning, so
# this is not a content change — but it is a real one, so it is stated here
# rather than left for a diff to discover.
ua_console_re='(^|[[:space:]])console=serial0(,[^[:space:]]*)?([[:space:]]|$)'

ua_strip_console() {
    # One sed pass over the whole line only ever removes alternating
    # occurrences: matching `\1...\3` folds the separator between two
    # adjacent console=serial0 tokens into the *first* match's trailing
    # group, leaving the second token with no leading separator left for it
    # to match — so it survives the pass. That is caught, not silently
    # accepted: the post-condition below runs this same regex again and dies
    # if anything is still there. Looping the removal instead of trusting
    # one pass reaches a fixed point rather than merely detecting the miss:
    # whichever occurrence is left-most on any given pass can never have had
    # its own leading separator consumed by an earlier match in that same
    # pass — nothing this regex could have touched precedes it — so every
    # pass removes at least one occurrence, and a cmdline.txt only ever
    # carries a couple to begin with.
    ua_stripped=$(cat "$1")
    while printf '%s\n' "$ua_stripped" | grep -Eq "$ua_console_re"; do
        ua_stripped=$(printf '%s\n' "$ua_stripped" | sed -E 's/'"$ua_console_re"'/\1\3/g')
    done
    ua_stripped=$(printf '%s\n' "$ua_stripped" \
        | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//; s/[[:space:]]+/ /g')

    # Every step checked, and the temporary removed on any failure — the
    # shape 15-mavlink-router.sh's own mr_install_bin already uses, and it
    # matters more here than it does there.
    #
    # This is the only thing on this branch that writes the boot partition,
    # and cmdline.txt is the one file on it a kernel cannot boot without:
    # lose `root=` and there is no root filesystem to mount, which is a board
    # that never comes up at all. R-NET-07's access-point fallback lives
    # inside yonder-core and cannot help a kernel that never reaches it, and
    # this role has just taken the serial console off the header pins, so
    # there is no way back in over those either.
    #
    # Unchecked, that is exactly what a full boot partition produced: /boot
    # /firmware is a small vfat, `printf` fails part-way through with ENOSPC,
    # `mv` renames the truncated file over the real one anyway, and `run`
    # reports success — `run`'s body is `"$@" || die`, and a `||` suppresses
    # `set -e` for the whole of the function it is testing, so nothing inside
    # here aborts on its own.
    printf '%s\n' "$ua_stripped" > "$1.new" || { rm -f "$1.new"; return 1; }
    mv "$1.new" "$1" || { rm -f "$1.new"; return 1; }
}

if grep -Eq "$ua_console_re" "$ua_cmdline"; then
    # What this trades away, stated here rather than left to be discovered: a
    # board that will not boot can no longer be questioned over these pins
    # with a USB-TTL adapter. R-NET-07's access-point floor is the designed
    # way back into an unreachable device and does not depend on this port —
    # see §2 of docs/superpowers/specs/2026-09-03-telemetry-plumbing-design.md,
    # which weighed this trade and made it before this role existed.
    log "removing console=serial0 from cmdline.txt; R-NET-07's access point, not this port, is the way back into a board that will not boot"
    run ua_strip_console "$ua_cmdline"
else
    log "cmdline.txt already carries no console=serial0"
fi

# The getty that would otherwise attach to ttyAMA0 the moment it exists, and
# the service that hands the PL011 to Bluetooth. Both are disabled for every
# boot after this one — disabling a unit only arms the *next* boot, and
# disable_unit_offline exists at all because deb-systemd-helper, the tool
# that does the disabling, refuses to run outside dpkg unless told which
# package it is acting for — a defect only a post-condition caught (see
# lib/common.sh).
#
# Unlike hciuart below, the getty is disabled but deliberately not also
# stopped now. On a board where ttyAMA0 is already the console UART before
# this role ever runs, an operator brought up over a USB-to-serial adapter —
# the tool of first resort before Wi-Fi or the mesh exist, and entirely
# plausible on a board's first bring-up — can be running this very install
# from a session whose controlling terminal *is* this getty. Stopping it
# synchronously would tear that session, and the install with it, down mid-
# run. Nothing is bought by taking that risk: enable_uart=1 and
# dtoverlay=disable-bt, both already written above, do not take hardware
# effect until a reboot, so the getty answering for the remainder of *this*
# boot changes nothing about when the autopilot actually gets the wire.
# Disabling it is already enough — there is nothing left on disk to start it
# at the next boot, which is the only boot this matters for.
log "disabling the getty on ttyAMA0 for next boot, without stopping it now: the UART does not change hands until that reboot, so nothing needs this session's own login prompt to die for it"
disable_unit_offline serial-getty@ttyAMA0.service
assert_unit_disabled serial-getty@ttyAMA0.service

log "stopping and disabling the Bluetooth UART attach service"
try systemctl stop hciuart.service
disable_unit_offline hciuart.service
assert_unit_disabled hciuart.service

# Post-condition: what this role wrote, not what the kernel has done with it.
#
# The obvious assertion is that /dev/ttyAMA0 exists, and it fails every image
# build: install.sh also runs in a chroot on a build host, where the board's
# UART does not exist and no overlay has been applied for want of a reboot —
# the same shape of mistake R-CAM-06 was withdrawn over, a board's own state
# resolved from a build host's instead. So this checks the configuration the
# role is actually responsible for: the stanza is in config.txt, complete,
# in the order this role writes it; the console is out of cmdline.txt. The
# getty and hciuart are already checked above, in place, the same way
# 20-yonder-core.sh and 30-console.sh check their own units before enabling
# anything. Physical availability is the daemon's question, after a reboot,
# and it is answered on the console as R-MAV-13's silent case rather than as
# an install failure.
if [ "$DRY_RUN" = "1" ]; then
    log "would check that config.txt carries the $ua_marker stanza and cmdline.txt carries no console=serial0"
else
    ua_want=$(printf '%s\n%s\n%s' "$ua_marker" "$ua_line1" "$ua_line2")
    ua_have=$(awk -v m="$ua_marker" '
        $0 == m { print; found = 1; left = 2; next }
        found && left > 0 { print; left--; next }
    ' "$ua_cfg")
    [ "$ua_have" = "$ua_want" ] \
        || die "config.txt does not carry an intact $ua_marker stanza; the autopilot would have no UART to answer on"
    log "config.txt carries the $ua_marker stanza, intact"

    if grep -Eq "$ua_console_re" "$ua_cmdline"; then
        die "cmdline.txt still carries console=serial0; a login prompt would answer the autopilot instead of mavlink-router"
    fi
    log "cmdline.txt carries no console=serial0"
fi
