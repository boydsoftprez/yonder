# Pocket 2 independent roll control

R-CAM-11, checked on 2026-09-13 with an identified DJI HG211 attached to the
Radxa Zero 3W. The operator secured the handle flat with its screen facing up,
confirmed the moving head was clear and remained present for two short checks.
The camera was already in FPV (native mode 1). No mode or recenter command was
needed.

## Command and response

The ordinary DUML gimbal rate command, set 4 / command `0x0c`, accepts independent
roll in its second signed 16-bit field. Pan is at byte 0, roll at byte 2 and tilt
at byte 4, in tenths of a degree per second; byte 6 remains `0x80`, retaining
native rate behavior. These checks sent zero pan and tilt. They did not use an
absolute-angle command or the experimental range-bypass flag.

| Requested roll rate | Requested pulse | Native roll before → after | Pan change | Tilt change |
|---|---|---|---|---|
| +1°/s | 0.6 s | 28.7° → 27.7° | −0.1° | 0.0° |
| −1°/s | 0.6 s | 27.7° → 28.9° | 0.0° | 0.0° |
| +1°/s, requested repeat | 0.6 s | 28.9° → 27.8° | 0.0° | 0.0° |
| −1°/s, requested repeat | 0.6 s | 27.8° → 29.0° | 0.0° | 0.0° |
| +1°/s, second requested repeat | 1.0 s | 28.9° → 27.5° | 0.0° | 0.0° |

The operator requested the repeats after not seeing the small head movement.
Physical smoothness has not been confirmed by the operator; the measured evidence
here is the camera's native joint and quaternion feedback. All five completed runs
completed without a rejected renewal, native fault, native limit or
USB-generation change. Stop was accepted in each run. The joint reached a
stable reading within about 0.8 seconds of Stop, consistent with the existing
800 ms native stopping allowance. Stop retires operator intent and stops
forwarding rate commands; it does not promise an instantaneous mechanical halt.
Positive wire roll decreases the reported native roll angle, as positive pan
and tilt rate requests also decrease their native joint readings.

The [recorded samples](evidence/pocket2-roll-rate-2026-09-13.json) retain native
joint feedback, world quaternions, relative sampling times and stop times.
The pulse durations are requested durations: synchronous local API calls add
timing variation. This establishes independent roll response in both directions
at 1°/s in this pose. It does not establish a calibrated rate response, maximum
speed, end-stop behavior, other mounts or browser-to-motor timing.

An initial attempt read the full camera report between renewals and returned
`inactive` after using up its 500 ms credential. It showed only 0.1° of change,
insufficient evidence of roll movement. The successful checks used the existing
lightweight private feedback endpoint. Credential lifetimes and USB dispatch
deadlines were not extended.

## Enabled behavior

The public roll capability is enabled only for a live, identified DJI HG211 in
FPV with native joint feedback. Its initial maximum is 1°/s, the tested speed.
Higher rates require further bounded hardware evidence before raising that cap.
Free and Follow continue to offer their existing pan/tilt controls; the roll
strip explains that FPV is required.

Roll uses the existing single-use 500 ms intent chain and native fault, limit,
freshness, mode and dispatch checks. Mixed pan/tilt/roll requests are rejected.
The independent strip springs to center on release and shares the pan/tilt
speed and expo preferences, capped by the roll limit. Shift requests one quarter
speed; input below the 0.1°/s wire resolution remains at rest. Starting another
manual surface or a preset retires the previous hold. Saved presets remain
pan/tilt positions, and saving waits for all three joints to settle.

The private local-socket bench operation is unavailable through the authenticated
console command grammar. It neither persists nor changes production capability.
The reusable [check script](../../scripts/pocket2/roll-rate-check.py) also bounds
its requested rate to 1°/s and stops before issuing another command after its
requested pulse deadline. The first pair used the earlier loop; the requested
repeat pair exercised that refinement and recorded each command's submission
and acceptance time. The repeat pair admitted 11 renewals in total, with request
times between 5 and 41 ms. The final 1-second pulse admitted eight more renewals.
Before that pulse, a full-status read timed out without issuing any motion; the
initial read timeout was raised to 5 seconds, outside the gesture. Motion request
timeouts and credentials remain unchanged. All versions' results are preserved
as measured.
