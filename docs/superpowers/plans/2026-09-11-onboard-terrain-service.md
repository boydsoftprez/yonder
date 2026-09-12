# Onboard terrain service implementation plan

> Execution: yonder-cost-aware-execution. Requirements and acceptance criteria are binding; test order and review effort follow the Yonder risk-based policy. Use yonder-page-verification for console evidence where applicable.

**Goal:** Prepare official ArduPilot terrain on Yonder's persistent storage and serve it offline through the existing MAVLink route, with preparation and honest status on the PFD.

**Architecture:** A dedicated core terrain subsystem owns official blocks, preparation jobs and a bounded responder. The existing display pack remains independent. Authenticated cockpit routes expose preparation/status/samples; the current configuration apply mechanism owns persistent policy. The responder only answers admitted terrain requests and never originates flight commands.

**Stack:** TypeScript, Node.js 20+ core / Node.js 24 full console, existing node-mavlink 2.3.0, Zod, Node filesystem/zlib/HTTPS, Vue cockpit, Vitest and existing browser harness.

**Spec:** [Approved design](../specs/2026-09-11-onboard-terrain-service-design.md), approved 2026-09-11 after commit 519ada1.

## Global constraints

- Preserve CLAUDE.md, R-CMD-04/05, R-FLT-02–06/08/09/11/22/23/26, R-CFG-03, R-NET-07 and R-STO-01/03/05/06. Add R-FLT-27/28 without changing existing IDs.
- Official ALOS-derived SRTM1, 30 m grid; no display-terrain fallback or invented nodata. Preserve Cove display and original mission altitude values.
- Explicit aircraft download selection; preparation only while freshly disarmed. Offline serving can continue while armed. Browser reads and reconnects do not issue aircraft commands.
- Retain the current unsigned/CRC-validated decoding policy and rejection of signed frames without verification. Do not claim cryptographic source authentication from CRC.
- Use the existing router connection; no second serial owner. Ambiguous multi-vehicle links cannot serve untargeted TERRAIN_DATA.
- Persistent state must live on verified writable disk storage. Preserve the shared storage.reserve_mb reserve, configuration rollback and AP recovery.
- No live FC parameter changes, firmware flashing, arming or flight tests are part of implementation. Hardware verification needs a reachable board and valid FC position.
- Begin from the user's selected current-main checkout; the subsequent unmerged-PR goal authorizes the `codex/onboard-terrain-service` branch. Preserve unrelated untracked work. Use signed, DCO-signed commits. Push only to prepare the requested unmerged PR; do not deploy as a side effect of tests.

## Discovery gate status

Task 1 identified a material incompatibility between DAT-only storage and the approved missing-data contract. See [source findings](../../terrain-official-source.md). The operator approved using official HGT source tiles with preserved nodata, retaining the same ALOS dataset and 30 m request grid. The tasks below now use that approved HGT representation. Canonical persistent payloads are raw HGT files; ZIP input is bounded staging only, removed after verified publication. Sampling reads bounded row/windows from disk so a whole 25 MiB tile need not occupy the 16 MiB RAM cache.

The operator requested a real-controller memory feasibility check before the full build. See [bench evidence](../../terrain-controller-bench.md). GPS-free cache testing does not qualify autonomous request-driven operation, navigation memory headroom, or flight readiness. Controller status must preserve raw observations and their limitations; diskless pending/loaded counters alone cannot establish usable coverage. The later [simulated-GPS UART experiment](../../terrain-controller-gps-simulation.md) demonstrated request-driven replies across eight origins with 14560 bytes minimum observed free RAM. It does not qualify healthy flight navigation: aiding changes, RC failsafe mode changes, current-block availability gaps and diskless prefetch limitations remain recorded acceptance concerns.

The operator approved an operator-managed single-responder contract for this PR; see [provider ownership](../../terrain-provider-ownership.md). The PFD must state that exclusivity is not enforced and report observed competition. No routing filter or automatic failover is authorized. Exclusive FC source provenance cannot be claimed.

## Shared interfaces and initial limits

New modules live under `packages/yonder-core/src/terrain/official/`. `types.ts` owns wire-safe domain types shared by routes and tests; browser code consumes JSON, never Node modules.

