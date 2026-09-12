# Onboard terrain preparation and serving

Status: approved by the operator on 2026-09-11; software implemented, target-hardware acceptance pending.
Baseline: main e1c4e1f5539f3353c3d50b029c2ba9727351a252, matching origin/main on 2026-09-11.

## Outcome and agreed scope

Yonder prepares official ArduPilot terrain data on persistent SD storage and answers the selected flight controller's terrain requests without an open browser or internet connection. Preparation, storage management and status belong on the existing flight PFD's Map, terrain & data surface. The controller owns terrain use, navigation and failsafes.

Use the ArduPilot service's JAXA ALOS-derived SRTM1 product and 30 m controller grid spacing. Retain the existing high-resolution Cove ground/surface pack for detailed display. Flight-related terrain datum calculations use the official source, with explicit provenance and compatible altitude references. Never substitute display terrain for missing official data. Neither dataset establishes current obstacle clearance.

This continues the approved terrain design after a firmware feasibility exercise. The bench HEEWING-F405v2 now runs a custom terrain-enabled ArduPlane 4.7.1 build. Capability, diskless configuration and a bounded simulated-GPS terrain exchange were observed; flight qualification has not been established. See the [bench evidence](../../terrain-controller-gps-simulation.md). Software must discover compatibility at runtime rather than assume this board or version.

## Existing foundation and requirement contract

Relevant existing requirements: R-FLT-02–06 (authenticated, reviewed commands and datum handling), R-FLT-08/09 (terrain and provenance), R-FLT-11 (explicit aircraft download selection), R-FLT-22 (route profile), R-FLT-23/26 (fresh bounded instrumentation), R-CMD-04/05 (operator command origin and autopilot validation), R-CFG-03 and R-NET-07 (configuration rollback and reachability), and applicable R-UI requirements.

Implementation adds stable R-FLT-27 for operator-enabled persistent official terrain preparation and bounded protocol serving, and R-FLT-28 for separate preparation/controller status and verified official terrain datum use. The architecture, configuration, cockpit guide and blueprint manifest carry the same boundary. Existing requirement IDs remain unchanged.

`packages/yonder-core/src/terrain/service.ts` validates bounded offline display packs but does not fetch data. The dedicated `packages/yonder-core/src/terrain/official/` runtime owns official-source preparation and request serving. `packages/yonder-core/src/mav/listener.ts` owns the existing loopback connection to mavlink-router; the router retains sole serial-port ownership. `packages/yonder-core/src/cockpit/routes.ts` and daemon wiring provide the authenticated interface. `OfficialTerrainPanel.vue` is hosted inside the PFD's Map, terrain & data surface. Flows remain wiring only.

## Selected approach and alternatives

The implemented dedicated official-terrain store and responder live within yonder-core, beside the existing display pack service. The fixed source uses official SRTM1/ALOS HGT tiles, preserving raw nodata, and reference-tested generation of requested 30 m subgrids. DAT-only storage was rejected because upstream conversion loses nodata identity; see [source findings](../../terrain-official-source.md). The store publishes one validated immutable raw HGT payload per source generation and tile, with bounded derived sample windows and subgrids rather than a second durable DAT dataset. A transient decoded block cache is bounded separately.

Reusing the existing detailed display pack was rejected: it has different coverage and provenance and is not the agreed official FC source. Browser-only serving was rejected because service must survive browser closure and loss of the ground link. The approved HGT adjustment adds maintained sampling and coordinate-conversion logic, so pinned numerical fixtures are required; it does not change the chosen elevation dataset.

## Preparation and storage lifecycle

An explicit Prepare action selects aircraft-side official downloads and presents area, source, spacing, estimated storage and current free space before starting. This is the opt-in required by R-FLT-11, independent of display-source preferences. Preparation is restricted to disarmed operation with a fresh arm state; loss of that state pauses new download work. Already validated data remains serviceable.

Two area inputs are supported: the current mission with home/rally return coverage, or a manually selected map area. Mission preparation binds to a mission revision and home/rally snapshot. Include continuous legs, declared loiter extents and return corridors, not just waypoint cells. Show a map preview and editable coverage buffer; require review of that buffer instead of asserting an aircraft-independent safe radius. Unresolved jumps, missing home, or unsupported route geometry prevent a complete mission-coverage claim. A route change marks the associated preparation stale without deleting data. Manual areas make no automatic mission-completeness claim.

