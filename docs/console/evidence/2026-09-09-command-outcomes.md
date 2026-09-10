# Plain-language flight-command results

R-FLT-04/10. An arm request displayed `rejected · ACK result 4 · effect not
confirmed`, and its toast repeated `Autopilot refused command (4)`. The actual
Pi operation was an arm request, COMMAND_ACK 400/result 4, followed 4 ms later
by `Arm: Waiting for RC`. The aircraft remained disarmed. The preceding mission
upload had already completed and its downloaded copy was verified.

The [MAVLink command-result definition](https://mavlink.io/en/messages/common.html#MAV_RESULT)
defines result 4 as execution failure, not elapsed time. It does not provide a
specific cause. The [mission-result definition](https://mavlink.io/en/messages/common.html#MAV_MISSION_RESULT)
uses a separate namespace: mission response 4 means insufficient storage.

The shared display formatter names the action and outcome, translates the
appropriate response namespace, and keeps accepted, confirmed, declined, failed
and unknown outcomes distinct. The PFD, its transient notice, Mission controls,
Home result and Aircraft history use this presentation. Tapping the PFD result
opens Aircraft status. Technical details retains raw protocol codes, command
number, operation ID and original messages in a closed disclosure.

For rejected arming attempts, an explicit `Arm:` message from the same aircraft
between send time and two seconds after the terminal response may supply the
reason. Messages from before the attempt, after a subsequent attempt, from a
different aircraft or periodic `PreArm:` reports are not attributed. The known
`Waiting for RC` message expands to `Waiting for radio-control input`. Current
armed/disarmed text requires fresh connected telemetry. Missing or expired
history leaves the specific reason unavailable; it is never guessed from the
numeric code. A late-arriving reason also updates an existing notice.

The full widget suite passed **941 tests in 83 files**, including command and
mission result namespaces, absent/stale/mismatched reasons, accepted versus
confirmed outcomes, late reason arrival, technical-detail access and no command
submission from opening results. Production build passed; these are presentation
changes only. No autopilot request was issued to reproduce the refusal.

## Installed verification

Signed UI commit `2046822`, combined with the Adaptive acceptance documentation
in `996f72a`, was installed by atomic replacement of the cockpit UMD only.
Installed SHA-256:
`d363ba36e3dbfc70996e18f079a3d23fc04bc7c2190730c1cabe9afc21b4451e`.
The previous bundle is retained under
`/opt/yonder/backups/command-outcomes-2046822/`.

A separate authenticated Flight tab showed the actual failed arm attempt as
**Arming failed — Waiting for radio-control input. Aircraft remains disarmed.**
The PFD result opened Aircraft status, whose latest-first history also showed
the successful mission upload and Home change. The code was absent from the
closed disclosure and visible as COMMAND_ACK / command 400 / result 4 after
opening Technical details. No flight action was pressed; the original draft
tab was not reloaded. Core PID 62420 and console PID 777 stayed unchanged.
