#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Rate-mode (joystick) control: bursts of speed frames, watching the head move while they
# flow and stop when they stop. Guard on: 20 deg/s, stick deflection <= 400.
LOG=/var/tmp/aoa
att() { sudo grep attitude $LOG/session.log | tail -1 | grep -oE "raw=.*" | python3 -c "
import sys,struct; raw=bytes.fromhex(sys.stdin.read().split('raw=')[1].strip()); p,r,y=struct.unpack_from('<hhh',raw,0)
print(f'pitch={p/10:6.1f} roll={r/10:5.1f} yaw={y/10:7.1f} limit=0x{raw[10]:02x}')"; }
speed() { python3 -c "import struct;print(struct.pack('<hhhB',int($1*10),int($2*10),int($3*10),$4).hex())"; }   # yaw roll pitch flags
stick() { python3 -c "import struct;print(struct.pack('<HHHH',1024+($1),1024+($2),1024+($3),0).hex())"; }       # dyaw droll dpitch
burst() { echo "$1 x$2@100" | sudo tee -a $LOG/inject.txt >/dev/null; sleep $(python3 -c "print($2*0.1+2.5)"); }
echo "=== recentre ==="; echo "4:0x4c:0201:4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 4; echo "  $(att)"
echo "=== 0x0C custom speed: yaw +10 deg/s for 2 s (20 frames), flags 0x00 ==="
b=$(att); burst "4:0x0c:$(speed 10 0 0 0x00):4:0" 20; echo "  before: $b"; echo "  after:  $(att)"
echo "=== 0x0C: yaw -10 deg/s for 2 s ==="; burst "4:0x0c:$(speed -10 0 0 0x00):4:0" 20; echo "  after:  $(att)"
echo "=== 0x0C with flags 0x80 (control authority bit), yaw +10 deg/s 2 s ==="; burst "4:0x0c:$(speed 10 0 0 0x80):4:0" 20; echo "  after:  $(att)"
echo "=== 0x01 motion control: yaw stick +300 for 2 s ==="; burst "4:0x01:$(stick 300 0 0):4:0" 20; echo "  after:  $(att)"
echo "=== 0x01: yaw stick -300 for 2 s ==="; burst "4:0x01:$(stick -300 0 0):4:0" 20; echo "  after:  $(att)"
echo "=== 0x01: neutral stick for 1 s (should hold) ==="; burst "4:0x01:$(stick 0 0 0):4:0" 10; echo "  after:  $(att)"
echo "=== pitch up via whichever worked: 0x0C pitch +10 deg/s for 1 s, then 0x01 pitch stick +300 for 1 s ==="
burst "4:0x0c:$(speed 0 0 10 0x00):4:0" 10; echo "  after 0x0C: $(att)"; burst "4:0x01:$(stick 0 0 300):4:0" 10; echo "  after 0x01: $(att)"
echo "=== responses to the rate frames ==="; sudo grep -E "status=0x.*gimbal/0x(0c|01)" $LOG/session.log | tail -4 | cut -c1-110 | sed 's/^/  /'
echo "=== refusals ==="; sudo grep REFUSED $LOG/session.log | tail -3 | cut -c1-120 | sed 's/^/  /'
echo "=== recentre ==="; echo "4:0x4c:0201:4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 4; echo "  $(att)"