A preparation job records selected bounds, revision, provider identity, dataset/version, grid spacing, vertical-reference evidence, timestamps, expected files, verified files, hashes and coverage. Publish each complete validated object atomically; interrupted downloads remain staging objects and are never sampled or transmitted. Reject traversal paths, symlinks, malformed archives, invalid coordinates, unsupported manifest versions and unexpected decompression size. Preserve source nodata in valid stored tiles; withhold affected samples/subgrids and report incomplete coverage instead of rejecting unrelated valid portions or converting nodata to a height. Record local hashes as integrity evidence, not as independent provider authenticity.

The storage location must resolve to the image's writable persistent data volume. Do not assume that temporary paths, browser storage or a writable overlay survives restart. If persistent writable storage cannot be established, report unavailable. Keep downloaded content out of `config.yaml`; its declarative policy owns enablement, quota and provider selection through the existing apply mechanism. The policy defaults to `enabled: false`, the only accepted provider is `ardupilot-srtm1`, and `quotaMiB` defaults to 2048. Preparation must satisfy that quota and preserve the device-wide `storage.reserve_mb` floor; it cannot lower or consume the shared reserve as extra terrain capacity.

Deduplicate by dataset revision, grid spacing and geographic object identity. Account for compressed objects, staging and metadata against a configured quota and reserve disk headroom. Preview estimates are distinguished from final measured bytes. Pinned prepared areas cannot be evicted automatically; active reads hold a reference. Evict only unpinned unused objects. If pinned content plus staging exceeds the budget, refuse further preparation with a useful explanation. Cancel removes staging; deleting an area removes its pin and deletes only unreferenced content. Source updates are explicit, validated alongside the previous generation and switched atomically; existing preparations remain bound to their recorded generation.

Initial runtime limits must be explicit in the implementation plan and validated on the target board. Download concurrency, decoded cache, queued requests and transmitted bytes all have independent hard caps. Avoid automatic upstream refreshes or internet fetches triggered by FC requests.

## Terrain protocol service

Persistent operator enablement permits only validated terrain data replies to the selected controller's TERRAIN_REQUEST messages. It is not authorization for COMMAND_LONG/INT, parameter writes, mission writes or any flight action. The responder remains distinct from the reviewed aircraft-command transaction service, and the listener's receive-does-not-send invariant is narrowed only for this explicit protocol role. Opening or polling the panel emits no aircraft traffic. The separate controller refresh begins only after an authenticated operator action and sends bounded read requests for capability, terrain parameters and rally points; it performs no writes or automatic configuration.

Validate frame CRC/signing policy, source system/component, selected vehicle identity and generation, geographic bounds, spacing and requested bitmask before serving. Use the existing routed connection rather than another serial client. TERRAIN_DATA has no target fields: include integration tests demonstrating delivery/routing isolation, and refuse ambiguous multi-vehicle attachment rather than broadcast terrain indiscriminately. Clear pending work on selected-vehicle or router-generation changes.

Only complete valid requested sub-blocks can be sent. Missing, corrupt or incompatible data remains unavailable; never invent zero elevation. Coalesce duplicate requests, bound retry work, pace the responder below telemetry capacity, and give existing operator command/mission traffic priority. Cache misses produce status without initiating internet access. Serving continues from persistent cached data while the browser is closed, including while armed; preparation does not change flight behavior.

Firmware version is informational, not sufficient proof. The explicit controller refresh discovers the terrain capability bit, relevant parameters and reported spacing; diskless deployments require the disable-disk option. Unsupported or stale observations display the exact mismatch. Operators perform refresh, mission/rally reads and preparation at a safe disarmed bench; the implementation enforces a fresh disarmed context before preparation. Any separately authorized FC configuration goes through the existing review, write and readback path. This feature does not automatically alter TERRAIN_FOLLOW, mission frames, arming checks or cache size.

### Multiple terrain responders — operator-managed ownership

The controller does not elect an authoritative provider. Matching replies from another GCS can overwrite or mix with Yonder data. The operator selected one active terrain responder per aircraft for this implementation: while Yonder serves, the operator disables terrain delivery in other ground stations. The PFD identifies this as operator-managed and states that exclusivity is not enforced.

