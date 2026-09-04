#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Measure a pipeline's cost, and refuse to record it on a supply that does not
# hold (R-SYS-09).
#
# K-41 records this development board browning out: get_throttled=0x50000,
# three undervoltage events in the first two minutes of a boot, and spontaneous
# reboots. Every figure in the pipeline table in
# docs/hardware/usb-camera-on-a-pi-4.md was measured on a board in that state,
# so those numbers are a floor rather than a clean reading.
#
# This is what stops them being retaken badly. A dirty read before or after the
# run is a refusal to print a figure, not a warning beside one — a warning
# beside a number is a number somebody will copy into a table.
#
# The same rule covers everything else that could make a figure untrustworthy:
# a board with no vcgencmd, a pipeline that died before it was sampled, a
# sampling window that returned nothing. Each of those refuses. **Unreadable is
# not clean**, and there is no path through this script that prints a number
# with a caveat attached.
#
# Usage:
#   scripts/measure-pipeline.sh --label "preview branch, 640x360p15" -- gst-launch-1.0 ...
set -eu

DURATION=${DURATION:-60}
# The first seconds are USB negotiation, buffer fill and RTSP handshake.
# Averaging them in flatters the steady-state figure, so they are excluded from
# the window rather than merely sat through.
SETTLE=${SETTLE:-5}
LABEL="unlabelled"
while [ $# -gt 0 ]; do
    case "$1" in
        --label) LABEL=$2; shift 2 ;;
        --duration) DURATION=$2; shift 2 ;;
        --) shift; break ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done
[ $# -gt 0 ] || { echo "nothing to measure; give a pipeline after --" >&2; exit 2; }

command -v vcgencmd >/dev/null 2>&1 || {
    echo "this board does not expose vcgencmd, so the supply cannot be checked" >&2
    echo "refusing to record a figure that cannot be qualified" >&2
    exit 1
}

before=$(vcgencmd get_throttled)
[ "$before" = "throttled=0x0" ] || {
    echo "the supply was already not clean before the run: $before" >&2
    echo "refusing to measure. Fix the supply (K-41) and try again." >&2
    exit 1
}

# CPU time rather than ps's %cpu, because ps reports the mean since the process
# started and would carry the settle window back into every sample. Fields 14
# and 15 of /proc/<pid>/stat are utime and stime in clock ticks, counted across
# every thread of the process; the difference across a known wall interval is
# the steady-state share of one core.
TICKS=$(getconf CLK_TCK)
cpu_ticks() {
    # Field 2 is the executable name in parentheses and may itself contain
    # spaces or a ')', so the fixed-position fields are counted from after the
    # *last* ') '. utime and stime are then the 12th and 13th of what remains.
    read -r line < "/proc/$1/stat" || return 1
    rest=${line##*") "}
    # shellcheck disable=SC2086 # deliberate word split into positional fields
    set -- $rest
    # Guarded because `set -u` would otherwise abort on ${12} with no message,
    # and a process that vanished mid-read is a refusal, not a crash.
    [ $# -ge 13 ] || return 1
    echo $(( ${12} + ${13} ))
}
# Hundredths of a second of wall clock. /proc/uptime rather than `date`,
# because whole seconds would put a percent of error into a sixty-second
# window; the fraction is padded so a shorter one still scales.
wall_hundredths() {
    read -r up _ < /proc/uptime || return 1
    case "$up" in
        *.*) frac="${up#*.}00"; echo "${up%.*}${frac%"${frac#??}"}" ;;
        *)   echo "${up}00" ;;
    esac
}

log=$(mktemp)
# Keep what the pipeline said. A run that dies at its first frame is the case
# this most needs to explain, and it explains it on stderr.
"$@" >/dev/null 2>"$log" &
pid=$!
# shellcheck disable=SC2064 # $pid is wanted at trap-setting time, not later
trap "kill $pid 2>/dev/null || true; rm -f '$log'" EXIT INT TERM

refuse_dead() {
    echo "the pipeline was not running $1" >&2
    echo "refusing to record a figure for a pipeline that did not run. It said:" >&2
    sed 's/^/    /' "$log" >&2
    exit 1
}

sleep "$SETTLE"
kill -0 "$pid" 2>/dev/null || refuse_dead "after $SETTLE s of settling"
t0=$(cpu_ticks "$pid") || refuse_dead "when the window opened"
w0=$(wall_hundredths)

sleep "$DURATION"
kill -0 "$pid" 2>/dev/null || refuse_dead "at the end of the $DURATION s window"
t1=$(cpu_ticks "$pid") || refuse_dead "when the window closed"
w1=$(wall_hundredths)

temp=$(vcgencmd measure_temp)
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

elapsed=$(( w1 - w0 ))
[ "$elapsed" -gt 0 ] || {
    echo "the sampling window had no duration, so there is no rate to report" >&2
    exit 1
}
# ticks/TICKS = seconds of CPU; elapsed/100 = seconds of wall. As a percentage
# of one core that is (dticks * 100 / TICKS) / (elapsed / 100) * 100, in
# integer arithmetic with the multiplications first.
cpu=$(( (t1 - t0) * 10000 / TICKS / elapsed ))

# Last, so that a supply that went out during the run costs the figure rather
# than qualifying it.
after=$(vcgencmd get_throttled)
[ "$after" = "throttled=0x0" ] || {
    echo "the supply went out during the run: $after" >&2
    echo "refusing to record this figure. The number is real; the conditions were not." >&2
    exit 1
}

printf '%-52s  cpu %4s%% of one core  over %ss  %s  supply %s\n' \
    "$LABEL" "$cpu" "$(( elapsed / 100 ))" "$temp" "clean"
