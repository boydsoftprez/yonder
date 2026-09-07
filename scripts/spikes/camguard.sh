#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Make the USB camera answer, or say why it cannot.
#
# The development board's camera wedges (K-51): it stops answering UVC
# negotiation, `VIDIOC_STREAMON` times out, and the `open()` that follows
# returns `Input/output error` while the device node still exists and `fuser`
# names no holder. A measurement taken across that transition reads zero and
# looks like an encoder fault, which is how the previous video spike lost two
# of its three rounds to wrong explanations.
#
# So every run in this directory brackets itself with this script. It proves
# the camera streams *before* the measurement rather than trusting that it did
# last time, and it reports the port's `power/control`, because K-46's fix is
# what makes any interval measured here worth quoting.
#
#   camguard.sh check    — exit 0 if the camera streams, 1 if it does not
#   camguard.sh ensure   — check, and on failure unbind/bind the port and recheck
#
# Configures nothing and leaves nothing behind.
set -u

DEV=${YONDER_CAM_DEV:-/dev/video0}
PORT=${YONDER_CAM_PORT:-1-1.3}

# A successful check is followed by a settle, because the check itself closes
# the device. An `open()` issued immediately after this gadget's previous
# holder let go returns `Input/output error` even though the port is healthy
# and `fuser` names nobody — observed on this board, and indistinguishable
# from the K-51 wedge if the caller does not wait.
SETTLE=${YONDER_CAM_SETTLE:-3}

streams() {
  timeout 15 v4l2-ctl -d "$DEV" --stream-mmap --stream-count=5 >/dev/null 2>&1 || return 1
  sleep "$SETTLE"
}

state() {
  printf 'power/control=%s ' "$(cat "/sys/bus/usb/devices/$PORT/power/control" 2>/dev/null || echo '?')"
  printf 'usbdev=%s' "$(cat "/sys/bus/usb/devices/$PORT/devnum" 2>/dev/null || echo '?')"
}

rebind() {
  # The K-51 recovery, in the order the fault needs: nothing may hold the node
  # while the device leaves the bus, or the rebind hands back a device that a
  # stale handle still refers to.
  echo "camguard: rebinding $PORT" >&2
  printf '%s' "$PORT" | sudo tee /sys/bus/usb/drivers/usb/unbind >/dev/null 2>&1
  sleep 3
  printf '%s' "$PORT" | sudo tee /sys/bus/usb/drivers/usb/bind >/dev/null 2>&1
  sleep 5
}

case "${1:-ensure}" in
  check)
    if streams; then echo "camguard: OK  $(state)"; exit 0; fi
    echo "camguard: WEDGED  $(state)" >&2; exit 1 ;;
  ensure)
    if streams; then echo "camguard: OK  $(state)"; exit 0; fi
    echo "camguard: wedged, recovering  $(state)" >&2
    rebind
    if streams; then echo "camguard: RECOVERED  $(state)"; exit 0; fi
    # A second attempt, because a rebind landing while the gadget on the other
    # end is still tearing down leaves it wedged again.
    rebind
    if streams; then echo "camguard: RECOVERED (second attempt)  $(state)"; exit 0; fi
    echo "camguard: STILL WEDGED after two rebinds  $(state)" >&2; exit 1 ;;
  *)
    echo "usage: camguard.sh [check|ensure]" >&2; exit 2 ;;
esac
