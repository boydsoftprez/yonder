#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Five mounted yaw-stop measurements, Task 2, R-CAM-11.
# Start aoa-gadget.sh with a fresh log directory first. --mounted-ready is an
# explicit bench precondition. A failed/flagged run exits without recentring.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
for run in 1 2 3 4 5; do
  python3 "$HERE/gimbal-stop-bound.py" "$@" recentre
  python3 "$HERE/gimbal-stop-bound.py" "$@" rate 10 2 yaw
done
python3 "$HERE/gimbal-stop-bound.py" "$@" recentre
