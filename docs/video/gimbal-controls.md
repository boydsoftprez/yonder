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
