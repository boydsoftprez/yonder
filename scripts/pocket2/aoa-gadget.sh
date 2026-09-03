#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Present this Pi to a camera as an Android phone, then as an AOA accessory.
#
#   sudo ./aoa-gadget.sh run        # phone stage, then accessory stage, logging
#   sudo ./aoa-gadget.sh teardown
#   SESSION_ARGS='--listen-only' sudo -E ./aoa-gadget.sh run   # accessory stage says nothing
#
# Two gadgets are prepared up front — 'phone' and 'acc' — each with its own
# FunctionFS instance and its userspace process already holding descriptors.
# Only one can be bound to the controller at a time, so the handover on AOA
# START is an unbind and a bind: a few milliseconds, well inside the window
# the camera allows for the phone to re-appear as an accessory.
#
# Needs the USB-C port in peripheral mode (see enable-gadget-mode.sh) and the
# Pi powered from the GPIO header, since USB-C is then the camera link.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CFS=/sys/kernel/config/usb_gadget
LOG=/var/tmp/aoa
UDC=$(ls /sys/class/udc 2>/dev/null | head -1 || true)

teardown_one() {   # teardown_one <name>
  local G=$CFS/$1
  [ -d "$G" ] || return 0
  echo "" > "$G/UDC" 2>/dev/null || true
  rm -f "$G/configs/c.1/ffs.$1" 2>/dev/null || true
  umount "/dev/ffs-$1" 2>/dev/null || true
  rmdir "$G/configs/c.1/strings/0x409" "$G/configs/c.1" "$G/functions/ffs.$1" "$G/strings/0x409" "$G" 2>/dev/null || true
}

teardown() { pkill -f aoa_stage.py 2>/dev/null || true; pkill -f aoa_session.py 2>/dev/null || true; teardown_one phone; teardown_one acc; teardown_one aoa; }

prepare() {   # prepare <name> <idVendor> <idProduct> <manufacturer> <product>
  local G=$CFS/$1
  mkdir -p "$G"; cd "$G"
  echo 0x$2 > idVendor; echo 0x$3 > idProduct
  echo 0x0200 > bcdUSB; echo 0x0100 > bcdDevice
  mkdir -p strings/0x409
  echo "$4" > strings/0x409/manufacturer; echo "$5" > strings/0x409/product; echo "0001" > strings/0x409/serialnumber
  mkdir -p configs/c.1/strings/0x409; echo "$1" > configs/c.1/strings/0x409/configuration
  echo 500 > configs/c.1/MaxPower
  mkdir -p "functions/ffs.$1"; ln -sf "$G/functions/ffs.$1" configs/c.1/
  mkdir -p "/dev/ffs-$1"; mount -t functionfs "$1" "/dev/ffs-$1"
}

case "${1:-run}" in
  teardown) teardown; echo "gadgets removed";;
  run)
    [ -n "$UDC" ] || { echo "no UDC: USB-C is not in peripheral mode (run enable-gadget-mode.sh peripheral and reboot)"; exit 1; }
    teardown; mkdir -p "$LOG"
    modprobe libcomposite usb_f_fs
    prepare phone 18d1 4ee1 "Google" "Pixel"
    prepare acc   18d1 2d00 "Android" "Android Accessory"
    # both processes write their descriptors now, before either gadget is bound
    python3 "$HERE/aoa_session.py" --ffs /dev/ffs-acc --logdir "$LOG" ${SESSION_ARGS:-} &
    ACC=$!
    python3 "$HERE/aoa_stage.py" --stage phone --ffs /dev/ffs-phone --logdir "$LOG" &
    PHONE=$!
    sleep 0.5
    echo "=== stage 1: an Android phone (18d1:4ee1) on $UDC. Plug the camera in now. ==="
    echo "$UDC" > "$CFS/phone/UDC"
    wait $PHONE                                   # exits 0 on AOA START
    echo "=== camera asked for accessory mode; swapping to 18d1:2d00 ==="
    cat "$LOG/accessory-strings.txt" 2>/dev/null || true
    # the phone process closed its FunctionFS on START, which already unbound the
    # gadget from the controller; an explicit unbind now reports ENODEV. Tolerate it.
    echo "" > "$CFS/phone/UDC" 2>/dev/null || true
    # the controller can report ENODEV for a moment after an unbind; retry rather than die
    for i in $(seq 1 30); do
      if echo "$UDC" > "$CFS/acc/UDC" 2>/dev/null; then echo "accessory bound after $i tries"; break; fi
      sleep 0.1
    done
    [ "$(cat "$CFS/acc/UDC")" = "$UDC" ] || { echo "accessory gadget failed to bind"; exit 1; }
    wait $ACC
    ;;
  *) echo "usage: $0 run | teardown   (SESSION_ARGS='--listen-only' to only record)"; exit 2;;
esac
