#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Flip the Pi 4's USB-C port between host mode (default; also its power input)
# and peripheral mode (a USB device — needs power on the GPIO header).
#
#   sudo ./enable-gadget-mode.sh peripheral   # then reboot, powered via GPIO
#   sudo ./enable-gadget-mode.sh host         # put it back
set -euo pipefail
CFG=/boot/firmware/config.txt
MODE=${1:?peripheral|host}
cp -n "$CFG" "$CFG.before-gadget" 2>/dev/null || true
sed -i -E "s/^dtoverlay=dwc2,dr_mode=(host|peripheral|otg)/dtoverlay=dwc2,dr_mode=$MODE/" "$CFG"
grep -nE '^dtoverlay=dwc2' "$CFG"
echo "USB-C will be in $MODE mode after reboot. Backup at $CFG.before-gadget"
[ "$MODE" = peripheral ] && echo "POWER THE PI FROM THE GPIO HEADER BEFORE REBOOTING: USB-C will no longer be a power input."
