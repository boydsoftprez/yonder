# SPDX-License-Identifier: GPL-3.0-or-later
# Make an already-plugged modem visible, and leave the link off.
# shellcheck shell=sh

# The whole reason this role exists.
#
# ModemManager's udev rules ship inside the package, so any port that
# enumerated before the install carries no ID_MM_CANDIDATE and the service
# never looks at it. On a board with a modem already plugged in, `mmcli -L`
# answers "No modems were found" - indistinguishable from unsupported
# hardware - and the journal says nothing beyond starting.
#
# On a freshly flashed image this cannot happen: udev runs after the package
# is there. It happens on every upgrade of a device already in the field.
#
# The trigger is deliberately unfiltered. A trigger over tty, net and usb got
# the modem claimed and left the control port untagged, and ModemManager fell
# back to a modem whose primary port was ttyUSB2 (at) with wwan0 ignored -
# which is a modem with no data path but PPP. The control port lives in
# usbmisc, which a subsystem-filtered trigger does not reach.
if [ "$IMAGE_MODE" = "1" ]; then
    log "image mode: udev will discover modem ports on the target's first boot"
elif [ "$DRY_RUN" != "1" ] && command -v udevadm >/dev/null 2>&1; then
    run udevadm control --reload-rules
    run udevadm trigger
else
    log "skipping udev trigger (dry run or no udevadm)"
fi

if command -v service_enable >/dev/null 2>&1; then
    service_enable ModemManager.service
    service_restart ModemManager.service
elif [ "$DRY_RUN" != "1" ] && command -v systemctl >/dev/null 2>&1; then
    run systemctl enable ModemManager.service
    run systemctl restart ModemManager.service
else
    log "skipping systemctl for ModemManager (dry run or not a systemd host)"
fi

# And nothing else.
#
# Installing modem support is not configuring a modem. No connection is
# created and none is raised: a device carries no cellular link until
# config.yaml asks for one, and the renderer is the only thing that writes it
# (R-CFG-08).
log "modem support installed; no connection configured"