- `TerrainPolicy`: enabled boolean, provider literal `ardupilot-srtm1`, quotaMiB integer. Add `terrain` to ConfigSchema with default disabled and quota 2048 MiB (range 128–32768). Root path is installation/runtime wiring, not an arbitrary URL/path accepted from the browser.
- `TerrainLocation`: `{lat: number, lon: number}` degrees; all geometry validates latitude/longitude and supported provider coverage. MAVLink coordinates stay integer degE7 in `TerrainRequestKey` together with `spacingM: 30`.
- `OfficialTerrainStore`: `status()`, `readSubgrid(key, bit, signal?)`, `sampleAt(location, signal?)`; unavailable results carry a reason rather than an elevation. Samples carry MSL/datum evidence, provider, dataset generation and spacing. Immutable committed objects are the only read source.
- `TerrainPreparationService`: `preview(input, context)`, `prepare(previewId, operator)`, `cancel(jobId, operator)`, `setPinned(areaId, pinned, operator)`, `remove(areaId, operator)`, `snapshot(context)`, `close()`. Preview tokens bind canonical area, source, mission/home/rally revision and policy generation; changed context requires a new preview.
- `TerrainResponder`: `receive(datagram)`, `snapshot()`, `configure(policy)`, `close()`. Receives an injected current vehicle snapshot, router generation, command-busy predicate, store and send path. All predicates are rechecked after asynchronous reads and immediately before sending.
- `TerrainStatus`: independently versioned coverage, service and controller sections; nullable observations include source identity, generation, observed time and freshness. Never collapse these into flight readiness.
- `TerrainRuntime`: composes store/preparation/responder, implements `render(config)` for policy changes, supplies cockpit service routes, and receives datagrams after VehicleService. Storage failure becomes status without throwing through network configuration or stopping telemetry.

Initial resource limits: one download/job at a time; at most 32 degree objects per preview and 32 saved areas; 16 MiB decoded cache; 64 queued subgrids; requests expire after 5 seconds and require a fresh controller request for retry; at most 10 data frames/second with one-frame burst and a byte budget no higher than 10% of configured serial capacity (8N1). Pause terrain sends while a command/mission transaction is active. No telemetry work runs synchronously through disk decompression. Metadata limit 1 MiB, compressed-object limit 64 MiB, raw HGT payload exactly 25,934,402 bytes (3601×3601×2 signed big-endian samples); streaming decompression must enforce this size, ZIP CRC and a single canonical member. The decoded RAM limit covers row/window and derived-grid caches together, not whole-tile reads. Task 1 must verify these bounds accommodate supported upstream objects before implementation is accepted; reject oversize data explicitly rather than removing limits. No timer writes persistent state merely to update progress or last-access statistics.

## Task 1 — Establish official format, persistence and reference fixtures

**Requirements:** R-FLT-27/28, R-FLT-08, R-STO-03. **Dependencies:** none.
**Owned files:** `docs/terrain-official-source.md`; `scripts/terrain/official-fixtures.py`; `packages/yonder-core/src/terrain/official/fixtures/` with README, provenance and small binary fixtures. Tests first belong to Task 2.
**Deliverable/interfaces:** pinned download/format contract, representative valid and invalid reference blocks, expected sample/subgrid results and verified storage observations. Finalize `TerrainRequestKey` mapping from upstream rather than guessing geographic rounding.

- [x] Pin official terraingen and exact ArduPilot references and inspect the official SRTM1 HGT ZIP URL contract, single-member identity, dimensions, signed-byte order, archive CRC and upstream interpolation. Record attribution and hashes. Do not execute downloaded pickle files.
- [x] Acquire a bounded real official object; extract small fixtures with source coordinates, source row/column offsets, manifest format version and independent expected values. Small sample-window fixtures are not themselves whole downloadable HGT tiles. Include negative coordinates, overlap/boundary, unsupported manifest-version rejection and negative valid elevation. Generate corrupt/nodata fixtures explicitly from valid fixtures and document mutations.
- [x] Resolve the DAT nodata ambiguity: the operator approved official raw HGT with preserved -32768 nodata, no durable DAT copy.
- [x] Finalize request-origin to degree-tile/sample-window mapping, including overlap into neighboring tiles, against pinned ArduPilot/terraingen references. Keep signed-coordinate rounding and float32 longitude scaling explicit.
- [x] Inspect `/var/lib/yonder` mount on the Radxa if reachable. Collect findmnt/statfs evidence and filesystem persistence without altering storage or restarting the board automatically. The reachable board confirms ext4 persistence but insufficient state-volume headroom under the default reserve; record that refusal and design production admission from mountinfo plus a writable-directory probe.
- [x] Record expected whole-object and transient storage costs and reject downloads exceeding limits before publication.

