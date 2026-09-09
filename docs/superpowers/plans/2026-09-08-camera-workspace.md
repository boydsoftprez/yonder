# Camera Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Camera surface readable, complete and usable without page switching, with real thumbnails and orientation-independent pan/tilt.

**Architecture:** Recompose existing Picture, Aim, Deck and pending-transaction components into one Camera surface. Restore the shared RAM still generator behind existing viewer demand and authenticated media routes. Replace the gimbal's world-angle rate assumption from measured native feedback while preserving transport and operator-intent interlocks.

**Tech Stack:** TypeScript, Vue, Node-RED 5, FlowFuse Dashboard 1.31, GStreamer, Python FunctionFS helper.

**Spec:** `docs/superpowers/specs/2026-09-08-camera-workspace.md`

## Global Constraints

- Keep the existing Yonder day/chart and night/carbon visual identity.
- Logic and presentation stay in packages; flows are wiring only. No function, ui-template, or exec nodes.
- Preserve rollback, AP recovery, credentials, existing camera configurations, and the tested transport/recording implementations.
- Run the Pi at its normal ondemand governor and 1.8 GHz maximum. Observe voltage; do not lower its CPU cap.
- No images, credentials, machine-specific paths, or board addresses are committed. Commits are GPG-signed and DCO-signed, with no amendments.
- Root alone operates hardware. Use bounded probes and continuous source keepalives. Browser visual and physical motion acceptance are required in addition to automated tests.

### Task 1: One coherent camera control surface

**Files:** `flows/flows.json`, `packages/node-red-dashboard-2-yonder/src/ui/YonderDeck.vue`, `YonderPicture.vue`, `YonderAim.vue`, `src/deck.ts`, related component tests; `packages/yonder-core/src/console/theme.ts`, related flow/theme tests; camera-origin result wiring/adapters in `packages/node-red-contrib-yonder-video/src/` as needed.

**Interfaces:** Consume existing `picture.aim` private intent metadata, native control descriptors, Deck draft/apply contract, and pending/confirm/revert adapters. Produce one Picture, one Aim and one unified Deck composition; retain `picture.cameras` thumbnail payload without inventing its producer. Task 2 owns backend routes and still generation.

- [ ] Add failing flow/component assertions for one Aim composition, absent image PAN/TILT footer, Camera pending keys reachable regardless of draft state, camera operations not wired to popup notifications, and draft retention after refused Apply.
- [ ] Run the focused existing Vitest files and verify each new assertion fails for the intended current defect.
- [ ] Remove duplicate Live/Setup composition and embedded Aim; retain native immediate controls, staged draft store and capture operations. Compose one persistent authoritative pending/local-draft action area. Route camera results inline and remove idle READY noise.
- [ ] Apply scoped content-height CSS to Aim and variable controls while preserving the bounded Picture slot. Verify control release/teardown behavior remains covered.
- [ ] Run affected flow, component, DOM tests and package builds; self-review against every Camera surface bullet in the spec. Commit with GPG and DCO referencing R-UI-15, R-UI-28 and R-CAM-11.

### Task 2: Restore watched-camera stills and thumbnails

**Files:** `packages/yonder-core/src/video/stills.ts` and tests; `video/viewers.ts`, `video/present.ts`; `daemon/server.ts`, `daemon/routes.ts`, `console/middleware.ts` and covering tests. Pipeline host only if its existing still operation demonstrably needs a compatibility fix.

**Interfaces:** Recover the former `Stills` implementation from repository history where available, with `latest(camera)`, `read(camera)`, `tick()`, `start()`, `stop()`, and existing viewer demand/accounting hooks. Produce `picture.cameras[].thumbSrc` and `ageSeconds` from actual RAM frames, plus authenticated `/video/:id/still` serving. Preserve current accessory/capture/Aim routes.

- [ ] Compare prior generator/routes/viewers with the current source and identify exact demand, host-channel and response contracts before editing. Recover source and tests from history when possible.
- [ ] Add failing tests for running watched camera -> one complete RAM frame -> authenticated JPEG -> truthful thumbnail age; several viewers share generation while each transmission is counted.
- [ ] Add failure tests for stopped/removed/restarted camera invalidation, no watchers, slow or failed host reply, and unavailable first frame. Native `photo` must never be called.
- [ ] Restore the minimal coherent chain using the existing host still operation, atomic completion, bounded in-flight work and RAM storage. Integrate current accessory source and preserve latest backend DTO fixes.
- [ ] Run covering generator/viewer/route/middleware tests and core build; self-review, then GPG/DCO commit referencing R-VID-14, R-VID-11 and R-STO-01.

### Task 3: Measure and replace world-frame rate gating

**Files:** `packages/yonder-core/src/video/accessory/gimbal.ts`, `guard.ts`, `source.ts`, covering tests; camera configuration schema/docs if the obsolete rate profile is retired.

**Interfaces:** Retain the current Intent and AccessoryWriter contracts. Read world quaternion separately from candidate body-yaw telemetry. Rate feedback must consume actual dispatched commands and fresh status, never infer a motor direction from a world Euler component near vertical.

- [ ] Root records bounded 5 degrees/second, single-axis pulses from the current clear pose, with raw status and actual transmit timestamps. Compare quaternion movement, candidate body-yaw and flags; repeat opposite directions and observe stop tails.
- [ ] Root obtains operator-assisted changes to upright, portrait and underslung orientations while keeping hardware clear; collect the same bounded measurements. Record measured facts and unresolved fields in hardware documentation.
- [ ] Write the concrete native-feedback guard brief from those observations before implementation. Preserve hard-limit unknown-direction refusal, faults, freshness, lease and rate/stop limits; exclude world-angle windows from rate admission. Discrete actions require their own established semantics.
- [ ] Add failing regression cases using recorded status: identical native motion is admitted across headings and near-vertical Euler representation; flags/faults/stale status/end-of-intent still stop admission; no-motion/native stops inhibit repeated into-stop commands and permit evidenced retreat.
- [ ] Implement the measured feedback model, run covering tests/build and mutation checks for the interlocks, then obtain scoped review and GPG/DCO commit referencing R-CAM-11.

### Task 4: Deploy and complete real acceptance

**Files:** `docs/requirements.md`, `docs/hardware/pocket2-resume-2026-09-08.md`, `docs/roadmap.md`, current console plan and manifest as needed.

- [ ] Clarify orientation independence under R-CAM-11 and camera surface expectations without renumbering existing requirement IDs. Update superseded Live/Setup and fixed-world-envelope documentation.
- [ ] Root stages reviewed artifacts, preserves the protected rollback archive, announces the core restart, then installs coherent core/UI/flows. Keep existing network and secrets unchanged.
- [ ] In the real authenticated browser verify live preview and thumbnails, desktop/narrow layout in both palettes, immediate native controls, staged Apply/Discard and visible Keep/Revert on Camera and after navigation, with no overlapping popup results.
- [ ] Verify production pan/tilt under the measured orientations, native photo/record readback, and five browser-loss stop runs with observed stopping time. Keep full-speed voltage and source continuity evidence.
- [ ] Run the final affected workspace tests/build once the cohesive changes are settled; perform whole-change review. Update hardware evidence accurately, including remaining physically unavailable ELP checks, and commit documentation with GPG/DCO.
