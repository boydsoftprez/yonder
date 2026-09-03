#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Confirm the rate command on the other axes and its stop-when-silent behaviour.
LOG=/var/tmp/aoa
att() { sudo grep attitude $LOG/session.log | tail -1 | grep -oE "raw=.*" | python3 -c "
import sys,struct; raw=bytes.fromhex(sys.stdin.read().split('raw=')[1].strip()); p,r,y=struct.unpack_from('<hhh',raw,0)
print(f'pitch={p/10:6.1f} roll={r/10:5.1f} yaw={y/10:7.1f} limit=0x{raw[10]:02x}')"; }
speed() { python3 -c "import struct;print(struct.pack('<hhhB',int($1*10),int($2*10),int($3*10),$4).hex())"; }
burst() { echo "$1 x$2@100" | sudo tee -a $LOG/inject.txt >/dev/null; sleep $(python3 -c "print($2*0.1+2.5)"); }
echo "=== recentre ==="; echo "4:0x4c:0201:4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 4; echo "  $(att)"
echo "=== 0x0C flags 0x80: pitch +10 deg/s for 1 s (expect +10 pitch) ==="; burst "4:0x0c:$(speed 0 0 10 0x80):4:0" 10; echo "  after: $(att)"
echo "=== 0x0C flags 0x80: pitch -10 deg/s for 1 s (back) ==="; burst "4:0x0c:$(speed 0 0 -10 0x80):4:0" 10; echo "  after: $(att)"
echo "=== 0x0C flags 0x80: yaw -10 deg/s for 2 s (expect -20 yaw) ==="; burst "4:0x0c:$(speed -10 0 0 0x80):4:0" 20; echo "  after: $(att)"
echo "=== a SINGLE 0x0C frame, yaw +10 deg/s, then silence 3 s (how long does one frame drive?) ==="
b=$(att); echo "4:0x0c:$(speed 10 0 0 0x80):4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 1.5; m=$(att); sleep 2; echo "  before: $b"; echo "  +1.5 s: $m"; echo "  +3.5 s: $(att)"
echo "=== yaw +10 deg/s and pitch +5 deg/s together, 1 s ==="; burst "4:0x0c:$(speed 10 0 5 0x80):4:0" 10; echo "  after: $(att)"
echo "=== recentre ==="; echo "4:0x4c:0201:4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 4; echo "  $(att)"
echo "=== refusals ==="; sudo grep -c REFUSED $LOG/session.log