**Verification:** source-grounded experiment with bounded network reads; fixtures independently decoded by upstream code and hashed. No flightcontroller data injection. Advisory worker: Sol/high for format uncertainty; lead owns hardware, filesystem admission and decisions.

## Task 2 — Strict block codec and official sampling

**Requirements:** R-FLT-27/28, R-FLT-05/08. **Dependencies:** Task 1 format contract. The settled raw-window format permits the isolated decoder now; request mapping and serving remain gated on the remaining coordinate reference cases.
**Owned files:** `official/types.ts`, `official/hgt.ts`, `official/hgt.test.ts`, `official/grid.ts`, `official/grid.test.ts` and fixture tests.
**Interfaces:** validated immutable tile metadata and bounded signed-height windows; `decodeHgtWindow(bytes, expected)`; request-to-source-window lookup and `sampleAt` matching the pinned AP_Terrain interpolation. No HTTP, filesystem traversal, network sends or configuration writes in the codec.

- [x] Establish regression fixtures for source byte order, tile/window identity, coordinate conversion and manifest versions before enabling sampling. Archive CRC validation belongs to the provider in Task 3.
- [x] Implement exact raw tile/window lengths and bounded row/column/stride, spacing and coordinate validation. Interpret samples as signed big-endian int16. Preserve -32768 as unavailable and withhold any affected interpolation/subgrid; zero, -1 and other valid negative elevations remain valid. HGT has no embedded DAT header, bitmap or format CRC; validate provenance/version separately in the manifest.
- [x] Implement 4×4 requested subgrid extraction and source-key mapping, including overlapping block edges. Preserve the exact incoming request origin in replies.
- [x] Implement official point sampling with explicit missing data and datum evidence. Match upstream numerical behavior, including signed-coordinate rounding and grid-edge interpolation.

**Acceptance:** bit0 and bit55 return the correct 16 values; big-endian/little-endian mistakes fail fixtures; short or wrong-identity windows, unsupported manifest versions/spacings and contributing nodata never yield height data; boundary control points match independent reference. **Verification:** `npm run test -w yonder-core -- src/terrain/official/hgt.test.ts src/terrain/official/grid.test.ts --maxWorkers=4 --minWorkers=1`. Worker eligible after Task 1; no shared-file edits outside ownership.

## Task 3 — Persistent store, bounded downloader and atomic preparation jobs

**Requirements:** R-FLT-27, R-FLT-11, R-STO-01/03/05/06, R-CFG-03. **Dependencies:** Tasks 1–2.
**Owned files:** `official/storage.ts`, `official/storage.test.ts`, `official/provider.ts`, `official/provider.test.ts`, `official/store.ts`, `official/store.test.ts`, `official/preparation.ts`, `official/preparation.test.ts`.
**Interfaces:** implement OfficialTerrainStore and TerrainPreparationService; injected clock/fetch/storage probe permits deterministic tests. Provider accepts canonical object keys only, with a fixed HTTPS origin/path contract, bounded redirects and abortable downloads.

