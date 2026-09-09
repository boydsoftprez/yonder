# Cockpit flight workflow implementation plan

> For agentic workers: use dispatching-parallel-agents for the independent protocol,
> presentation and ground-data tasks, and verification-before-completion before handoff.

**Goal:** Implement the operator-approved bandwidth and flight-workflow improvements
on the existing native cockpit, preserving the original working instruments.

**Architecture:** The aircraft serves compact flight updates plus separately
versioned mission/control details. Geographic data and traffic are owned by the
ground browser by default; aircraft proxying is an explicit alternative. A
persistent flight control strip submits the existing authenticated, reviewed
requests, and annunciations follow reported aircraft state.

**Tech stack:** Existing TypeScript, Vue, MAVLink, WebGL, Leaflet and browser storage.
**Spec:** Operator-approved discussion in this task; R-FLT-01 through R-FLT-14.

## Constraints

- Continue `codex/single-glass-cockpit`; preserve the source worktree and camera fixes.
- Never change the user's active SITL flight state to run a test. Use an isolated instance.
- No aircraft-changing action from opening a page, reconnecting, rendering or a timer.
- No automatic fallback from ground internet to the aircraft's internet connection.
- Use actual source freshness, altitude references and command outcomes; no invented capture modes.
- Keep business logic in packages, flows as wiring, signed DCO commits.

## 1. Flight protocol (protocol worker)

Files: `packages/yonder-core/src/mav/{types,vehicle,vehicle-telemetry}.*`,
associated tests and isolated SITL smoke script.

- [x] Verify official ArduPlane GUIDED heading, altitude, speed and radius command fields.
- [x] Write failing byte/transaction tests for validation, ACK and observed telemetry,
  mode prerequisite, stale context and unsupported firmware.
- [x] Implement one-shot operator actions with explicit capability descriptors;
  preserve mission/reconnect/idempotency behavior.
- [x] Verify requested parameters and outcomes against isolated ArduPlane SITL.

## 2. Flight presentation and mission editing (surface worker)

Files: `PrimaryFlightDisplay.vue`, `MissionTouch.vue`, `cockpit.css`, new
`FlightControlPanel.vue`, `FlightModeAnnunciator.vue`, pure state adapters/tests.
Consumes the vehicle snapshot and emits reviewed `VehicleAction` requests to the host.

- [x] Write failing tests for mode/request separation and actual-state transitions.
- [x] Build persistent Direct-To, Heading, Altitude/Speed, Loiter, Resume and RTL
  controls, with the complete supported mode picker and distinct arm/disarm access.
- [x] Add Change action while preserving waypoint identity/location and remapping
  parameter meanings; expose radius, direction and duration with local circle preview.
- [x] Fill the PFD viewport with scene geometry while retaining instrument proportions,
  readable controls, HSI and correct touch hit regions.
- [x] Verify tablet/laptop/narrow layouts, unavailable state and no commands on edits.

## 3. Ground geographic data (ground-data worker)

Files: new browser data provider/storage modules, `YonderCockpitMap.vue`,
`TerrainVision.vue`, `CameraTerrainOverlay.vue` and associated tests.

- [x] Test independent ground, offline and explicitly selected aircraft-proxy paths.
- [x] Fetch regional public traffic on the ground and maintain bounded local trails;
  reuse datum validation and display stale/error states without fabricated targets.
- [x] Route imagery/elevation through the selected source and retain bounded browser
  cache. Provide explicit prepared terrain-pack import/preload for offline ground use.
- [x] Ensure source opt-out aborts requests and loss never switches to aircraft proxy.
- [x] Verify actual provider browser access and document any ground relay requirement.

## 4. Compact transport and host integration (coordinator)

Files: core `cockpit/{routes,flight-wire}.*`, console `cockpit.*`,
dashboard `cockpit-state.mjs`, `YonderCockpit.vue`, fixture and docs.

- [x] Write failing tests that recurring flight responses omit mission items, operation
  history and traffic breadcrumbs, and that detail revisions recover after reconnect.
- [x] Serve compact numeric telemetry with freshness and a separate change token for
  details; browser reconstructs existing instrument state without re-downloading stable data.
- [x] Connect provider options and control surfaces. Preserve server error reasons.
- [x] Expose camera-unavailable fallback to synthetic terrain and selected source status.
- [x] Measure actual recurring payload and confirm aircraft proxy makes no unsolicited
  public data requests in the ground/offline modes.

## 5. Integration and handoff

- [x] Run the complete workspace tests, build and lint; review the combined diff.
- [x] Verify real browser controls, mission conversion, payload routing and responsive
  scene in both palettes; use fixtures and isolated SITL without altering active flight.
- [x] Update walkthrough, requirement/blueprint mappings and evidence with practical limits.
- [x] Commit signed changes and leave a working preview for the operator.

The workspace tests/build/lint and cockpit-specific browser checks pass. The
broader installed-page visual gate flags camera-page geometry and action-width
changes from the merged base; those captures have not been accepted as part of
this cockpit change. See the recorded integration result in
`docs/console/evidence/2026-09-07-cockpit-flight-workflow.md`.
