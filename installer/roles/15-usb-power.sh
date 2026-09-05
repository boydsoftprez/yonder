# SPDX-License-Identifier: GPL-3.0-or-later
# Keep USB video devices out of runtime power management (R-CAM-19).
# shellcheck shell=sh

# **The bench camera was falling off the bus every few minutes, and this was
# why.** The kernel suspends an idle USB device two seconds after its last
# access, and a camera that nobody is streaming from is idle almost always.
# Measured on the development board: the camera's port spent 31% of one boot
# suspended, cycling in and out, and dropped four times in nine minutes. Each
# drop was a clean `USB disconnect` followed a quarter-second later by a clean
# re-enumeration — a failed resume, not a failing cable.
#
# The proof sat on the same hub the whole time. The modem's port carries
# `power/control=on` (ModemManager's own rules set it), has never spent a
# millisecond suspended, and has never once dropped. Same hub, same supply,
# same board: the device that suspends is the device that disappears.
#
# It cost hours of the wrong diagnosis — a power supply, a cable, a hub, a
# port — because every one of those is plausible from the symptom, and none of
# them touched the thing that was actually cycling the device.
#
# **This matters more in the air than on a bench.** A camera that drops on a
# desk is an annoyance; a camera that drops in flight takes the picture with
# it, and R-CAM-12's answer to *what happened* is that the device is simply
# no longer there.
#
# Matched on the video interface class rather than a vendor id, so it covers
# whatever camera an operator attaches rather than the one this was found on.
usb_rules=/etc/udev/rules.d/50-yonder-usb-video-power.rules

if [ "$DRY_RUN" = "1" ]; then
    log "would write $usb_rules"
else
    run mkdir -p /etc/udev/rules.d
    cat > "$usb_rules" <<'RULES'
# Written by the Yonder installer. See installer/roles/15-usb-power.sh.
#
# A UVC camera is idle whenever nothing is streaming from it, so runtime
# power management suspends it after two seconds and resumes it on the next
# access. Cameras that resume badly are dropped from the bus by the host,
# which reads as a cable fault and is not one (R-CAM-19).
ACTION=="add", SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{bInterfaceClass}=="0e", ATTR{power/control}="on"
ACTION=="add", SUBSYSTEM=="usb", DRIVERS=="uvcvideo", ATTR{power/control}="on"
RULES
    run chmod 0644 "$usb_rules"
fi

if [ "$DRY_RUN" != "1" ] && command -v udevadm >/dev/null 2>&1; then
    run udevadm control --reload-rules
    # Only the usb subsystem: 40-modem.sh explains why *its* trigger is
    # deliberately unfiltered, and that reasoning is about ModemManager's
    # tagging, not about this rule.
    run udevadm trigger --subsystem-match=usb
else
    log "skipping udev reload (dry run or no udevadm)"
fi