- [x] Resolve root beneath `/var/lib/yonder/terrain` (injected temp directory only in tests), verify persistent writable filesystem, reject tmpfs/ramfs/overlay-only and read-only paths, and preserve symlink restrictions.
- [x] Stream ZIP downloads/decompression under independent compressed/raw/staging/reserve limits. Reject extra members, encryption, unsupported compression, unsafe names, size mismatch and CRC failure. Validate the single 3601×3601 raw HGT payload before fsync/rename publication; retain archive/payload hashes and source metadata, then remove compressed staging. Read bounded raw windows for serving without synchronous decompression or whole-tile RAM loads. Retry transient failures at most twice with bounded backoff; honor Retry-After within job lifetime; no retries on format rejection.
- [x] Save versioned manifests and areas with durable atomic replacement. Scan bounded metadata on restart, ignore/reclaim staging, and recover only complete committed objects. Never persist high-frequency counters.
- [x] Deduplicate immutable objects; pins and active reads prevent deletion; quota failure leaves prior generations usable. Recheck free bytes during writing, accounting for other writers such as recording.
- [x] Implement cancellation and disarmed/fresh-context pauses without publishing partial data. Revalidate preview context and source generation before starting and publishing the area manifest.

**Acceptance:** power-cut injection at write/fsync/rename stages preserves old complete data; restart resumes with honest interrupted-job state; deleting one of two sharing areas retains shared content; pinned-full quota refuses without eviction; mid-download reserve exhaustion aborts safely; corrupt data never enters serving cache; source update failure retains previous generation; cache miss never downloads. **Verification:** focused store/provider/preparation Vitest tests on real temporary filesystem, plus Linux mountinfo fixture tests. Hardware persistence remains pending until observed.

## Task 4 — Mission/manual coverage and provenance

**Requirements:** R-FLT-27/28, R-FLT-04/05/22. **Dependencies:** Task 2; can develop with Task 3 after shared types settle.
**Owned files:** `official/coverage.ts`, `official/coverage.test.ts`; narrow additions to mission/home/rally read support if needed, with tests in `mav/mission.test.ts` / `mav/vehicle.test.ts`.
**Interfaces:** discriminated manual-area and mission-area PreviewInput; result contains canonical geometry, required objects, storage estimate, revision fingerprints and unresolved reasons. Mission reads remain explicit operator actions.

- [x] Enumerate complete route corridors and loiter extents plus home/rally return corridors using a reviewed positive buffer and bounded geometry work.
- [x] Handle geographic degree boundaries and longitude wrap explicitly. Refuse oversized/unbounded geometry rather than truncating it into apparently complete coverage.
- [x] Detect unsupported jump/return/landing geometry, missing home and unknown rally state; preserve an incomplete preview with actionable reasons. Do not equate unknown rally state with zero rally points.
- [x] Bind selected mission/home/rally identities and source revision into preview token; mission changes make coverage stale, never mutate waypoint altitude values.

**Acceptance:** a ridge midway between waypoints lies within prepared coverage; route changes invalidate completeness; loiter and each return corridor are included; unresolved jump cannot be marked complete; antimeridian geometry never expands to a world download; manual area remains usable with explicit bounds even without a mission. **Verification:** pure geometry fixtures and mission-read integration tests; physical flight-path completeness is not asserted for unknown commands.

## Task 5 — Protocol admission, pacing and honest controller status

**Requirements:** R-FLT-27/28, R-CMD-04/05, R-FLT-02/04/23/26. **Dependencies:** Tasks 2–3.
**Owned files:** `official/responder.ts`, `official/responder.test.ts`, `official/compatibility.ts`, `official/compatibility.test.ts`; narrow listener/VehicleService integration and relevant tests.
**Interfaces:** TerrainResponder with sole allowed outgoing automatic message TERRAIN_DATA; generation-bound read-only compatibility observations. Manual capability/parameter refresh uses an explicit authenticated action; never poll aircraft commands just because the page opened.

- [x] Resolve and test the [provider-ownership contract](../../terrain-provider-ownership.md): identical and conflicting responders in both arrival orders, late competition, reconnect, handover, and a direct-FC bypass route. Distinguish observed competition, operator-declared policy and enforced exclusivity; no silent routing changes or automatic fallback.
- [x] Decode requests through existing CRC/envelope validation and observe all autopilot heartbeats to detect ambiguity. Require a single admitted FC, fresh identity and matching spacing/configuration/capability evidence.
- [x] Request/observe TERRAIN_ENABLE, TERRAIN_OPTIONS and TERRAIN_SPACING through an explicit refresh action if not already available. No parameter writes in responder. Unknown compatibility remains unavailable with refresh guidance.
- [x] Implement queue deduplication, expiry, cancellation, byte/frame pacing and busy priority; recheck identity, policy and link immediately before send.
- [x] Encode requested complete subgrids with exact origin/spacing/bit. Missing tile produces status only. Ignore out-of-range bits, coordinates, unrelated sources and incompatible packets.
- [x] Track TERRAIN_REPORT separately from transmitted counters; expire on stale heartbeat/reboot/reconnect and show reported pending/loaded without extrapolating mission readiness.

