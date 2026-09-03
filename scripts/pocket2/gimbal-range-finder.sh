#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Find the gimbal's usable range the safe way: 10-degree INCREMENTAL steps in one
# direction until the camera raises its limit flag, then step back the same way.
# Never commands past a flag, never recentres from a flagged pose.
# Needs the session started with --yaw-reach 250 --pitch-reach 110 (the step limit and
# the flag stop remain the protection).
LOG=/var/tmp/aoa
att() { sudo grep attitude $LOG/session.log | tail -1 | grep -oE "raw=.*" | python3 -c "
import sys,struct; raw=bytes.fromhex(sys.stdin.read().split('raw=')[1].strip()); p,r,y=struct.unpack_from('<hhh',raw,0)
print(f'pitch={p/10:6.1f} roll={r/10:5.1f} yaw={y/10:7.1f} limit=0x{raw[10]:02x}')"; }
limit() { sudo grep attitude $LOG/session.log | tail -1 | grep -oE "raw=.*" | python3 -c "
import sys; raw=bytes.fromhex(sys.stdin.read().split('raw=')[1].strip()); print(raw[10] & 0x07)"; }
frame() { python3 -c "import struct;print(struct.pack('<hhhBB',int($1*10),int($2*10),int($3*10),0x00,10).hex())"; }
nudge() { echo "4:0x14:$(frame $1 $2 $3):4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 2.5; }
refused() { sudo grep -c REFUSED $LOG/session.log; }
explore() {  # explore <axis: yaw|pitch> <sign +1|-1>
  local n=0 r0=$(refused)
  while [ $n -lt 30 ]; do
    if [ "$1" = yaw ]; then nudge $((10*$2)) 0 0; else nudge 0 0 $((10*$2)); fi
    n=$((n+1)); a=$(att); printf '    %s %+d x%-2d -> %s\n' "$1" "$2" "$n" "$a"
    if [ "$(limit)" != 0 ]; then echo "    LIMIT FLAG at $a"; break; fi
    if [ "$(refused)" != "$r0" ]; then echo "    guard refused — window edge"; break; fi
  done
  echo "    stepping back $n"
  for i in $(seq 1 $n); do if [ "$1" = yaw ]; then nudge $((-10*$2)) 0 0; else nudge 0 0 $((-10*$2)); fi; done
  echo "    back at: $(att)"
}
echo "=== recentre (learn centre) ==="; echo "4:0x4c:0201:4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 4; echo "  $(att)"
echo "=== yaw + ==="; explore yaw 1
echo "=== yaw - ==="; explore yaw -1
echo "=== pitch - (down) ==="; explore pitch -1
echo "=== pitch + (up) ==="; explore pitch 1
echo "=== final pose (no recentre if flagged) ==="; echo "  $(att)"
if [ "$(limit)" = 0 ]; then echo "4:0x4c:0201:4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 4; echo "  recentred: $(att)"; fi
