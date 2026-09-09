# Raspberry Pi cockpit integration alongside camera development

The operator has selected the active camera work as the application base and
requested cockpit bring-up on the same development Raspberry Pi. This supersedes
the earlier proposed integration base in the live-cockpit bench plan.

## Ownership and approach

- Base: `codex/pocket2-camera`, initially `fb0ac37`; incorporate its next committed
  USB-driver fix after the camera task identifies a stable handover revision.
- Cockpit input: `codex/single-glass-cockpit` at `1c603c9`.
- Prepare and test in `codex/pi-cockpit-integration`; do not edit the camera
  checkout or copy its uncommitted work.
- The camera task owns installed core/console/camera restarts until handover is
  coordinated. Local builds, package staging and passive telemetry inspection can
  proceed concurrently. Shared-service replacement is serialized.
- Keep one owner of each camera/USB and flight-controller serial endpoint.
  A second production daemon must not race the installed daemon's renderers.
- Begin with real flight-controller telemetry. Do not arm, upload/start a mission,
  drive actuators, or transfer the simulator's demo mission to physical hardware.
- Retain authenticated cockpit routes, source/freshness checks, configuration
  rollback and AP fallback (R-FLT-02/25, R-CMD-04/05/06, R-MAV-05/06/07,
  R-CFG-03, R-NET-07). Camera behavior remains owned by its existing requirements.

## Work

- [x] Identify camera task, branch and last recorded Pi connection; request a
  shared-device handover contract. Last-address SSH did not answer at preflight.
- [x] Create an isolated integration checkout based on the committed camera head.
- [x] Merge the cockpit implementation, combining service/proxy/flow wiring and
  retaining both camera and cockpit tests. Reconcile requirements and blueprint
  evidence without discarding either feature set.
- [x] Build and test the integrated packages and authenticated console HTTP routes.
- [ ] Complete native-browser inspection; the initial browser automation session detached.
- [x] Incorporate the camera task's committed driver fix and rerun affected checks.
- [ ] Incorporate its subsequent bounded camera-workflow correction before activation.
- [x] Confirm Pi identity, architecture, installed build, active services, free
  space, camera endpoint ownership and the actual flight-controller connection.
- [x] Stage matching artifacts in a separate release directory.
- [ ] Keep a reversible
  installed-build/configuration snapshot and coordinate the shared restart.
- [ ] Deploy the combined release during the agreed window, verify camera/media
  continuity and read real flight-controller telemetry in the authenticated cockpit.
- [ ] Record the exact deployed revision and software/hardware evidence, plus any
  remaining limitation. Keep simulated and physical-controller results distinct.

The operator connected the flight controller during this task. The existing
telemetry service automatically linked ArduPlane system 1 on ttyAMA0 at 115200.
Camera/Cockpit remain intact; the native flight display is a separate Flight page.

Staged candidate: integration commit `963e19c`, including camera head `073f8f1`.
The staging manifest remains on hold until the additional camera-workflow pass
is committed and incorporated. No production activation has occurred.
