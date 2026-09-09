# Camera workspace revision

The operator has authorized restructuring the Camera page after using the Pocket 2 on the development board. The current page duplicates controls, clips variable content, omits thumbnail images, hides confirmation actions, and rejects pan/tilt after the camera is physically reoriented. This revision supersedes the earlier Live/Setup composition and fixed world-angle rate envelope.

## Camera surface

- Keep the existing Yonder day/chart and night/carbon visual identity.
- Show one preview with the camera thumbnail strip, one standalone Aim panel, and one camera controls composition. Retain the independent Picture and Aim on Cockpit.
- Remove the Live/Setup navigation split. Group controls by purpose: camera image and capture controls, then stream/picture/output configuration. Advanced configuration may expand in place without hiding the transaction area.
- Native camera controls remain immediate and show fresh device readback. Encoder/output/picture changes remain staged in the existing draft store. Discard clears only local edits; Revert restores an applied transaction.
- Use one persistent transaction area on Camera. Before Apply it shows the local draft and Apply/Discard; after Apply it shows the authoritative pending transaction, remaining time, Keep and Revert. Device-confirmed changes keep their existing semantics. Every other surface retains the visible pending actions required by R-UI-15.
- Show camera errors and operation results inline. Routine polling, page changes, and successful Keep/Revert must not create a popup over the controls. Preserve actionable notices unrelated to this camera revision.
- Put pan/tilt values in Aim, outside the image. Keep Picture's private gesture metadata and tested release/loss handling. Remove generic idle READY noise and duplicate Aim controls.
- Let variable controls and messages determine their content height. Keep the preview in a deliberate bounded slot. No child content may paint over another widget; verify this in the actual Dashboard browser at desktop and narrow widths in both palettes.

## Thumbnail and still chain

Restore the previously implemented still generator and authenticated serving chain, reconciling them with the current accessory pipeline and DTOs. Capture one periodic preview still per watched running camera, using the running pipeline's still operation. Store only the latest complete image in RAM. Never invoke a Pocket native photo or recording command for a thumbnail.

Reuse the existing thumbnail fields `thumbSrc` and `ageSeconds`, with the age derived from the actual completed frame. Demand and transmission accounting must include strip viewers as well as the selected still fallback. Stopped, removed, or restarted sources must not present an old image as current. The restored code must preserve the current native camera source, capture semantics, and authenticated Aim route.

## Orientation and control

Pan and tilt must remain usable when the camera body changes heading or is mounted upright, portrait, or underslung. Ground/world Euler angles are display telemetry, not joint travel bounds. Do not compare local rate commands with fixed world-angle boxes.

Retain fresh CRC-valid status, known mode, fault and limit feedback, the 10 degrees/second rate cap, 500 ms operator intent lease, bounded serialized writes, and the measured 800 ms device stopping allowance. Replace rate geometry only after bounded measurements establish native movement/limit behavior. Unverified joint fields must remain explicitly unverified; a camera-world quaternion alone does not establish body-relative geometry. Mode/recentre commands must not silently inherit rate admission.

## Delivery constraints

- Logic and presentation stay in packages; flows are wiring only. No function, ui-template, or exec nodes.
- Preserve rollback, AP recovery, credentials, existing camera configurations, and the tested transport/recording implementations.
- Run the Pi at its normal ondemand governor and 1.8 GHz maximum. Observe voltage; do not lower its CPU cap.
- The removed ELP camera remains configured and compatible; fresh physical ELP acceptance cannot be claimed while it is absent.
- No images, credentials, machine-specific paths, or board addresses are committed. Commits are GPG-signed and DCO-signed, with no amendments.
- Root alone operates hardware. Use bounded probes and continuous source keepalives. Browser visual and physical motion acceptance are required in addition to automated tests.

## Operator feedback: continuous aiming

The operator subsequently reported incorrect direction, sluggish response, and
having to release and pull again to obtain continued movement. The revised pad
keeps an owned pointer capture outside its rim, uses the painted SVG coordinate
space, and labels Up, Down, Left and Right explicitly. Release, lost capture,
inhibition, page loss and real control-generation changes still retire the gesture.
The first rate follows its grant immediately; subsequent requests are paced from
the preceding request start and remain single-flight. Rate limits are unchanged.

A media timestamp discontinuity changes the media epoch; it does not invalidate
fresh native camera/gimbal control telemetry. Standalone Aim uses the USB control
epoch. Picture gestures still use the media epoch and end on their own media loss.
A genuine USB generation change revokes old control even if no intermediate
status callback was observed.

The live image established that the earlier public tilt sign was inverted.
Public Up now uses positive native pitch speed, matching the observed optical
direction and the native SDK parameter convention. No extended-range or
unverified control flags are introduced.
