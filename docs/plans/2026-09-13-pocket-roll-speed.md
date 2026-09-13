# Pocket roll operating speed

> Execution: yonder-cost-aware-execution. Requirements and acceptance criteria are binding; verification follows its risk-based policy. Use yonder-page-verification for console evidence.

**Goal:** Install the operator-approved 30°/s roll default and independent speed preference on the Mule for hands-on evaluation.

**Architecture:** Retain the native rate command, progressive stick response, original intent deadlines and existing stop behavior. The roll strip owns a separate browser speed preference, while expo remains shared with the aim pad. The backend advertises and enforces 30°/s for identified HG211 roll in FPV. Existing pan/tilt defaults remain 60°/s.

**Stack / requirements:** Vue widgets, TypeScript core, DUML over the existing USB link; R-CAM-11, R-CAM-15, R-CMD-04, R-UI-12, R-UI-16. Design extends the separate strip described in `docs/video/gimbal-controls.md` and the evidence in `docs/hardware/dji-pocket-2-roll-control.md`.

## Constraints

- Preserve native fault/limit/freshness guards, 500 ms single-use credentials, queued dispatch deadlines and control-surface exclusion.
- Keep logic and presentation in source packages, flows as wiring only.
- Preserve the integrated video CPU changes, device configuration, secrets and rollback access. Scope installation to changed runtime files and verify hashes.
- Signed commits; preserve unrelated working files. No automatic recenter or aircraft motion.
- Do not describe unmeasured higher-rate stopping behavior as verified or promise an instantaneous halt.

## Backend and stop measurement — roll_core, then lead

Own `packages/yonder-core/src/video/accessory/guard.ts` and directly related backend tests. Consume existing optional `roll` in degree/s; produce `rollControl.maxRate = 30` through the existing capability field. No schema change.

- [x] Audit native Stop and existing hardware evidence; preserve the established semantics unless a bounded experiment establishes another contract.
- [x] Raise the roll cap to 30, enforce both signs and over-limit rejection, and exercise the cap through ordinary intent admission and second-word wire encoding.
- [x] Run affected core tests and build. Confirm fault, stale, mode, mixed-axis, expiry and release rejection coverage remains valid.
- [x] Resolve ownership of the hardware evaluation. The operator began testing and explicitly requested control, so the planned lead measurement was not run. A preflight detected changed mode/position and sent no command. The prepared offline-tested pulse tool remains available for a later coordinated check; higher-rate mechanical evidence is pending.

Verification: command-boundary regression tests, built runtime hashes, native feedback and stop timing. Faster mechanical response is a hardware observation, not a mock contract.

## Independent roll preference — lead

Own `YonderRollStrip.vue`, `aim-response.ts`, roll component tests, gallery fixtures, browser verifier and control documentation. Consume backend maximum; produce separate `yonder:aim:roll-speed` preference, 30°/s fallback, selectable from 1 to the reported limit. Existing pan/tilt key and shared expo remain.

- [x] Add a labelled Roll max speed slider, preserve the measured-angle header and spring-return track, and stop the active roll gesture before a preference change.
- [x] Prove pan/tilt speed does not change roll speed, saved roll speed persists, default reaches 30, Shift reduces it, and small inputs retain fine rates. Cover invalid preferences and backend cap reduction.
- [x] Exercise speed selection, actual request rate, persistence, release/no replay, blur and unavailable behavior in a browser at phone/desktop widths in day/night. Inspect captures and measure legibility.
- [x] Run the required full page gate on the combined UI, without automatic geometry acceptance. Update R-CAM-11 and the blueprint manifest for the independent setting.

## Integration and deployment — lead

- [x] Inspect the combined diff and perform one focused independent review of the raised rate boundary and UI behavior.
- [x] Complete applicable combined tests/build, then record pending versus passed hardware evidence explicitly.
- [x] Install only changed files with originals backed up and expected runtime hashes checked. Use the established 45-second USB pause for core activation, preserve configuration/secrets and read-only root.
- [x] Verify services, all nine relevant runtime hashes and live Pocket capability; hand control to the operator for their evaluation. Do not report unperformed higher-rate measurements as passed.

Human acceptance: the operator selects FPV and uses the roll strip with short holds, then varies Roll max speed and checks smaller inputs for fine adjustment. The operator confirmed this test is in progress and asked the assistant to leave the controls with them. Smoothness, stopping behavior and preferred speed remain pending their feedback.

Final verification: 306 focused core tests, 1,173 widget tests, eight offline pulse-tool tests, four browser cases and all 219 full-page checks passed. Built and installed runtime hashes match. No higher-rate bench motion was sent; the operator owns the pending physical evaluation.