Yonder can observe competition only on traffic copied to its existing router connection. A ground station connected directly to another FC UART, USB port or independent radio bypasses that boundary. Silence therefore cannot prove sole ownership, and Yonder sending a block or the controller reporting it loaded cannot prove exclusive Yonder provenance. No automatic failover or routing filter is authorized. The bypass limits and future enforced-ownership acceptance cases remain recorded in [terrain-provider ownership](../../terrain-provider-ownership.md).

## PFD behavior and datum handling

The existing Map, terrain & data controls now include official-source policy review, manual or verified-mission area preview, Prepare/Cancel, a prepared-area list, pin/delete controls, storage usage, source details and explicit controller refresh. They preserve the existing synthetic-vision and detailed surface controls. Status polling and page opening are passive.

Display three separate facts:

- Yonder coverage: not prepared, preparing, complete for selected area/revision, partial because of nodata or another named gap, stale, or storage/source failure.
- Service: disabled, waiting for controller, incompatible configuration, serving with requests/blocks sent, missing requested data, or link unavailable.
- Controller: fresh reported pending/loaded counts and spacing, waiting for position, or stale/unknown.

A transmitted block is not an acknowledgement that the FC loaded it. A report with pending=0 does not prove every future mission corridor is resident in FC RAM. Do not show a single flight-ready indicator. A controller reboot invalidates controller-loaded status while Yonder's stored coverage remains.

The existing detailed-display surface forecast retains its selected display source and verified display-datum gates. Label it as a detailed display forecast; it is not controller terrain coverage and never supplies a fallback for official AGL, home/mission estimates or target datum calculations.

Use the official sample path for flight-related terrain datum availability and conversion at each actual target coordinate. Match upstream FC interpolation with numerical fixtures; reject unsupported datum transformations and coverage gaps. Preserve the distinction between absolute MSL altitude, height above home, planned terrain-relative height and the FC's terrain-offset behavior. Never reinterpret existing mission altitude values when changing the selected display layer. Terrain-related flight actions retain existing reviewed-command gates and cannot become available solely because a download completed.

## Verification and acceptance

Software evidence covers upstream-reference HGT decoding, archive CRC/size/identity, manifest-version and grid tests; coordinate boundaries and negative elevations; corrupt/nodata handling; bounded archive processing; atomic publish and restart recovery; quota/pin/shared-object deletion; request-mask mapping and exact encoded replies; target/reboot isolation; responder ownership status; retry/rate/queue caps; no internet on request; no unsolicited aircraft command or parameter mutation; and source/datum/mission-revision gates.

Integration evidence: real daemon and routed MAVLink test with a compatible simulated controller, browser closed and network unavailable after preparation. Exercise controller reboot, interrupted download, missing tile, mismatched spacing, stale status, vehicle change and concurrent mission/command traffic. Demonstrate that terrain transmission does not starve command handling. Compare official sample values with the controller's terrain results at known locations.

UI evidence: real authenticated PFD actions, area and storage preview, success/cancel/failure/reconnect, disabled/incompatible states, both palettes and relevant tablet/laptop layouts. Use yonder-page-verification's focused iteration policy and all repository-required final gates; this design does not change CI requirements.

Hardware evidence remains pending: persistent-volume check and restart on the Radxa, actual requests/replies with a valid FC position, offline/browser-closed operation, loaded/pending observations, memory low-water and serial utilization during representative movement/coverage changes. The current bench state partition is smaller than the default shared storage reserve and must refuse preparation, so a suitable persistent allocation is required first. Current observations of limited FC RAM also remain an acceptance item, not a claimed pass. No arming or flight is required for the software milestone. Physical flight readiness remains separate.

## References and handoff

- [ArduPilot terrain service](https://terrain.ardupilot.org/): identifies the ALOS-derived SRTM1 product and 30 m setting.
- [ArduPilot terrain behavior](https://ardupilot.org/plane/docs/common-terrain-following.html): diskless mode, GPS prerequisite, coverage and 2026 legacy-data correction.
- [Official terrain generator](https://github.com/ArduPilot/terraingen): DAT generation and validation reference.
- [Existing terrain audit](../../cockpit-terrain-integration-audit.md).

The implementation plan and software verification record retain the task-level evidence. Keep software, integration and hardware acceptance separate; the completed software milestone does not close the remaining target-board or flight-readiness work.
