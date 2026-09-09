# Stopped camera prevented mission controls from becoming ready

R-FLT-04/12/13. The Pi showed live MANUAL/disarmed telemetry, but Mission controls
said **Aircraft details are refreshing**, disabling both Read and Upload. Its
draft remained present. This was independent of the later mission-read and
controller-home prerequisites.

The compact flight endpoint and details endpoint hash camera state into their
shared version token. For a camera never started in the current supervisor,
`state()` synthesizes `stopped` with `since=now` on each call. Four consecutive
live reads produced four different detail tokens for the same aircraft
generation; the two detail reads reported stopped timestamps 27 ms apart.
The browser correctly refused to consider those versions synchronized, but the
server made synchronization impossible. The extra detail downloads also wasted
link bandwidth.

The fix excludes only `run.since` for stopped cameras from token calculation.
The original timestamp remains in the response. Camera state, configuration,
detection, running-instance timestamp, vehicle identity, mission and operation
changes still invalidate the token. Command readiness rules, upload review and
home verification are unchanged. The camera pipeline and supervisor are not
modified by this correction.

The regression test uses the real VehicleService, route handler and browser API
adapter with a changing stopped-camera timestamp. It verifies matching tokens,
ready command details, cached subsequent polls, renewed invalidation on profile
and running-state changes, and no aircraft transport writes. All **3,633 core
tests in 159 files** passed, and the core build passed. Comparing the generated
route with the installed Pi file showed only this version-token change.

The camera deployment owner included signed correction `7540156` in the combined
activation, preserving the installed Flight header and the shared USB restart
boundary. No mission upload or controller-home change is part of this fix.

The correction was merged with the camera candidate in `2057e83`. An independent
full run against that combined source passed **3,662 core tests in 160 files**.

## Live recovery

The activation owner confirmed accepted runtime `2057e83`, 45.06 seconds of USB
absence, core PID 62420 and unchanged console PID 777. The existing Flight tab
recovered without refresh. Opening Mission controls showed Vehicle connected and
an enabled Read button; the same 14-item local draft was retained.

A read-only mission download from that panel completed with **observed · Complete
vehicle mission downloaded**. The controller returned a verified empty mission
and no home position. The UI then correctly kept Upload disabled with the specific
missing-controller-home explanation, while Read stayed available. No upload, arm,
mode, mission-start or set-home action was sent. Setting the aircraft's return-home
reference remains an explicit operator decision.

Consecutive compact flight/details/flight reads now shared token
`e297a4e69aefd0c3e52c863d` for the same aircraft generation, demonstrating that the
permanent refresh loop cleared. The connected state and enabled Read button were
verified again after the read operation's temporary details invalidation cleared.
