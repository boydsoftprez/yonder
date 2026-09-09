# Pocket 2 USB recovery investigation — 2026-09-09

Requirements: R-CAM-15, R-CAM-11. This records inspection, not a successful wake or recovery.

## Recovered earlier research

The September 3 Claude research extracted DJI Mimo's native command table and
analysed its SDK with Ghidra. Its retained findings are in
[the original USB bench note](dji-pocket-2-over-usb.md).

The relevant recovered general commands are:

| Set / command | Native SDK name | Evidence and limitation |
|---|---|---|
| `0 / 00` | `dji_general_ping_req` | A 1 Hz ping sustained the live stream on the bench. |
| `0 / 0e` | `dji_general_heartbeat_req` | Its name alone does not establish live-view keepalive behavior; the bench received `e0`. |
| `0 / 0b` | `dji_general_set_reboot_device_req` | Identified, not verified on the Pocket 2. Reboot is not an established power-on operation. |
| `0 / 0c` | `dji_general_get_get_device_state_req` | Identified; it still needs an active command channel. |

These are commands inside the `49 57` channel of an established AOA session.
The camera is USB host, so they cannot be sent to wake a host which has not
configured the Pi's accessory endpoints. No verified USB power-on command was
found in the recovered material. The original temporary APK, extracted library
and decompiler-output files are no longer present at their recorded scratch
locations; the conversation retains the command-table output and findings.

Two earlier physical observations are particularly relevant:

- A dead ping sender caused video to stop, then the camera dropped the USB link
  after further silence. Fixing the sender restored sustained operation.
- Keeping the gadget absent for 45 seconds, then presenting the phone identity,
  produced a new handshake without a cable replug. Returning after only a
  second or two did not.

## Comparison with the failed deployment

The last deployment tore down FunctionFS at 03:42:13 BST and bound the new phone
at 03:42:19. The camera enumerated the accessory at 03:42:20, so this initial
reconnection did occur. Later cleanup at 03:42:40–42 logged endpoint-stop and
FIFO-flush timeouts. A phone retry was bound at 03:43:27.

The normal restart therefore did not preserve the earlier 45-second absence
rule. The subsequent failure-recovery path did wait 45 seconds, however, and
still did not regain the camera. The initial timing omission is real; it is
not proof of the initiating failure or of the camera's power state. Kernel
cleanup warnings alone do not identify why the replacement session stopped.

## Passive bus inspection

No core, network, camera, or USB restart was performed during this investigation.
A private, bounded tracing instance captured gadget events for ten seconds and
was then removed. It recorded zero gadget requests/completions or lifecycle
events during that interval; this is not a claim to have captured every physical
USB wire transition.

The controller reported `not attached`, speed `UNKNOWN`, and `is_otg=0`. Its
phone gadget was bound, endpoint 0 had an eight-byte setup request pending, and
bulk endpoints were inactive, as expected before AOA setup. Runtime power
management reported `unsupported`; an ordinary Linux autosuspend toggle is not
an established recovery mechanism here.

This places the current problem before DUML: the Pi is waiting for the camera's
host to enumerate it. The observations cannot distinguish a powered-off camera
from a stalled camera/USB-controller state.

## Recommended next step

One controlled, camera-only transport recovery is the useful next experiment:
release the owned FunctionFS helper, keep the gadget absent for at least the
previously measured 45 seconds, and observe the next enumeration and protocol
traffic with lifecycle tracing. Leave core/network services running and send no
unverified reboot, firmware, or gimbal commands. Stop after that bounded attempt
rather than loop blindly. This is a proposed experiment, not an operation that
has been performed or a proven power-on method.

For the implementation, preserve the disconnect interval across process
restarts and retain the initiating transport-failure reason in the journal.
Longer term, keeping the USB/keepalive owner independent of routine core/UI
restarts follows the separate camera-daemon boundary proposed in the original
research. Neither of these changes is implemented by this inspection note.