**Acceptance:** disabled/open-page/reconnect emit no commands; requests for missing tiles cause no fetch; arbitrary commands cannot use this send path; second FC suppresses replies; async completion after reboot sends nothing; floods stay within caps; active command/mission work wins; pending=0 is not converted into whole-mission loaded. **Verification:** deterministic clock tests, encoded frame decoding assertions, existing protocol/listener/vehicle tests; one consolidated independent review of this boundary with storage/auth before final integration.

## Task 6 — Declarative policy, authenticated APIs and daemon lifecycle

**Requirements:** R-FLT-02/11/27/28, R-CFG-03, R-NET-07. **Dependencies:** Tasks 3–5.
**Owned files:** `schema/config.ts` and tests; `config/schema/yonder.schema.json`, `config/defaults/config.yaml`; `official/runtime.ts` and tests; `daemon/server.ts` and wiring tests; `cockpit/routes.ts` / new `official/routes.ts` and tests; `console/cockpit.ts` and proxy tests.
**Interfaces:** GET `/cockpit/terrain-service` status; POST `/cockpit/terrain-service/preview`, `/prepare`, `/cancel`, `/pin`, `/remove`, `/refresh-controller`; POST `/cockpit/terrain-service/samples` bounded read-only point batch. Browser gateway mirrors paths under `/cockpit/api/`. Bodies strict and <= existing proxy cap. Service policy changes use the existing configuration apply/confirm flow, not a new writer.

- [x] Add default-disabled policy and schema/default generation; integrate runtime render with rollback to the previous policy. No network reconfiguration is introduced by terrain.
- [x] Assemble optional runtime once, route packets after VehicleService, and close jobs/timers/readers on shutdown. Faults keep console and telemetry alive.
- [x] Add authenticated routes with server-derived operator context, idempotent job operations, strict limits and no arbitrary source paths/URLs. Read-only samples need authentication but do not require disarmed state.
- [x] Make capabilities, storage failures and missing prerequisites explicit; show source/generation in responses. Prevent prepare when armed, stale or changed vehicle/mission context.

**Acceptance:** unauthenticated and cross-origin mutations denied; duplicate prepare creates one job; policy apply rollback restores enablement/quota; restart default remains disabled unless saved config enables; malformed storage does not break network apply; sample gaps remain null. **Verification:** routes/proxy/wiring/apply tests, `npm run schema -w yonder-core`, `npm run defaults -w yonder-core`, inspect generated diffs.

## Task 7 — PFD preparation workflow and official terrain datum path

**Requirements:** R-FLT-08/11/22/25/27/28 and applicable R-UI. **Dependencies:** Tasks 4 and 6.
**Owned files:** `packages/node-red-dashboard-2-yonder/src/ui/cockpit/OfficialTerrainPanel.vue`, `official-terrain-state.mjs`, `official-terrain-client.mjs` and their tests; `src/ui/YonderCockpit.vue`, `cockpit/PfdControlPanel.vue`, `cockpit/PrimaryFlightDisplay.vue`, `cockpit/mission-terrain.mjs`, `cockpit/mission-home-terrain.component.test.ts`, `cockpit/mission-terrain.test.ts`, and cockpit CSS. Keep service client, prepare panel and status mapping separate. Update `docs/console/design/blueprint-manifest.md` and cockpit guide with delivered controls.

