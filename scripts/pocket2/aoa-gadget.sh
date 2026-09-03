#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Present this Pi to a camera as an Android phone, then as an AOA accessory.
#
#   sudo ./aoa-gadget.sh run        # phone stage, then accessory stage, logging
#   sudo ./aoa-gadget.sh teardown
#
# Needs the USB-C port in peripheral mode (see enable-gadget-mode.sh) and the
# Pi powered from the GPIO header, since USB-C is then the camera link.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
G=/sys/kernel/config/usb_gadget/aoa
FFS=/dev/ffs-aoa
LOG=/var/tmp/aoa
UDC=$(ls /sys/class/udc 2>/dev/null | head -1 || true)

teardown() {
  [ -d "$G" ] || return 0
  echo "" > "$G/UDC" 2>/dev/null || true
  rm -f "$G/configs/c.1/ffs.aoa" 2>/dev/null || true
  umount "$FFS" 2>/dev/null || true
  rmdir "$G/configs/c.1/strings/0x409" "$G/configs/c.1" "$G/functions/ffs.aoa" "$G/strings/0x409" "$G" 2>/dev/null || true
}

present() {   # present <idVendor> <idProduct> <manufacturer> <product> <stage> [send-hex]
  teardown
  modprobe libcomposite usb_f_fs
  mkdir -p "$G"; cd "$G"
  echo 0x$1 > idVendor; echo 0x$2 > idProduct
  echo 0x0200 > bcdUSB; echo 0x0100 > bcdDevice
  mkdir -p strings/0x409
  echo "$3" > strings/0x409/manufacturer; echo "$4" > strings/0x409/product; echo "0001" > strings/0x409/serialnumber
  mkdir -p configs/c.1/strings/0x409; echo "aoa" > configs/c.1/strings/0x409/configuration
  echo 500 > configs/c.1/MaxPower
  mkdir -p functions/ffs.aoa; ln -sf "$G/functions/ffs.aoa" configs/c.1/
  mkdir -p "$FFS"; mount -t functionfs aoa "$FFS"
  if [ "$5" = accessory ]; then
    python3 "$HERE/aoa_session.py" --ffs "$FFS" --logdir "$LOG" ${SESSION_ARGS:-} &
  else
    python3 "$HERE/aoa_stage.py" --stage "$5" --ffs "$FFS" --logdir "$LOG" &
  fi
  PY=$!
  sleep 0.3                                   # descriptors must land before bind
  echo "$UDC" > UDC
  echo "presented as $1:$2 '$3 $4' (stage $5) on $UDC"
  wait $PY
}

case "${1:-run}" in
  teardown) teardown; echo "gadget removed";;
  run)
    [ -n "$UDC" ] || { echo "no UDC: USB-C is not in peripheral mode (run enable-gadget-mode.sh and reboot)"; exit 1; }
    mkdir -p "$LOG"
    echo "=== stage 1: an Android phone. Plug the camera in now. ==="
    present 18d1 4ee1 "Google" "Pixel" phone
    echo "=== camera asked for accessory mode; re-presenting as 18d1:2d00 ==="
    cat "$LOG/accessory-strings.txt" 2>/dev/null || true
    present 18d1 2d00 "Android" "Android Accessory" accessory
    ;;
  *) echo "usage: SESSION_ARGS='--listen-only' $0 run | teardown"; exit 2;;
esac
