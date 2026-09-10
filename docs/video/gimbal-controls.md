# Gimbal input and saved positions

## Held controls (R-CAM-11)

A drag is a rate request for as long as it is held. The video shows a ring at
its origin and a puck for the requested direction. Full speed is reached 72 CSS
pixels from that origin. Shift reduces the requested speed to one quarter for
fine adjustments. A captured pointer may leave the video without ending its
hold; release, lost capture, page hiding, disconnection or camera inhibition
ends it. The separate pad and video share the saved speed and expo preferences.
Inputs smaller than the camera's 0.1 degree/s wire resolution remain at rest;
they do not create a gesture that the driver immediately cancels.

The daemon issues a single-use credential lasting 500 ms. Admitting a rate
issues the next credential, but the admitted rate retains its original deadline
through queued USB dispatch. Those two deadlines are different. Previously,
expiry of the old rate discarded the next credential too, even while it was
still valid and in transit. Sequential renewals at a 300 ms round trip could
therefore start movement and then receive `inactive`.

Expiry now discards and aborts only the old rate until the next credential also
expires. No motion is forwarded during that gap. Only a fresh admitted renewal
can resume forwarding; release, fault, a native limit, mode change or disconnect
revokes the gesture and the outstanding credential. The credential lifetime,
command deadlines, USB dispatch checks and native stop allowance are unchanged.
Tests cover continuous native dispatch at 300 ms renewal intervals, expiry and
release without another command, and transient faults during renewal gaps.

## Saved position work (R-CAM-23)

The requested feature is named positions with Save current position, Recall,
Rename and Delete, plus an explicit Stop while recalling. Position reference
must be stated: mount-relative directions and world directions are different
features when the aircraft turns. Saved data must be associated with the camera
and its mounting reference; loading a preset must not change video settings.

Pocket 2 position recall is not implemented by sending its displayed Euler
angles to the absolute-angle command. The recorded bench evidence in
[the USB protocol investigation](../hardware/dji-pocket-2-over-usb.md#moving-the-gimbal)
shows that this command's reference depends on mode and differs from the reported
angles; previously it produced a fast unexpected excursion. World quaternions
prove camera rotation, but alone do not establish handle-relative joint angles.

Before enabling recall on this camera, establish the chosen position reference
and validate a bounded, interruptible recall using that reference. A saved
command-duration macro is not a measured position and must not be labeled one.
There is no save/recall control exposed until it can complete the requested move.

## Configuration parsing contention

A subsequent live check still returned `inactive`: its first motion request
spent 576 ms on the local Unix-socket path after a deliberate 255 ms delay.
No movement was observed. A 20.3-second core CPU profile attributed 11.15 seconds
to `loadConfig`, including 10.0 seconds in YAML parsing. Configuration consumers
were repeatedly parsing identical bytes on the same event loop that admits
camera controls.

`loadConfig` now retains validated results for at most eight file paths, keyed
by exact file content. Every call still reads the current file; changed bytes,
a missing file and invalid data are observed immediately. Each caller receives
an independent deep copy, so editing an unsaved configuration cannot contaminate
a later read. Apply and rollback use the same file and validation semantics.
A separate-process benchmark on the Pi improved median repeated-read time from
35.58 ms to 0.52 ms (20 reads each). This measures configuration loading, not
end-to-end camera latency.

The diagnostic profiler's cleanup command caused an unexpected core restart
through an unsupported debugger dynamic-import callback. That diagnostic fault
was separate from the camera issue; the video session was restored. No profiler
or debugger is left running, and the diagnostic command is not production code.

## Installed acceptance

The intent and UI changes, followed by the configuration-read fix, were installed
with their original video/USB pipeline and saved settings preserved. Each planned
core activation used the established 45-second USB absence and verified a stable
camera run afterward. The final run retained its identity and zero restarts
through both movement checks.

Two explicit 2 degree/s checks, one pan and one tilt, each sent eight renewals
with an added 255 ms delay between requests. All 16 were accepted, including
measured renewal intervals from 260 to 362 ms. The requests themselves took
4–107 ms. Pan changed from -160.2 to -156.5 degrees with unchanged tilt; tilt then
changed from 138.9 to 134.8 degrees with unchanged pan. Both Stop requests were
accepted, with no reported fault or native limit. These small checks establish
working renewal and movement on both axes; they are not a full travel-range or
preset-recall verification. The existing Free mode was preserved.

Validation included 3672 core tests, 943 widget tests, the workspace build and
107 picture tests after the final joystick-origin stacking correction. The
camera page was inspected in the browser with the new drag guidance above video.
Saved-position recall remains pending the reference choice and device validation.