- [x] Add terrain-service client and independent slow-status polling, canceled on component teardown; no aircraft refresh on page open.
- [x] Add Map, terrain & data preparation view: manual map area or mission, editable buffer, preview overlay, source/space summary, explicit Prepare/Cancel, areas and pin/delete, service enablement via configuration flow, explicit controller refresh.
- [x] Present coverage/service/controller states independently, including paused/stale/incompatible/missing data; add compact PFD entry. Keep display source and detailed terrain controls intact.
- [x] Route flight-related estimated AGL and target terrain-datum checks through official samples with source/datum validity. Preserve existing mission values and detailed surface visualization; unknown source/datum fails closed.
- [x] Add authenticated browser scenarios for prepare success/cancel/error, stale revision, quota failure, controller reboot and palette/layout usability.

**Acceptance:** browser closure does not stop serving; changing display layers does not alter mission altitude; no official coverage means no official datum result; sent tiles and loaded tiles are visibly distinct; all controls work at laptop/tablet widths with readable both-palette states. **Verification:** focused component/client tests, relevant cockpit suite, actual authenticated browser interactions/captures, then repository-required full page gate. Human usability scenario: operator prepares the intended area and identifies storage versus controller status; report pending until observed, not as a substitute for functional tests.

## Task 8 — Integrated verification, documentation and hardware evidence

**Requirements:** all above. **Dependencies:** Tasks 1–7.
**Owned files:** `scripts/terrain/verify-service.mjs`, integration tests/fixtures; `docs/requirements.md`, `docs/architecture.md`, `docs/configuration.md`, source guide and an execution ledger/evidence report.

- [x] Add R-FLT-27/28 and update architecture/configuration/blueprint and command-role documentation alongside implementation.
- [x] Run simulated-controller end-to-end tests through daemon/router: actual prepared official fixture, browser closed, upstream unavailable, repeated/rebooted/partial requests, concurrent command operation and numerical terrain result comparison. Do not simulate success by directly calling store-only methods.
- [x] Perform one consolidated independent review of requirements, storage durability, packet isolation and command ownership. Correct material findings and rerun only affected checks before the final combined gate.
- [ ] Run `npm run version:check`, `npm run lint`, `npm run test --workspaces --if-present -- --maxWorkers=4 --minWorkers=1`, `npm run build`; regenerate schema/defaults and ensure no unexplained drift. Run applicable installer tests and `./scripts/verify-pages.sh` with its actual prerequisites. Do not auto-accept geometry snapshots.
- [ ] When reachable, verify Radxa storage persistence and FC terrain exchange with valid GPS, offline/browser-closed and controller reboot cases; record free memory and link budget under representative coverage changes. Missing hardware prerequisites remain explicit pending acceptance, never relabeled passed.
- [ ] Save exact evidence and remaining limitations, signed commits, and final status. Do not claim flight readiness or completion of pending hardware acceptance.

## Baseline and execution ledger

