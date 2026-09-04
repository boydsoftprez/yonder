#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Flip the Pi 4's USB-C port between host mode (default; also its power input)
# and peripheral mode (a USB device — needs power on the GPIO header).
#
#   sudo ./enable-gadget-mode.sh peripheral   # then reboot, powered via GPIO
#   sudo ./enable-gadget-mode.sh host         # put it back
#
# Raspberry Pi OS ships config.txt with dwc2 lines under [cm4]/[cm5] section
# filters that never apply to a Pi 4B — editing those changes nothing. This
# script owns one stanza of its own at the end of the file, which is under
# [all], and never touches the rest.
set -euo pipefail
CFG=/boot/firmware/config.txt
MODE=${1:?peripheral|host}
MARK='# yonder-pocket2-bench'
cp -n "$CFG" "$CFG.before-gadget" 2>/dev/null || true
# remove any stanza we added before
sed -i -E "/^$MARK/,+1d" "$CFG"
if [ "$MODE" = peripheral ]; then
  printf '\n%s: USB-C as a USB device; board powered from the GPIO header\ndtoverlay=dwc2,dr_mode=peripheral\n' "$MARK" >> "$CFG"
  echo "USB-C will be a USB device after reboot."
  echo "POWER THE PI FROM THE GPIO HEADER BEFORE REBOOTING: USB-C will no longer be a power input."
else
  echo "USB-C returns to its default (host/power) after reboot."
fi
tail -3 "$CFG" | sed 's/^/  /'
echo "Backup of the original at $CFG.before-gadget"
