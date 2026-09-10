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
