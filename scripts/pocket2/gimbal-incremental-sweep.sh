#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# A gimbal sweep in INCREMENTAL mode, ten degrees a step, with the guard on.
# The camera lies as it will be mounted; a hand stays near its power button. Stops at the
# first limit flag and never recentres from a flagged pose.
#   ./gimbal-incremental-sweep.sh          # yaw +-30 in 10 deg steps, then pitch -20/+15
LOG=/var/tmp/aoa
att() { sudo grep attitude $LOG/session.log | tail -1 | grep -oE "raw=.*" | python3 -c "
import sys,struct; raw=bytes.fromhex(sys.stdin.read().split('raw=')[1].strip()); p,r,y=struct.unpack_from('<hhh',raw,0)
print(f'pitch={p/10:6.1f} roll={r/10:5.1f} yaw={y/10:7.1f} limit=0x{raw[10]:02x}')"; }
frame() {  # frame <dyaw deg> <droll deg> <dpitch deg>  — incremental, 1.0 s
  python3 -c "import struct;print(struct.pack('<hhhBB',int($1*10),int($2*10),int($3*10),0x00,10).hex())"; }
limit() { sudo grep attitude $LOG/session.log | tail -1 | grep -oE "raw=.*" | python3 -c "
import sys; raw=bytes.fromhex(sys.stdin.read().split('raw=')[1].strip()); print(raw[10] & 0x07)"; }
step() { echo "4:0x14:$(frame $1 $2 $3):4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 3
  r=$(sudo grep -E "REFUSED|inject\[4:0x14" $LOG/session.log | tail -1 | grep -c REFUSED)
  printf '  step yaw%+5.1f roll%+5.1f pitch%+5.1f -> %s %s\n' "$1" "$2" "$3" "$(att)" "$([ "$r" = 1 ] && echo '(REFUSED by guard)')"
  if [ "$(limit)" != 0 ]; then echo "  LIMIT FLAG SET — stopping here, no recentre from this pose"; exit 2; fi; }
echo "=== recentre first (guard learns centre) ==="; echo "4:0x4c:0201:4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 4; echo "  $(att)"
echo "=== yaw, 10 deg increments ==="
for d in 10 10 10 -10 -10 -10 -10 -10 -10 10 10 10; do step $d 0 0; done
echo "=== pitch, 10 deg increments (down is negative) ==="
for d in -10 -10 10 10 10 -10; do step 0 0 $d; done
echo "=== recentre ==="; echo "4:0x4c:0201:4:0" | sudo tee -a $LOG/inject.txt >/dev/null; sleep 4; echo "  $(att)"
echo "=== guard refusals ==="; sudo grep REFUSED $LOG/session.log | tail -5 | cut -c1-120 | sed 's/^/  /'
