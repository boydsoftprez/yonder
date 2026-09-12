# Onboard terrain service verification

Requirements: R-FLT-27/28, R-CFG-03, R-NET-07 and R-STO-03.

This records software evidence for the unmerged terrain-service change. It does not establish flight readiness or replace the hardware acceptance below.

## Implemented boundaries

Yonder prepares the fixed official ArduPilot ALOS-derived SRTM1 source into immutable raw HGT objects. Source voids remain unavailable; a downloaded area containing voids is reported as partial. The service derives requested 30 m grid samples from bounded disk reads, preserving the exact request origin and withholding incomplete subgrids. It never downloads in response to a controller cache miss.

Preparation requires an explicit authenticated operator action and fresh disarmed vehicle context. Preview tokens bind reviewed geometry, buffer, source selection, policy and mission/home/rally context. The saved area retains that geometry and source generation. Policy uses the existing configuration apply/confirm/revert engine.

The responder uses the existing router connection, requires fresh compatibility observations, refuses ambiguous aircraft links and pauses for command transactions. Its queue, request lifetime, frame rate and serial byte budget are bounded. Controller reports and Yonder's sent count remain separate observations.

The operator selected **operator-managed single responder** for this PR. Disable terrain replies in other ground stations before using Yonder as the terrain source. Exclusivity is not enforced; direct controller connections can bypass Yonder's observation. See [provider ownership](terrain-provider-ownership.md).

## Recorded software evidence

- Official source fixtures preserve source hashes, row/column indices and pinned generator/controller references; see [source findings](terrain-official-source.md) and the [fixture README](../packages/yonder-core/src/terrain/official/fixtures/README.md).
- Combined terrain, daemon wiring and authenticated proxy run: **15 suites, 195 tests passed**. It includes archive type/CRC/size rejection, nodata, source-generation binding, conservative return geometry, filesystem admission, atomic metadata recovery, queue isolation and reboot freshness.
- The daemon integration test uses real Unix HTTP routes and UDP router packets. Its full-size synthetic HGT contains the official reference sample windows; it is not represented as a downloaded full official terrain tile. Assertions cover bits 0 and 55, missing tiles without fetching, offline restart, command priority, policy disable/re-enable and full configuration rollback.
- A follow-up regression reproduced a confirmed policy incorrectly retaining its pending identifier. The corrected pending-state condition and authenticated policy proxy checks passed **2 suites, 10 tests**.
- Full core run: **178 suites, 3,914 tests passed**. An earlier full run exposed a simulated-controller heartbeat gap during longer preparation; the harness now emits regular heartbeats without relaxing production freshness checks.
- Read-only storage observation regression: **4 suites, 15 tests passed**. An initial explicit write probe verifies writable storage; subsequent status and admission checks use filesystem observations without creating probe files.
- Six Node-RED service packages passed **365 tests**. The full dashboard run passed **89 suites, 1,015 tests**; a later deferred-sample freshness fix passed **3 affected suites, 14 tests**, including refusal after status failure/disable and subsequent recovery.
- Production workspace build and final TypeScript lint passed. Schema/defaults regenerated without drift. Shell checks and installer dry-run passed; installer library checks passed **16 tests**. Final affected UI checks passed **9 suites, 51 tests**, with the final mapped-surface refinement verified in **4 suites, 21 tests**.

The authenticated production-PFD browser harness passed **10 checks** covering preparation, edited-preview invalidation, cancellation, quota refusal, stale preview/policy, reboot/status failure, ownership wording, no flight-command requests and palette/layout checks. Terrain API responses in this harness are explicit fixtures. All 12 top/prepare/controller captures were visually reviewed at 1440×900 and 1024×768 in day and night palettes. Active terrain controls and source/status text measured at least **6.37:1 day** and **8.36:1 night** contrast; disabled controls are excluded explicitly. Artifacts are generated under `vendor/terrain-pfd-check/` and uploaded by CI.

The initial full local page gate recorded **218 passed, 1 failed**: the new terrain harness used an ambiguous cockpit selector. That selector was corrected; the focused terrain harness subsequently passed. Existing page geometry remained unchanged. The final full CI gate remains pending until the PR run completes; the focused result is not represented as a full-gate pass.

The R-FLT-22 mapped-surface profile is retained as an optional, separately sourced display overlay with survey metadata and verified EGM96 datum gates. It never replaces missing official ground or supplies terrain-relative waypoint conversion. Aircraft-sourced display loading still requires an explicit operator request.

One consolidated independent backend review identified six material issues: continuous return coverage, nodata completeness, exact metadata admission, source binding, persisted geometry and ZIP file-type validation. All six were corrected and the affected tests passed. The metadata writer admits the full replacement size and can release a preallocated 1 MiB application headroom file; it does not lower the shared free-space reserve.

## Remaining hardware acceptance

The current Radxa state partition is a writable persistent ext4 volume of approximately 512 MiB, with approximately 450 MiB free when measured. The default shared reserve is 1 GiB. Preparation must refuse this layout; a suitable persistent storage allocation is required before this PR can be tested end to end on that board. No storage resizing or reserve reduction is part of this change.

After suitable storage is available:

1. Establish a safe disarmed bench and a single terrain responder. Confirm controller identity, current firmware/configuration and the telemetry route before any test.
2. Use the PFD's explicit controller refresh. Confirm terrain support, enabled state and 30 m spacing are observed; an unknown observation must remain unavailable.
3. Preview a bounded manual area around the test position, inspect source/storage/coverage, and prepare it. Inspect any partial or missing-data reasons. Verify an interruption or quota refusal retains earlier prepared data.
4. With valid controller position, observe actual requests and replies. Close the browser and remove upstream internet access; serving must continue from prepared disk data without a fetch.
5. Move through representative block boundaries using the separately authorized safe position test method. Record controller terrain values, request/reply loss, UART utilization and minimum free RAM alongside ordinary telemetry/command traffic.
6. Reboot the controller and explicitly refresh compatibility again. Verify stale observations are not accepted as current and prepared disk data remains usable. Restart Yonder separately to verify persistent recovery.
7. Record remaining diskless-cache/prefetch and navigation limitations before considering flight acceptance. The earlier [simulated-GPS experiment](terrain-controller-gps-simulation.md) demonstrated feasibility but did not qualify healthy flight navigation.

Hardware persistence across a real power interruption, valid-GPS offline operation and representative flight-controller memory headroom remain pending. Sent replies and pending/loaded counters alone do not establish whole-route readiness.
