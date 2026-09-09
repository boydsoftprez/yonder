# Pocket 2 USB recovery investigation — 2026-09-09

Requirements: R-CAM-15, R-CAM-11. This records inspection and one unsuccessful
camera-only recovery attempt; it does not establish a USB power-on method.

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

## Approved recovery attempt

The operator approved one camera-only recovery. Preflight checked the core
process, helper parent and command line, boot identity, and detached controller.
A process descriptor tied one SIGTERM to that exact FunctionFS helper. The
helper released its resources cleanly, and the existing core-owned recovery
path performed its delayed retry. Core, console, network and media services
remained active, with the same core process and boot identity throughout.

A private, bounded trace instance recorded gadget lifecycle and endpoint
enable/disable events during the 75-second observation. Its four events were
all Pi-side actions. The disconnect and subsequent connect both returned zero,
with **45.238246 seconds** between them on the same monotonic clock. The new
helper successfully bound the phone gadget, but the controller remained
`not attached`, with speed unknown. No host enumeration, fresh camera status,
attitude or video followed during the remaining approximately 30 seconds.

The corresponding kernel log showed normal FunctionFS cleanup and phone bind,
without the endpoint-stop/FIFO-flush timeouts seen in the earlier failed
deployment. It recorded no undervoltage event during this attempt; the current
alarm was zero, and the CPU maximum remained 1.8 GHz. These observations do not
establish the cause of the earlier failure.

The trace was saved and its private tracing instance removed. During that
observation there was no second retirement, controller reset, camera command,
gimbal movement, service restart or Pi reboot. The driver was left at the phone
stage, waiting for the camera to initiate enumeration.

The bounded attempt did not recover the camera. Its observations alone cannot
distinguish an off camera from a stalled camera host/controller.

## Physical return and subsequent write failures

The operator subsequently confirmed turning on or reconnecting the camera. The
camera enumerated again and eventually supplied fresh 720p video, native gimbal
status and normal microSD status. That return is not evidence of remote USB wake.
Starting the preview through the production API then decoded 30 actual frames.

The link later retired with the captured reason **`Pocket 2 write deadline
expired`**. The same reason was captured after another operator aiming attempt.
Core and console process identities stayed unchanged, and the current voltage
alarm was zero. Existing automatic recovery did restore fresh traffic between
these failures. This establishes an outstanding transport-write failure; it does
not yet identify whether USB completion or its IPC notification missed the bound.

The operator also reported a zoom-like picture jump and missing stick expo.
Browser measurements showed the image element changing from about 725 pixels
wide to 422 pixels as status/thumbnail layout changed, without a CSS transform
or a change from `object-fit: contain`. Browser-only fixes added radial stick
expo (0–100%, default 50%) and reserved notice/thumbnail space. The three affected
widget bundles were installed without restarting either service or the USB
helper, and the new slider was verified in the real browser. The picture remained
about 402 by 226 pixels when the next contact loss cleared the thumbnail report.
The UI correction does not claim to repair the separate write timeout.

A subsequent 55-second syscall trace observed 156 endpoint writes: 56 native
gimbal rate commands, 50 heartbeat commands and 50 pings. Every observed write
completed; the longest endpoint write took 2.119 ms. The helper remained alive
and the controller configured when the tracer detached. This was a healthy
interval, including tracer overhead; it did not reproduce the intermittent
failure or prove that the timeout was fixed. No motion command was originated
by the inspection script.