- Approved design: 519ada1; no terrain implementation at planning start.
- Dependency restore: npm ci from unchanged lockfile; missing node-mavlink corrected locally.
- Baseline: 7 terrain/listener/protocol suites, 37 tests passed.
- Hardware: SSH restored after operator supplied its new address. `/var/lib/yonder` is a writable ext4 bind on the 512 MiB state partition, with about 450 MiB free; captures is a separate 1.2 GiB partition. Preparation must refuse the state volume under the existing default 1 GiB reserve. No partition/reserve change is authorized by this plan. Hardware end-to-end preparation requires suitable persistent storage; protocol and software tests can proceed.
- Owners: lead owns shared types, config/daemon/requirements, Git and hardware; scoped workers may own codec, storage or PFD only after interfaces and prerequisite tasks settle.
- Reference fixture milestone: committed generator and bounded raw HGT windows for bits 0 and 55, with source offsets, hashes, expected samples, synthetic nodata and valid negative/zero cases. Two independent generation runs matched the repository byte-for-byte; invalid archive and nonempty output were rejected. The fixture worker checked all 32 grid samples against pinned upstream helpers; lead independently checked raw row 1080/column 2304 = 741 m and the payload hash. Task 1 remains open for complete neighboring-degree mapping, unsupported-version/corruption cases and admission-bound verification.
- Decoder milestone (R-FLT-27/28): isolated `decodeHgtWindow` validates schema version, canonical tile identity, original indices, dimensions and byte lengths; private copied int16 samples preserve nodata and valid negative/zero heights. Per-window allocation is bounded; aggregate cache accounting remains the store’s responsibility. Lead-reviewed checks: 6 terrain suites / 33 tests passed, including 14 decoder cases; core build passed. No runtime/export or responder wiring is enabled.
- Coordinate investigation: signed degree selection uses floor; a southern/western reference block crosses into a different HGT tile on both axes. The pinned generator does not wrap longitude like the controller. Source notes record this distinction; antimeridian and incoming-origin recovery remain unqualified.
- Current implementation milestone: Tasks 1–6 have source/grid, bounded downloader, durable store, preparation, coverage, responder, explicit controller refresh, policy and daemon routes implemented. The initial coordinate uncertainties above are resolved by neighboring-degree reference fixtures and bounded antimeridian tests; this is representative numerical evidence, not exhaustive geographical qualification.
- Combined lead verification: 15 suites / 195 tests passed, including all official terrain suites, authenticated console proxy and daemon wiring. The real daemon integration uses Unix HTTP and UDP router traffic, prepares a full-size synthetic HGT carrying official reference windows, verifies bit 0/55 values, offline reopen, missing-data withholding, reboot invalidation, command priority, enable/disable and real configuration rollback. No connected aircraft was altered by these checks.
- Consolidated backend review completed. Corrected continuous return-area coverage, source-nodata completeness, exact metadata replacement admission, preview-bound source generations, persisted reviewed geometry/buffer, and ZIP member file-type validation. Metadata admission retains a preallocated 1 MiB application headroom file; the shared storage reserve is never reduced.
- PFD preparation controls and terrain-only reviewed policy apply/confirm/revert are implemented; worker reports 35 focused/component tests and dashboard build passed. Flight-related datum integration and actual authenticated browser scenarios remain in progress. Detailed rendering remains independent.
- Owners now: lead owns integration, backend, browser checks, evidence, plan and Git; scoped UI worker owns remaining official-datum wiring; scoped documentation worker owns architecture/configuration/blueprint/operator-guide/spec updates. No hardware action is underway.
- Remaining gates: finish datum wiring, inspect browser interactions and both-palette laptop/tablet captures, run final workspace/installer/page checks, update evidence and create a signed, unmerged, mergeable PR. Current Radxa storage cannot satisfy preparation reserve admission; hardware acceptance and flight readiness remain pending.
- Final backend check: 178 core suites / 3,914 tests passed after correcting the integration peer to emit regular heartbeats during preparation. Configuration pending-state regression fixed; schema/default regeneration has no drift. Shellcheck, installer dry-run and 16 installer-library tests passed. See [verification report](../../terrain-service-verification.md).
- Backend saved in signed/DCO commit `62b0f6e`. A regression test now proves repeated storage observations create no write probes; the actual write check occurs at store initialization. Affected storage/daemon suites passed 15 tests. Six Node-RED service packages passed 365 tests. UI, browser evidence and final PR remain in progress.
- PFD datum integration complete: official MSL ownship/mission/profile/home samples; native frame 10/11 offsets preserved; unsupported terrain-relative GUIDED targets remain refused. Detailed display forecast is explicitly separate. Full dashboard tests passed 1,015 tests; late-sample failure/disable regression and recovery passed the affected 14-test run. Final production build/lint passed. Authenticated browser script is integrated in the required page gate; browser/visual evidence and PR are next.

- Final UI corrections: edited inputs invalidate previews, late preview responses cannot restore old inputs, and hidden/degenerate map bounds are rejected. R-FLT-22 detailed mapped-surface overlay restored separately with verified EGM96 provenance and explicit aircraft-download consent. Affected checks passed 51 tests; final overlay refinement passed 21 tests. Production dashboard build and workspace lint passed.
- Authenticated terrain browser harness passed 10 checks; 12 laptop/tablet day/night captures reviewed, minimum active text contrast 6.37:1 day and 8.36:1 night. Initial full local page run: 218 passed, 1 new-harness selector failure, subsequently corrected and focused-retested. No geometry baselines changed. Full final CI remains required.
