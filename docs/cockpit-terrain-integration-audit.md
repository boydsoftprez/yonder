# Terrain, traffic and camera integration audit

Audit date: 2026-09-07. Baseline: `0f1e9b92485a7f4e23c7d75a6e2fde195124a2ca`.
Scope: the [approved cockpit design](cockpit-integration-design.md), including one metre nearby terrain, a LiDAR-derived canopy/roof surface, bounded detail and caching, and a fixed forward ELP USBGS1200P01-H120 camera. Full point-cloud inspection is a stretch goal. This audit does not establish physical camera registration or current obstacle completeness.

## Existing production foundation and gaps

| Area | Available in the baseline | Required integration |
| --- | --- | --- |
| Telemetry | Read-only MAVLink heartbeat scanner and loopback listener, independent of routed GCS traffic | Selected vehicle flight fields, source timestamps, reboot epochs, field ages, altitude reference and historical pose |
| Media | One GStreamer capture/decode path, full and inexpensive preview encodes, mediamtx WHEP, authenticated media routes, still fallback, camera orientation and path statistics | Frame capture identity/time propagated through both encodes, verified browser correlation, calibration profile and pose history |
| Browser video | `YonderPicture.vue` measures the real image rectangle and handles media states | Its `Date.now()` on `timeupdate` establishes arrival health only; it cannot align terrain with exposure time |
| Terrain | No production dataset or terrain service in the baseline | Versioned offline packs, DTM and surface sampling, bounded LOD, data provenance, datum transformations and explicit missing coverage |
| Traffic | `remote/traffic.ts` measures network traffic | An aircraft traffic provider, shared bounded cache, datum normalization, observation histories and attribution |
| UI | Vue instruments and custom Node-RED packages | Cockpit terrain renderer, map and registered camera overlay with independent validity states |

Logic belongs in `yonder-core` and thin `node-red-contrib-yonder-*` adapters; Vue owns presentation. Flows remain wiring only. Existing video, authentication, preview/full selection, recording and stale-image behavior must survive the integration. Terrain and traffic never send aircraft commands. Existing requirements include R-TEL-01–07, R-TEL-11–15, R-VID-03/09/13/14/19, R-CAM-02/05/14 and R-CMD-04/05. The approved detailed terrain, aircraft traffic and registration behavior needs explicit additional requirement IDs, linked to the cockpit manifest and tests.

## Prototype findings

The reviewed terrain prototype uses WebGL 1, a reusable grid and fine/coarse edge stitching. It has frustum rejection, bounded memory, generation cancellation and stale/context-loss fallbacks worth retaining. Its Terrarium elevation input is approximately 31 metres between samples near the mission, with approximately 31 m nearby mesh spacing and 62 m farther mesh spacing. Its near imagery reaches roughly one metre per pixel. Image sharpness does not increase elevation resolution. There is no canopy or roof geometry, forward terrain warning or autopilot terrain-data delivery.

The prototype terrain projection is deliberately matched to its virtual attitude display, with a fixed view box and pixels-per-degree scale. It is not a camera calibration. Pose smoothing with a fixed display delay is useful for presentation but does not establish video synchronization. The prototype sampler's nearest-edge fallback must not become a clearance measurement outside known coverage.

The prototype aircraft traffic implementation provides useful foundations: a single watched provider poll, fixed upstream host, bounded response and track/history sizes, polling backoff, observation ages, expiry, radius filtering and gap-aware observed breadcrumbs. Its synthetic-vision traffic projection uses the virtual PFD camera. A real camera needs its own validated geometry and frame-time pose. Barometric traffic altitude cannot substitute for a geometric altitude with a known datum.

## Verified source candidates and coverage

Mission reference: 35.9607874° N, 83.3668696° W. Metadata was inspected; the large source files and their binary headers were not downloaded during this audit.