The operator then reported that maximum speed was too slow. The installed
driver and browser transport both enforced the initial 10°/s bench cap, while
[DJI rates the camera at 120°/s](https://www.dji.com/pocket-2/specs). A subsequent
change uses the published ceiling with a combined pan/tilt magnitude bound and
an independent browser speed selector, defaulting to 60°/s. Both the pad and
image drag share the selected speed and expo. The source and browser builds
passed, with 386 focused speed/control/presentation tests passing.

The operator approved installation. The first restart retained 45.000 seconds
of USB absence and regained the camera. A final entry-point check then found a
missed 10°/s limit in the request validator shared by the console and source.
That omission was corrected using the same rated ceiling; console-forwarding
and source-to-command tests now exercise 60°/s, 120°/s and diagonal requests,
plus over-cap refusal. The 195 focused boundary/source/guard/dispatcher tests
and core build passed. Completing the approved installation required an
additional, announced core and console restart with another 45.000-second USB
absence. Network services stayed active. The camera enumerated again.

After the completed installation, the preview decoded 30 frames. One 20°/s pan
request, held for 150 ms before release, was accepted through the production
source API and produced 12.614° of observed quaternion rotation by the final
sample. Release was accepted; admitted rates returned to zero, flags stayed
clear, and the same USB generation remained live. This verifies a command above
the former cap and its release, not a precise 20°/s physical-velocity measurement
or a higher-rate stopping-time bound. Full-speed physical stopping remains
unmeasured.

The real browser displayed a maximum-speed range of 1–120°/s set to the new
60°/s default, retained the operator's 100% expo preference, and showed advancing
640×360 preview video with the real thumbnail. CPU maximum remained 1.8 GHz
and the current voltage alarm was zero. The intermittent write deadline fault
is still unresolved; neither this short check nor the healthy syscall trace
establishes that it has been fixed.

## Completion-timing correction

Another `Pocket 2 write deadline expired` occurred during subsequent operator
use. Inspection found that the core used the physical-write expiry as the
deadline for receiving the helper's completion notification too. A regression
test reproduced retirement of an otherwise-live session when that notification
arrived after expiry. This establishes a software failure path; the earlier
healthy syscall trace did not capture the initiating failing write on hardware.

The correction gives the notification a separate, bounded one-second grace.
The original physical deadline is still sent unchanged to FunctionFS, which
enforces it at actual I/O and every partial-write continuation. A helper-reported
endpoint failure retires immediately. Missing confirmation still retires after
the bounded grace, and admission, intent expiry, single-write serialization and
USB generation invalidation remain in force. Failure records now retain the
command set/ID, original deadline, elapsed wait and last-traffic ages in the
journal without logging payloads or media.

Validation passed 451 accessory tests, 18 Python helper tests and 112 daemon
tests, plus the core build. The update was deployed with an announced core-only
restart and 45.000 seconds of USB absence. The camera reconnected and the
preview decoded 30 frames. A brief −20°/s request and release were accepted
without a USB-generation change or fault; its 0.153° final rotation was too
small to establish useful physical movement, and is not counted as a second
higher-speed motion proof.

The following 45-second observation included operator-admitted commands with a
combined magnitude near 60°/s. USB generation stayed at one, native video stayed
fresh and no transport failure was logged. The media pipeline briefly changed
state without losing the USB session. The browser had fallen back to stills
during the restart and was refreshed; it then showed advancing 640×360 live
video, speed 60°/s and the operator's retained 70% expo. This is bounded
post-fix evidence, not a claim that every intermittent cause has been eliminated.

## Primary-picture layout correction

The operator reported that the fixed notice/thumbnail reservation had made the
primary video too small. The dedicated Camera page now lets the picture occupy
its full column width, with height derived from the video aspect ratio. Compact
horizontal camera cards and a stable notice row sit beneath it. Cockpit keeps
its configured widget slot.

The real desktop browser measured 783×441 pixels for the video, compared with
the preceding 402×226 display. Supporting content fit its rows without overflow
or overlap. The 98 picture/thumbnail tests and widget build passed. Only the
picture's browser bundle was replaced; core and console process identities were
unchanged and USB remained configured. Narrow-screen and alternate-palette
visual acceptance are not claimed by this check.

## Remaining follow-up

Preserve the disconnect interval automatically across ordinary process
restarts, rather than only in this deployment procedure. Keeping the
USB/keepalive owner independent of routine core/UI restarts follows the separate
camera-daemon boundary proposed in the original research. Those ownership
changes remain unimplemented. Automatic live-view recovery after the stills
fallback also remains to be completed; the operator should not need a page
refresh. Root owns these items and the remaining camera acceptance checks.
