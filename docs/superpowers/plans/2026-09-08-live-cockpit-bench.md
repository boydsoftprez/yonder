# Live cockpit hardware bench implementation plan

**Goal:** Run the approved cockpit through a Yonder companion board using telemetry from an identified physical flight controller.

**Architecture:** Keep mavlink-router as the owner of the controller's USB/UART link. The daemon decodes its loopback copy into the existing vehicle and instrumentation services; the authenticated console serves the native cockpit. The browser handles terrain rendering and ground-side map/traffic sources.

**Tech stack:** Existing installer, systemd, mavlink-router, yonder-core, Node-RED and the native Vue cockpit.

**Spec:** `docs/requirements.md` (R-MAV-01/05/06/07/13, R-FLT-01/02/23–26, R-CMD-04/05/06, R-CFG-03 and R-NET-07), plus `docs/cockpit-control-integration-audit.md`.

## Scope and current evidence

The operator requested moving from the working QuadPlane simulator demo toward live hardware and flight-controller data. The first hardware pass reads telemetry. Arming, actuator commands, mission uploads and mission starts on physical hardware require a separately identified bench procedure and explicit operator authorization. The simulator's looping mission must never be copied to a physical controller as part of connection setup.

- [x] Confirmed the production path: mavlink-router → loopback UDP 14559 → `LoopbackListener` → `VehicleService` → authenticated cockpit routes.
- [x] Confirmed that receiving telemetry does not itself send flight-controller commands. Stream configuration and mission download are explicit transactions.
- [x] Located the existing UART bring-up and Radxa installation records. They establish prior hardware work, not the identity or state of today's selected board.
- [x] Checked local serial-device names: no USB serial controller was enumerated on the development Mac at preflight.
- [x] Read-only inspection of a saved Pi SSH target found a Compute Module 4 running an armv7l OS, with no active Yonder services. This is not the documented Pi 4/aarch64 setup and is not yet an approved deployment target. No device configuration was changed.
- [x] Compared the requested integration head `claude/exciting-merkle-e4cd39` at `b9c98cb` with cockpit code at `0fd113f`. A merge preflight found nine conflicting paths. The preflight changed no checkout.
- [ ] Identify the selected companion board, reachable address, OS/userspace architecture, controller model/firmware and physical connection. This information has been requested from the operator.

## 1. Integrate the existing application

- [ ] Refresh the two branch revisions before integration, preserving the latest camera, networking and console changes together with the approved cockpit.
- [ ] Resolve the middleware and daemon joins so camera/media routes and cockpit telemetry routes both retain their intended session and service ownership.
- [ ] Combine the flow wiring and both sets of cockpit tests. Do not put logic into Node-RED function nodes.
- [ ] Reconcile the blueprint manifest and regenerate the conflicting cockpit shape artifacts from the resulting native application.
- [ ] Build the core and console packages, run their relevant suites and the console/flow checks, then walk the production cockpit and camera surfaces.

Conflicting paths recorded by preflight:

- `docs/console/design/blueprint-manifest.md`
- `docs/console/shape/cockpit-tablet.day.darwin.json`
- `docs/console/shape/cockpit-tablet.night.darwin.json`
- `docs/console/shape/cockpit.day.darwin.json`
- `docs/console/shape/cockpit.night.darwin.json`
- `flows/flows.json`
- `packages/node-red-dashboard-2-yonder/src/ui/cockpit.component.test.ts`
- `packages/yonder-core/src/console/middleware.ts`
- `packages/yonder-core/src/daemon/server.ts`

## 2. Prepare a board-specific installation

- [ ] Read the selected board's installed version, service state, free space, Node runtime, architecture and serial-device identities without opening the controller port.
- [ ] Choose the matching existing installer/payload path. Do not infer userspace architecture from the processor model: an armv7l installation cannot consume an arm64 payload.
- [ ] Preserve the board's configuration, secrets and current service artifacts for restoration. Use the installer/apply ownership rules and retain network rollback/AP fallback.
- [ ] Review the exact package/service changes for that board before applying them. Avoid an OS reflash or firmware change unless the identified hardware requires one and the operator explicitly chooses it.
- [ ] Install the integrated core/console artifacts and verify service startup and the authenticated board URL.

## 3. Verify live controller telemetry

- [ ] Identify the intended USB/UART endpoint and existing protocol/baud configuration; retain a single serial-port owner.
- [ ] Confirm incoming MAVLink heartbeat identity, vehicle type and firmware. Keep the simulator endpoint separate.
- [ ] Observe attitude, heading, GPS, altitude, speed, mode and arm state in the cockpit. Distinguish unavailable bench GPS/airspeed/battery sensors from bad decoding.
- [ ] If essential streams are absent, review and request only their reporting configuration. Preserve the distinction between requesting reports and changing aircraft behavior.
- [ ] Verify battery-monitor instances, board health and modem readings where the installed hardware reports them.
- [ ] Walk the cockpit's source/age inspector and compare displayed values against the received reports. Observe a small operator-performed board/controller tilt if appropriate; do not drive actuators.
- [ ] Read the controller's existing mission only through the explicit download action when needed. Do not upload or start the demo mission.

## 4. Record the bench result

- [ ] Verify reconnect behavior using an operator-controlled disconnection after the selected link is understood; record stale indications, recovery and unchanged physical aircraft state.
- [ ] Measure board resource use, browser frame rate and telemetry bytes separately from ground map/terrain downloads.
- [ ] Record the exact board, OS, controller/firmware, wiring, build revision, observed fields and unresolved gaps in a hardware evidence note.
- [ ] Update the user guide with the real board connection path and its verified steps. Keep software/SITL evidence distinct from physical-controller evidence.
