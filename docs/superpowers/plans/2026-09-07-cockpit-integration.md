# Flight cockpit integration implementation plan

> For agentic workers: implement bounded tasks with the dispatching-parallel-agents
> and verification-before-completion skills. Shared contracts and wiring are owned
> by the coordinator; workers own disjoint packages/directories.

**Goal:** Ship the approved flight cockpit in Yonder's actual packages and console.
**Architecture:** Vue cockpit on authenticated same-origin APIs; daemon-owned MAVLink
transactions; locally served data packages with optional public data feeds.
**Tech stack:** TypeScript, Vue 3, Dashboard 2, node-mavlink 2.3.0, Leaflet 1.9.4,
WebGL, existing mediamtx/WebRTC, Vitest and Playwright.
**Spec:** `docs/cockpit-integration-design.md`.

## Global constraints

- Base `0f1e9b92485a7f4e23c7d75a6e2fde195124a2ca`; do not alter the source worktree.
- Logic and presentation live in packages; flows contain wiring only.
- No aircraft-changing action without authenticated operator review/confirmation.
- Autopilot validation and execution remain authoritative; timeout means unknown.
- No external executable assets; public data only after explicit enablement.
- Distinguish raw GPS, fused MSL, HOME-relative and terrain/surface clearance.
- Do not imply camera registration without valid calibration and capture-time pose.
- Keep all runtime dependencies, demo data and documentation self-contained.
- Use signed DCO commits; never disable signing.
- Full point-cloud visualization remains a stretch goal.

## 1. Protocol, telemetry and transactions

Files: new `packages/yonder-core/src/mav/types.ts`, `vehicle*.ts`, `protocol*.ts`,
`mission*.ts` and corresponding tests. Public service: `submit(OperatorRequest)`,
`receive(Uint8Array)`, `snapshot(): VehicleSnapshot`, `close()`; injected `Clock`
and `send(bytes)` keep hardware out of tests.

- [x] Write byte-level decoder tests for invalid CRC, source identity, truncated
  v2 fields, per-field freshness, HOME/GUIDED/mission context and measured VSI.
- [x] Verify each test fails for the absent feature, then implement using the
  pinned complete dialect library rather than extending the heartbeat scanner.
- [x] Add transaction tests: authenticated session provenance supplied externally,
  confirmed request, idempotency, stale generation, duplicate ACK, timeout unknown,
  observed arm/mode/target/current state and serialized compound actions.
- [x] Add mission tests for request/count/item/ACK/readback, concurrent changes,
  non-position items, empty mission, NaN fields, sequence zero and draft revisions.
- [x] Run `npm test -w yonder-core -- src/mav` and `npm run build -w yonder-core`.

## 2. Authenticated API and daemon ownership

Files: `console/cockpit*.ts`, `console/middleware.ts`, `daemon/routes.ts`,
`daemon/server.ts`, `mav/listener.ts` and tests. Browser routes begin
`/cockpit/api/`; internal Unix-socket routes begin `/cockpit/`.

- [x] Test unauthenticated access, wrong origin, request-size limits and spoofed
  session fields before implementing the proxy. Insert session identity server-side.
- [x] GET state returns the service snapshot; POST command starts a bounded job
  and returns promptly. Polling never retransmits commands.
- [x] Wire receive/send to the existing loopback socket without changing raw GCS
  routing. Reject send without a known loopback peer and close resources on shutdown.
- [x] Test daemon absence, service errors and node redeploy without loss of ownership.

## 3. Native cockpit and mission controls

Files: dashboard `src/ui/YonderCockpit.vue`, `src/ui/cockpit/*`, widget registration,
manifest, production-component dev harness and component/browser tests.

- [x] Test full-PFD default, inset expansion/back, narrow layout and drawer focus.
- [x] Port licensed authored instrument geometry; derive state from VehicleSnapshot.
  Test VSI signs, stale gates, CDI left/right, GUIDED radial semantics and FD demand.
- [x] Implement mission import/export and catalog editor preserving unmappable items;
  map touch selection opens reviewed actions; actual mission and draft stay separate.
- [x] Add settings, time/distance predictions and actual demanded-bank cues. Label
  estimates and unavailable inputs; do not fabricate autopilot turn countdowns.
- [x] Reuse camera lifecycle with an embedded background seam; retain one map/video
  owner during layout changes. Include visible sources and independent stale states.
- [x] Run widget tests/build and Playwright at tablet/notebook sizes in both themes.

## 4. Bounded traffic feed

Files: `packages/yonder-core/src/cockpit/traffic.ts`, cockpit API integration and tests.

- [x] Normalize actual provider observations, preserving barometric/geometric/MSL
  altitude distinctions. Test out-of-order timestamps, stale expiry and unknown datum.
- [x] Share bounded cache/history, gap breaks, radius filtering, idle stop, request
  deadline/size limit and Retry-After. No background requests before enablement.
- [x] Verify map/vision filtering and breadcrumb behavior with known fixture tracks.

## 5. Terrain package and fixed-camera geometry

Files: `packages/yonder-core/src/terrain/*`, `scripts/terrain/*`, package metadata,
small derived demo assets, UI terrain integration and tests.

- [x] Inspect downloaded USGS source metadata/coverage and prepare a bounded mission
  corridor with bare-earth and canopy/roof surface data, source hashes and survey dates.
- [x] Validate height references and missing cells; never substitute an unknown datum.
- [x] Serve bounded levels of detail locally; keep parsing/building off animation work.
- [x] Test camera intrinsics, crop/rotation, mounting orientation, timestamp validity,
  terrain projection and advisory clearance. Gate uncalibrated physical ELP overlays.
- [x] Verify visible relief and rendering cost at low altitude; keep evidence separate
  from certification or hardware-registration claims.

## 6. Shipped surface, documentation and review

Files: `flows/flows.json`, `docs/requirements.md`, cockpit guide/provenance, existing
capture scripts/geometry expectations and integration tests.

- [x] Register cockpit in the installed console, with systems/camera links preserved.
- [x] Test the actual built widget and authenticated API together, then dedicated
  ArduPlane SITL mission/goto/loiter flows without connecting to physical hardware.
- [x] Run `npm test`, `npm run build`, `npm run lint`, and browser shape/legibility
  checks. Record failures already present at base separately.
- [x] Review complete diff against approved scope and browser captures; fix material
  findings, update guide and progress ledger, then create signed DCO commits.

## Completed evidence and explicit limits

See `docs/cockpit-integration-verification.md` for final test counts, native and
isolated SITL evidence, reviewed captures, historical camera-reference drift,
provider rate limits and physical camera/firmware boundaries. The implemented
slice is ArduPlane-specific; this checklist does not claim that all M7 capabilities
or physical camera registration have been verified.