| Product | Metadata findings | Delivery consequence |
| --- | --- | --- |
| [USGS one metre DEM x28y399](https://www.sciencebase.gov/catalog/item/5eace8ab82cefae35a2491fc) | Bare earth; one metre; NAD83 UTM horizontal coordinates in metres; NAVD88 heights in metres. Bounds −83.441737309 to −83.3280511409 longitude, 35.9417622282 to 36.0297445347 latitude. GeoTIFF 292,951,163 bytes. | Covers the mission reference and route bounds. Read actual WKT, units and nodata from the file before processing. |
| [USGS LiDAR 2738597NE](https://www.sciencebase.gov/catalog/item/64dbbb3bd34e5f6cd55223d7) | LAS/LAZ 1.4; 91,700,533 bytes. Bounds −83.3743072200204 to −83.3502980953914 longitude, 35.95629067224212 to 35.96779333856336 latitude. | Covers the reference point but misses southern route points, including latitudes 35.95547, 35.95401 and 35.95525. Acquire adjoining tiles for the whole route and loiter/clearance buffer. |

Both surveys ran **2016-02-05 through 2016-04-04**. Later publication or catalogue modification dates do not refresh the observations. Trees and structures can have changed since 2016.

The [project metadata](https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/metadata/TN_Eastern_TN_LiDAR_2016_B16/TN_Eastern-2-16-B16-Del2_2016/best_use_xml/DEM_1.2_East_TennesseeFY16_Lidar.xml) identifies the original LiDAR coordinates as **NAD83(2011), Tennessee State Plane, US survey feet**, and heights as **NAVD88 using GEOID12B, US survey feet**. One US survey foot is exactly 1200/3937 metres. This differs from the derived standard DEM's horizontal CRS and units. The metadata describes 0.7 m nominal pulse spacing and classified tiles; it does not prove the actual file contains complete vegetation/building classifications. Inspect CRS VLR/EVLR records and a class histogram before selecting filters.

### Reproducible preparation

1. Resolve catalogue metadata and tile footprints for the complete mission corridor plus a declared buffer. Store source URLs, sizes, hashes, survey dates, CRS WKT, units, vertical reference and license in an ingest manifest. Enforce source-size limits and an explicit cache directory.
2. Run optional pinned PDAL/GDAL/PROJ preparation tools on a development workstation. Do not add geospatial native libraries to the board's boot path. Keep the input and canonical intermediate files in a task cache; commit only code, small attributable demonstration packs and manifests.
3. Read and transform the actual source CRS. Align the one metre DTM and LiDAR on the same horizontal grid. Compare transformed class-2 ground against the DTM at valid control samples. A large or spatially varying offset is a failed ingest, not a value to hide by arbitrary bias.
4. Build the surface from valid returns after rejecting withheld/noise points. Preserve highest valid return, observed coverage, point count and classification quality per cell. Where classes support it, distinguish vegetation and buildings; otherwise name it an elevated surface. Do not infer roofs or trees solely from an unclassified height.
5. Preserve nodata holes. Interpolation and neighborhood radii must be explicit, bounded and recorded. PDAL's [GDAL writer](https://pdal.io/en/latest/stages/writers.gdal.html) can rasterize maximum heights; its search radius can extend observed support, so a separate coverage mask is required.
6. Keep lossless one metre canonical rasters, optionally [Cloud Optimized GeoTIFF](https://gdal.org/en/stable/drivers/raster/cog.html), and generate compact runtime tiles with checksums. Use coarser visual levels farther away; retain conservative maximum-height summaries for warning queries. Averaging a narrow obstacle out of a distant visual tile must not remove it from clearance calculations.
7. Publish a pack manifest with actual coverage, reference systems, transformations and missing tiles. The runtime checks hashes, dimensions, bounds and byte limits. An incomplete surface pack can display its known footprint but cannot claim the whole route is covered.

A 2.5D surface supplies visible canopy and roof heights. It is not a mesh of every wall, a wire inventory, a current obstacle database or the stretch point-cloud viewer. No vertical exaggeration should be applied when comparing flight heights.

## Datum and clearance rules

Keep these distinct: altitude above home, barometric altitude, named orthometric height, ellipsoidal height, clearance above bare earth and clearance above mapped surface. PFD or mission units do not silently change dataset units. Browser terrain availability does not establish ArduPilot terrain-relative mission support.

Use a documented common height reference before subtracting elevations. A GPS field named MSL does not identify a geoid model by itself. When telemetry's ellipsoidal height is available and its quality is valid, it can be compared with data transformed into that ellipsoidal reference. For a named orthometric model, `ellipsoid height = orthometric height + geoid undulation`; a [PROJ vertical grid transformation](https://proj.org/en/stable/operations/transformations/vgridshift.html) also needs the appropriate horizontal realization and grids. NAVD88/GEOID12B is not interchangeable with EGM96.

The prototype's NGA EGM96 grid supports WGS84 ellipsoid-to-EGM96 conversion for traffic when the input is genuinely ellipsoidal. Its interpolation error does not represent GNSS accuracy, map accuracy or camera alignment. It cannot establish NAVD88 conversion by assertion. Missing transformation grids or unknown telemetry datum make numerical terrain clearance and registered warning coloring unavailable; conventional flight instruments may continue.

Every pack carries the source and output vertical reference and the exact transformation/grid provenance. Until independently checked control points pass, mark the transform unverified and inhibit datum-dependent warnings.

## Runtime terrain delivery and resources

Use frontend-safe TypeScript for pack types, sampling, projection and validity. Keep filesystem serving in a separate Node module so browser imports do not pull Node built-ins. A thin node adapter exposes the pack and tile route; executable UI code remains locally served.

A regular tile grid with bounded vertex counts permits reusable indices and WebGL 1 support. Use a near one metre level with 2/4/8 m or coarser distant levels, chosen from pixel error and a hard resource budget. Generate or decode tile meshes in workers; abort obsolete generations on location/pack changes. Bound CPU work per turn, concurrent reads, resident tile count, texture memory and disk cache. Cache identity includes pack revision and tile hash. Limit requests to files named by a validated manifest; reject traversal and oversized payloads. Pause hidden rendering and recover from WebGL context loss with a named unavailable state.

These are resource policies, not a frame-rate claim. Headless software rendering does not establish Raspberry Pi or tablet performance. Measure frame time, dropped frames, memory, CPU and thermal behavior on the target equipment.

## Fixed forward camera and frame timing

The [hardware record](hardware/usb-camera-on-a-pi-4.md) identifies the ELP USBGS1200P01-H120 as a global shutter USB camera with native 1920×1200 imagery and MJPEG formats. It has no measured optical calibration in the baseline. The model suffix or advertised field of view cannot replace intrinsic calibration; global shutter does not establish an exposure timestamp.

A versioned calibration profile must bind:

- Physical camera identity and mount, source resolution, crop, digital zoom/focus settings and distortion model.
- Intrinsic matrix and distortion coefficients measured across the image, including the edges; use [OpenCV calibration](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html) with held-out images and an appropriate wide-angle model.
- Body-to-camera rotation and translation, including the position sensor lever arm. This camera is fixed forward; desired gimbal angles do not describe it.
- Exactly one composition of the existing sensor/board flip, rotation, crop and preview/full scale. Project into the actual letterboxed video rectangle, not the entire widget.
- Capture-time model, clock uncertainty, measured residual and calibration revision. A profile mismatch immediately removes registered scene patches.

The existing GStreamer pipeline already has bounded queues and PTS gap probes. Extend this pipeline to expose capture/frame identity and timestamp provenance; do not create a second camera capture. GStreamer [clock and running-time semantics](https://gstreamer.freedesktop.org/documentation/additional/design/synchronisation.html) distinguish PTS from wall clock. Source PTS may still need a measured exposure offset and uncertainty.

Correlate decoded browser frames with the source frame clock through mediamtx and each encode branch. First prove whether RTP timestamps and RTCP mappings survive the existing path. The [video frame callback specification](https://wicg.github.io/video-rvfc/) exposes optional `rtpTimestamp`, `captureTime` and `receiveTime`, but availability and meaning must be verified; remote capture time is an estimate, and callbacks can be delayed or missed. `timeupdate`, browser receipt time and a fixed 100 ms pose delay are not exposure-time evidence.

Keep a bounded historical pose ring on a common monotonic timeline. Detect flight-controller reboot, pipeline restart, clock jumps, wrap, out-of-order packets and reconnect. Interpolate position and quaternion attitude around the capture instant only when both bracketing samples and clock mapping are valid. Do not extrapolate stale state to make an overlay appear aligned.

Registration error is sensitive to time: with a 600-pixel focal length, 20°/s angular motion and 100 ms error, rotation alone produces about 21 pixels of displacement. A one metre DEM does not repair this. Measure time and geometry uncertainty against the accepted image residual on physical equipment before labeling registration ready.

For a frozen video frame or still fallback, either retain geometry tied to that exact captured image with its age visible or remove registered moving patches. Never place current-pose terrain over an old image. Current flight warnings and historical camera scene annotations require separate timestamps.

## Advisory behavior and invalid states

Terrain-relative colors and predicted-path warnings are separate products. A patch below the horizon is not necessarily a collision hazard. Advisory clearance considers the observed DTM/DSM, actual velocity, predicted corridor, lookahead time and declared margins. It must state whether the value is bare-earth or mapped-surface clearance.

Expose off, loading, missing coverage, unknown datum, unverified transform, uncalibrated camera, unknown frame clock, stale telemetry, stale image and ready states. Each failed gate removes the affected scene patch or numerical warning with a specific reason. Unknown coverage never becomes a green clear indication. Source survey age and surface incompleteness remain visible even when all computational gates pass. No warning originates an aircraft command.

## Aircraft traffic integration

Port the shared provider/cache behavior into a production node rather than polling once per browser. Preserve fixed allowed origins, response limits, request timeout, radius cap, observed-source timestamps, stale/expiry intervals, bounded histories, gap breaks and 429/backoff handling. Stop provider work when unused. Explicit provider enablement discloses that a location query leaves the device.

Keep geometric and barometric altitudes separate. A target without a usable geometric datum remains on the map; it cannot acquire a fabricated vertical position on the PFD/camera. Omit ownship only when an actual matching identity is known. Labels are clipped, bounded and prioritized; trajectories show observations, not invented tracks. Network ADS-B is contextual traffic information and must not silently become an avoidance controller.

## Dependencies and licenses

| Component/data | Policy |
| --- | --- |
| Original terrain/projection/cache code | GPL-3.0-or-later with repository provenance; browser WebGL needs no additional rendering framework |
| PDAL, GDAL, PROJ | Optional pinned preparation tools, outside normal runtime; retain [PDAL notices](https://pdal.io/en/stable/copyright.html), [GDAL MIT/X-style notices](https://gdal.org/en/stable/license.html) and [PROJ notices](https://proj.org/en/stable/about.html). Audit the selected LAZ decoder and transformation grids separately. |
| OpenCV | Optional calibration tool; versions 4.5+ use [Apache 2.0](https://opencv.org/license/). Record the exact version and calibration artifacts. |
| USGS 3DEP | Public-domain federal data; retain product identifiers, attribution, survey epoch and processing provenance |
| Mapzen/Terrarium | [Attribution varies by upstream source](https://github.com/tilezen/joerd/blob/master/docs/attribution.md); a public endpoint does not make every source public domain |
| Esri World Imagery | [Item terms](https://www.arcgis.com/sharing/rest/content/items/10df2279f9684e4a9f6a7f08febac2a9?f=json) state ordinary layer tiles are not intended for offline export. Do not redistribute a prototype cache as an offline pack. |
| Offline aerial imagery | [USGS NAIP](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer) provides a public-domain candidate; select actual coverage, retain acquisition date and attribution. Aerial imagery is not necessarily satellite imagery. |
| ADS-B.lol | The [public API](https://www.adsb.lol/docs/open-data/api/) uses ODbL 1.0. Preserve attribution and applicable database/export obligations separately from application source licensing. |
| Existing media stack | Preserve pinned mediamtx and installed GStreamer licensing/notices; no replacement media server is needed |

## Acceptance evidence

1. **Ingest:** actual binary CRS/unit checks, hashes, expected source dates, route-plus-buffer coverage, class histogram, independent horizontal/vertical control points and known missing-cell behavior. Verify US survey feet conversion and fail closed when a required datum grid is absent.
2. **Terrain:** known ridge/tree/roof fixtures; sampling and nodata boundaries; conservative maximum pyramid; exact one metre source spacing; identical edge positions across LOD; bounded reads/memory and malformed-pack rejection.
3. **Geometry/time:** held-out optical calibration, every supported flip/rotation/crop and preview/full transform, camera mount/lever arm, quaternion interpolation, reboot/wrap/out-of-order handling, missing time correspondence and measured motion residual. Separate synthetic tests from physical evidence.
4. **Video:** preserve WHEP authentication, preview/full, still age, reconnect and recording. Test frozen frames, dropped callbacks, stale telemetry and pipeline restarts without current-pose patches over old images.
5. **Traffic:** provider timeout/429, malformed payload, impossible timestamps, expiry, observation gaps, datum separation, radius and count bounds, ownship identity and attribution.
6. **Node/browser:** custom-node tests, frontend import boundary, offline executable assets, authorization on pack routes, no automatic actuation, both palettes, touch geometry, inset/fullscreen/swap, context loss and explicit unavailable reasons.
7. **Hardware:** exact ELP formats and transformations, calibrated static landmarks plus controlled motion, real frame-clock residual, Pi/tablet rendering and thermal/resource budgets. No automated flight commands are part of terrain acceptance.

At baseline audit completion, the source headers, neighboring LiDAR coverage, actual class distribution, vertical transform control points, camera calibration and end-to-end frame correlation remain unverified. Implementation can proceed with explicit unavailable gates; those gates must not be relabeled as verified alignment until their evidence exists.

## Implementation evidence added after the baseline audit

The bounded terrain implementation now lives in `packages/yonder-core/src/terrain`, with optional preparation tools in `scripts/terrain` and an attributable bundled pack in `src/terrain/assets/cove`. These implement R-FLT-08/09. Both the northern and southern LiDAR tiles were acquired and their binary headers and actual classes inspected. The full selected grid has 100% DTM and 97.69% observed surface coverage. Ground comparison uses 2,471,930 samples, median +0.0319 m and absolute 95th percentile 0.1943 m. There are building and unclassified returns but no vegetation classes.

The bundled heights are now EGM96: the actual CONUS GEOID12B and NGA EGM96 grids were downloaded, hash-checked and applied using an explicit PROJ pipeline. Five route control points agree with independent raster interpolation within 0.00001 m and inverse round trips within 0.00000001 m. This verifies the mathematical grid conversion, not physical camera/GNSS registration. Grid names, URLs, hashes, numerical evidence, sampling resolution and remaining limitations accompany the data. Physical camera calibration and end-to-end frame correspondence remain external acceptance work.

Native rendering exposed isolated raw class-1 surface returns near 975–1027 m NAVD88 over DTM near 305 m. Inspection found one high return at each checked site among 74–89 returns in the surrounding three metre square, with the others near 303–323 m. Preparation now marks a native cell unknown only when its raw maximum is more than 80 m above DTM and more than 30 m above every observed neighbor within a 2 m Euclidean radius. At least one neighbor is required; the original grid is screened once. This heuristic masks 28 cells, 476.7–722.2 m above DTM, and records each original height, location, neighboring maximum, criteria and count in `preparation-report.json`. It never fills suspect cells as ground or claims a real isolated obstacle is absent. Screened surface coverage is 97.691739%, compared with 97.692755% raw coverage; DTM remains 100%. Historical survey age, absent vegetation classification and incomplete obstacle coverage still apply.

The pure `evaluateTerrainPath` helper now samples measured constant ground track/speed and vertical speed against DTM/DSM over a bounded future corridor. It reports first warning/caution time, minimum clearances, average closure, evaluated horizon and partial coverage; requested sample coverage is distinct from continuous obstacle completeness. Its maximum work is 4,096 samples, and it never sends a command. Strict runtime calibration import validation rejects truthy strings, incomplete coefficients and malformed arrays. The service reports the actual selected native grid spacing rather than the source-resolution label. Regression coverage includes these boundaries and the observed surface anomalies.
