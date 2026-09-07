# Cockpit integration progress

Initial base: `0f1e9b92485a7f4e23c7d75a6e2fde195124a2ca` on
`claude/exciting-merkle-e4cd39`. Integration branch: `codex/single-glass-cockpit`.
The integration also includes that branch's subsequent camera UI fixes through
`22a3129b0c2e81c3881ef044c4ccb8cba8f80b94`. The source worktree is preserved.

- [x] Inspect source branch and create isolated integration worktree.
- [x] Repair base lockfile: MAVLink workspace was absent from package-lock.json.
- [x] Install dependencies and run baseline build/tests.
- [x] Record requirement IDs and production integration contracts.
- [x] Full MAVLink telemetry, command transactions, mission read/write and live feedback.
- [x] Authenticated console endpoints, daemon lifecycle and shipped cockpit wiring.
- [x] PFD-first Vue screen, touch mission editing, inset map and settings.
- [x] Prediction, correct CDI/FD/VSI and actual mode/target presentation.
- [x] Bounded ADS-B feed, range filtering and observed breadcrumbs.
- [x] Terrain package preprocessing, one-metre ground and LiDAR surface delivery.
- [x] Fixed ELP camera selection, calibration and scene-overlay validity gates.
- [x] Integrated browser/SITL verification, guide and source attribution.
- [x] Whole-change review, fixes, signed commits and merge-ready report.

Point-cloud viewing remains a stretch goal. No physical flight command or camera
calibration is claimed from fixture evidence. No changes have been deployed to hardware.

The cockpit extends the existing authored PFD, mission forms, renderer and tests.
Production changes replace the research-host interfaces with daemon-owned services
and native Vue composition. The original previews and source worktree remain separate.

Verification and limits are recorded in [the integration evidence](cockpit-integration-verification.md),
[control audit](cockpit-control-integration-audit.md), [terrain audit](cockpit-terrain-integration-audit.md)
and [walkthrough](cockpit-user-guide.md).
