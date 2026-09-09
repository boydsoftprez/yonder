# QGroundControl video delivery — 2026-09-09

The Pocket 2 feed reached QGroundControl with low apparent frame rate and large
corrupted regions while the cheaper browser preview remained usable.

## Measurements

- Local reads of the existing Pi RTSP encodes showed approximately 30 fps,
  with 33 ms frame timestamp intervals. Main video consumed approximately
  4.1 Mb/s; preview approximately 0.5 Mb/s. These reads used loopback and added
  no cellular media traffic.
- QGroundControl's UDP receiver reports recorded 36 missing packets over 2,692
  expected packets between samples. Switching to TCP and disabling its Low
  Latency Mode improved the picture initially, but did not eliminate later
  congestion. Both settings changed, so this was not a TCP-only comparison.
- MediaMTX subsequently reported `reader is too slow`, repeatedly discarding
  queued video. TCP cannot retransmit data discarded before it is sent.
- The existing TCP connection had a persistent send queue and observed delivery
  below the main encode rate. This is delivery evidence, not an independent
  measurement of total LTE capacity.
- Eight DF pings at each payload size 1000, 1300, 1472 and 2700 bytes all arrived.
  A bounded peer-only MTU comparison verified TCP MSS changed from 2748 to 1228
  and back. Smaller MTU did not help this run: acknowledged throughput was
  approximately 2.15 Mb/s before, 0.78 Mb/s during, and 1.50 Mb/s after. The
  temporary route was removed and the original 2800-byte path MTU restored.
  The short sequential test does not isolate changing radio conditions.

## Encoder experiment and withdrawn correction

The main encoder accepted a 2,000,000 bit/s target, but kernel readback from
its existing file descriptor showed bitrate mode 0 (VBR), and a subsequent
local sample measured approximately 3.06 Mb/s at 30 fps. The target property
alone was insufficient evidence that the network budget was respected.

The candidate change to `video/pipeline.ts` supplied `video_bitrate_mode=1` (CBR) when starting or
retuning a V4L2 H.264 encoder. Both main and preview used it; Adaptive still adjusted the target. Existing
preview keyframe settings were preserved.

A separate 320×180, 15 fps hardware encoder test on the Pi verified startup
and retuning: kernel readback remained mode 1, and observed output changed
from approximately 402 kb/s at a 400 kb/s target to 200 kb/s at a 200 kb/s
target. Both intervals continued producing frames without a GStreamer bus
error. The retune emitted transient `Too old frames` warnings, which must not
be described as a completely warning-free transition. Switching the already
running production encoder from VBR to CBR was rejected, so production needs
a pipeline start using the new controls.

R-VID-07 and R-VID-08 own the bitrate contract. Pipeline, encoder-channel,
host and adaptation tests check launch and retune behavior. The local hardware
test proves the controls; production video quality and delivery still require
verification after the coordinated activation. External RTSP receiver feedback
is not yet connected to Yonder's Adaptive controller and remains a separate gap.


## Full-pipeline acceptance failure

The combined hardware pipeline did not remain operational after the candidate
was installed. The native USB source remained live, but the pipeline repeatedly
stopped receiving fresh frames and exited after its private accessory-media
connection closed. Raising the preview startup target from 100 to 500 kb/s did
not resolve it. No full-pipeline V4L2 error established the exact mechanism.

The CBR production change was therefore withdrawn and the previous pipeline
composition restored. The small synthetic test was insufficient evidence for
the full camera graph. Do not describe this experiment as a deployed fix, or
attribute every excess-byte sample uniquely to VBR mode. Restoring video takes
priority over further encoder experiments on the live device.

Ethernet was connected during this deployment, changing ZeroTier from the
cellular/public path to a direct LAN peer. Subsequent clear video or zero
server discards on Ethernet cannot establish that LTE delivery was repaired.
The camera-workflow owner retains the encoder-budget investigation; the
network-diagnostics task owns underlay throughput and routing investigation.
