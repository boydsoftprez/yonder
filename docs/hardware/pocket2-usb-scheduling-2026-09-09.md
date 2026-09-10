# Pocket 2 USB scheduling investigation and correction

Requirements: R-CAM-15, R-CAM-11.

## Observed failure

Two recorded dropouts reported `Pocket 2 write confirmation timed out` for
DUML set 0 / command 0x0e. These were timeouts waiting for the FunctionFS helper's
completed-write notification, not missing DJI protocol replies. The driver
retired the USB generation and automatically reconnected; neither core nor
console restarted. The camera had supplied status shortly before each retirement.

## Reproduced software defect

The helper put completed-write notifications at the end of the same output FIFO
as video. Its bounded queue could therefore hold hundreds of kilobytes of video
in front of a control completion. Under parent-side backpressure, completion of
the physical USB write did not guarantee timely notification to the driver.
A regression against the old implementation reproduced that ordering with 30
maximum-size video chunks ahead of the completion. The corrected implementation
puts completions ahead of queued video while preserving any partially transmitted
JSON line and the order of completion notifications. It does not drop video bytes
or increase the queue limit.

A device-level regression feeds that actual helper queue through a slow consumer.
With the former FIFO order, `Pocket2Device` reports the same set-0/command-0x0e
confirmation timeout while valid camera traffic is still arriving. With priority
completion, the write succeeds and the USB generation stays live. The watchdog
allowance is identical in both cases.

The old bulk loop also performed synchronous FunctionFS reads and writes, using
signals to interrupt completion waits. `O_NONBLOCK` does not remove the kernel's
synchronous USB-completion wait. The Linux FunctionFS implementation also waits
for completion after interrupt-driven cancellation. See the
[Linux 6.18 FunctionFS implementation](https://github.com/torvalds/linux/blob/v6.18/drivers/usb/gadget/function/f_fs.c).

Bulk transfers now use Linux native AIO and eventfd. One read and one write may
be outstanding, so a waiting video read does not stop the helper processing
commands, lifecycle events or deadlines. Transfers retain their buffers until
kernel completion. Submission checks the original deadline again, including
partial writes; expiry cancels the queued write and retires the generation.
Cleanup unbinds before joining outstanding I/O and releasing buffers. The
existing core confirmation watchdog, admission guards and reconnect interval
remain unchanged. EP0 handshake handling remains separate.

## Evidence and limits

The intermittent live dropout did not recur in the controlled pre-update checks:
12 small EV changes, concurrent camera-page reads, two temporary video readers,
a metadata apply/revert, and two brief guarded low-rate gimbal checks completed
with the same USB generation. The temporary settings were restored and the test
readers closed. There was no current undervoltage alarm during those checks.

The initial report of 1.34-second reads from a ring-buffer trace was invalid:
per-CPU buffers had retained different time ranges. Restricting analysis to the
common complete interval yielded a maximum read of about 27 ms. That discarded
number is not evidence of the dropout's cause. A subsequent continuously drained
trace observed short USB command completions and no dropout before the operator
rebooted and moved networks. A separate strace capture observed one 132 ms read,
but tracing overhead limits what can be concluded from it.

Thus the completion-starvation mechanism is reproduced, and the synchronous
bulk-I/O coupling is removed; a single original field dropout has not been
captured end-to-end and uniquely attributed. Hardware verification of the new
helper must distinguish those facts from a claim that every USB fault is solved.

## Validation before installation

- 454 accessory tests passed, including the scheduling and buffer-lifetime suites.
- 24 Python helper tests and seven native-AIO adapter tests passed.
- Core build and packaged helper/module import checks passed.
- The production native-AIO module completed read/write operations through the
  Pi's actual aarch64 kernel using a temporary file, without touching the camera.

No new hardware, CPU underclock, weaker motion deadline, or larger watchdog
allowance is part of this change.

## Installed state

The two helper files were installed with a rollback copy, and only the owned
FunctionFS helper was restarted. Core, console, networking and the camera's
saved settings were left running. The camera enumerated successfully afterward;
the helper had its eventfd open and waited in the poll loop rather than a
synchronous bulk endpoint read. Native 720p video and exposure state returned.
The preview was started normally after the operator's preceding Pi reboot.

The full core suite subsequently passed: 3,387 tests. After adding the explicit
old-order/new-order watchdog comparison, the 42-test driver suite also passed.

Twelve live EV changes all received the expected readback with the same USB
generation. The five-minute USB observation retained that generation, but its
preview had video-only restarts while the Pi repeatedly reported active
undervoltage. Its final RTSP read therefore failed; that run is not a stable
preview pass. The operator confirmed the GPIO supply was connected. After a
subsequent reboot, the installed helper remained present and the power flags
were clear; preview validation was repeated in that state.

The clean-power repeat ran for 126.6 seconds with the same USB generation,
continuous native 720p input, zero preview restarts and `throttled=0x0` throughout.
A subsequent RTSP check decoded 30 frames successfully. The installed helper
survived the operator's reboot. These are bounded acceptance results for the
reproduced driver fault, not a claim that every historical dropout is attributed.
