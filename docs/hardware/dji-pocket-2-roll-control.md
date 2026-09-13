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
Physical smoothness had not been confirmed at this stage; the evidence for these
small checks is native joint and quaternion feedback. All five completed runs
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

## Coexistence with the video CPU update

The first roll activation was replaced by a separate, completed deployment of
the video CPU changes. A requested 30-degree check found the public roll
capability missing and issued no motion. Comparing the runtime files identified
the replacement: the gimbal files were back at their previous versions, while
the accessory source contained the new consumer-dependent video forwarding.
The operator confirmed that deployment was finished.

The roll branch incorporates the CPU changes from `claude/mule-cpu-fix`
(`385651c`) and retains both behaviors. The combined source regression explicitly
proves that, after video has been set aside for ten seconds, fresh FPV joint
feedback still offers roll and admits its public rate request without resuming
video forwarding. The merge retains the 1°/s limit and all motion checks.

## Requested 30-degree check

After the combined version was activated, the operator-requested larger check
used the ordinary public issue/slew/stop chain at +1°/s. Native roll moved from
+27.5° to −3.1°: 30.6 degrees in total, including 0.6 degrees of travel after
crossing the requested −2.5° target. World quaternion feedback measured 30.23°
of camera rotation. The target was reached after about 30 seconds of motion.
All 239 renewals were accepted; the slowest request took 66 ms. Stop was accepted,
followed by two seconds of feedback with no reported error, fault, limit or
USB-generation change. Pan changed −0.1° and tilt +0.2°.
The operator confirmed that this larger movement was visible and smooth.

The [summary](evidence/pocket2-roll-travel-2026-09-13.json),
[native feedback](evidence/pocket2-roll-travel-2026-09-13.csv) and
[renewal timings](evidence/pocket2-roll-renewals-2026-09-13.csv) preserve this run.
It establishes sustained public roll control at the enabled rate across this
central span. Other mounts, rates and end stops remain untested.

## Software and installed verification

The combined core build and full core suite passed: 4,190 tests and one skipped
test across 208 files, with two test workers. Earlier unrestricted parallel runs
had unrelated terrain timeout and host-cleanup failures; those files passed in
isolation and the complete bounded-concurrency runs passed. No deadlines or tests
were relaxed to clear those failures.

The widget build, 87 focused control tests and four functional browser cases
(1440/390 pixels, day/night) passed. The full console page gate passed without
accepting new geometry baselines. The final merge did not change the UI bundle;
the added integration test covers control while video forwarding is paused.
The bounded travel script's four offline tests and Python compilation passed.

Only the seven gimbal-related core runtime files and the Aim/Picture bundles
were changed by the roll installation. Originals were backed up, active files
were checked against expected hashes, core restarts used a 45-second USB pause,
and saved configuration and secrets retained their hashes. The final activation
left the console running, root mounted read-only, and the Pocket's video stopped
as found. The camera remained available for control. The
[installed runtime hashes](evidence/pocket2-roll-runtime-2026-09-13.json) identify
the combined build.
