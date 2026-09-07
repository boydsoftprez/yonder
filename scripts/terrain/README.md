# Terrain preparation

R-FLT-08/09. These optional workstation tools build the self-contained terrain pack used by the cockpit. They are not installed on the aircraft and introduce no npm runtime dependency.

The bundled cove pack uses the USGS one metre `x28y399` DEM plus `2738597NE` and `2738597SE` LiDAR, surveyed 2016-02-05 through 2016-04-04. `cove-sources.json` pins actual downloaded sizes and SHA-256 hashes. The catalogue's DEM size differs slightly from the currently served file; the file's inspected raster header and actual hash are recorded. All three inputs remain in the ignored task cache, not in source control.

## Reproduce

Use Python 3.9 or newer with wheels supported by the workstation. From the repository root:

```sh
python3 -m venv vendor/terrain-cache/venv
vendor/terrain-cache/venv/bin/pip install -r scripts/terrain/requirements.txt
vendor/terrain-cache/venv/bin/python scripts/terrain/download.py --cache vendor/terrain-cache --grids
YONDER_TERRAIN_TEST_GRIDS=vendor/terrain-cache/grids vendor/terrain-cache/venv/bin/python -m unittest discover -s scripts/terrain -p 'test_*.py'
vendor/terrain-cache/venv/bin/python scripts/terrain/prepare.py --cache vendor/terrain-cache/sources --grids vendor/terrain-cache/grids --output vendor/terrain-cache/prepared-cove
```

The output directory must be empty. Preparation does not silently overwrite an existing pack. Compare the generated manifest and report before replacing a bundled package. Sources total about 494 MB; the two required datum grids total about 20 MB. Downloads are explicit, HTTPS-only, bounded and checksum-checked. The preparation command uses local files only and disables PROJ network grid fetching.

Without `--grids`, preparation retains native NAVD88 and marks the vertical transform unverified. That output supports terrain display but cannot establish comparison with EGM96 telemetry. With `--grids`, the tool checks exact NOAA CONUS GEOID12B and NGA EGM96 files, applies an explicit PROJ pipeline, and checks five route control points against independent Rasterio interpolation and inverse round trips. Source and output references remain in the manifest. Do not substitute the similarly named Alaska grid `g2012ba0` for the required CONUS `g2012bu0`.

## Data processing

The source DEM is EPSG:26917, one metre, with NAVD88 metre heights established by USGS metadata. LiDAR binary headers are EPSG:6576 horizontal plus EPSG:6360 vertical: NAD83(2011) Tennessee State Plane and NAVD88/GEOID12B, both in US survey feet. The tool verifies these headers and converts heights using exactly 1200/3937 metres per survey foot.

Both inputs are resampled to a one metre WGS84 UTM zone 17N grid. Horizontal reference transformations have metre-scale uncertainty; one metre spacing is not a one metre absolute-position guarantee. A class-2 LiDAR-to-DTM comparison must pass before delivery. The current pack has 2,471,930 comparison samples, median +0.0319 m and absolute 95th percentile 0.1943 m before vertical conversion.

The surface starts with the maximum observed, non-withheld, non-noise return per cell. It includes classified buildings and unclassified elevated returns. The actual files lack vegetation classes, so this is **mapped surface**, not an asserted classification of every tree. Valid surface heights cannot fall below the observed DTM. Holes remain holes. No neighborhood fill disguises absent observations.

Actual source inspection found isolated class-1 returns near 975–1027 m NAVD88 among neighboring returns near 303–323 m. A declared quality heuristic marks a cell unknown when it is **more than 80 m above DTM and more than 30 m above every observed neighboring sample within a 2 m Euclidean radius**. At least one observed neighbor is required. The rule is applied once to the original maximum grid; it is not iterated or applied as a rendering clip. It masks 28 cells, each 476.7–722.2 m above DTM in this pack. A real isolated structure could also meet this heuristic: its cell becomes unknown, never ground or an inferred lower obstacle. `preparation-report.json` retains every raw maximum, position, ground and neighbor height, exact criteria and counts. Values in that quality record remain native NAVD88 even when the final pack is EGM96. Raw surface coverage is 97.692755%; screened coverage is 97.691739%; DTM coverage remains 100%. Coarse levels and advisory sampling preserve the resulting missing support.

The default footprint is 1537 × 1793 one metre cells with north-west corner UTM (286080, 3982960). It includes the full cove route and a bounded margin, not every possible loiter or diversion. Detail levels use 1/2/4/8/16 metre spacing. Coarse levels use the maximum only where every contributing cell is observed. They are visual summaries; native clearance sampling always uses level 0. Adjacent tiles share their border samples. Each independently compressed tile contains at most 129 × 129 samples.

## Wire and runtime contract

`TerrainPackService.open(directory)` validates `manifest.json`. The service refuses unlisted paths, symlinks, corrupt files, decompression beyond the descriptor length, excessive queues and cache growth. `getTile(id)` returns decoded bytes; `sampleAt(eastingM, northingM)` returns native ground/surface samples with the explicit datum and transform state. `latLonToUtm` provides the matching frontend-safe coordinate conversion.

The authenticated cockpit routes are:

- `/cockpit/api/terrain/manifest`: JSON `TerrainManifest`.
- `/cockpit/api/terrain/tile/:id`: raw binary, all DTM float32 little-endian values followed by all surface float32 little-endian values. `NaN` means unknown. The descriptor carries shape, grid, file checksum and lengths.

The disk format is the same binary compressed with deterministic gzip. `decodeTerrainTile` accepts the uncompressed transport bytes. `buildTerrainMesh` returns native grid positions and indices in rebased east/up/south metres. `sampleTerrain` never clamps a point outside coverage to an edge elevation. `selectTerrainTiles` selects one bounded detail level; renderers may request an explicit level to maintain one metre nearby detail.

The bundled pack resides in `packages/yonder-core/src/terrain/assets/cove`; the existing asset copier includes it in the built package. The current binary tile payload is 20,973,049 bytes across 227 tiles, plus manifests and notices. Tests open and checksum every bundled tile and verify the cache bound, real route sampling and the observed suspect-cell regression.

## Calibration and advisory limits

`registrationValidity` requires a matching validated camera profile, optical geometry, frame capture mapping, uncertainty bound, bracketed historical pose, fresh frame/telemetry and a verified common height reference. `projectCameraPoint` performs Brown-Conrady optical projection and exactly one mirror/rotation into a letterboxed viewport. It is mathematical support, not evidence that this camera is calibrated. Other lens models must be explicitly implemented and verified rather than relabeled Brown-Conrady.

`validateCameraCalibration(unknown)` validates imported JSON at runtime: booleans must be booleans, matrices/offsets must have their exact lengths, every distortion coefficient must exist and be finite, and the camera rotation must be orthonormal and right handed. Truthy strings such as `"false"` do not establish validation or timing evidence.

`clearanceAdvisory` applies declared clearance thresholds only to fresh, covered, compatible height inputs. Unknown never becomes clear. It does not predict a flight path by itself and has no actuation capability. Source age, missing surface cells, current GNSS quality, fixed-camera calibration and capture timing remain separate validity concerns.

`evaluateTerrainPath` adds a separate sampled constant-motion advisory using measured ground track, ground speed and vertical speed with compatible DTM/DSM heights. Defaults are 30 seconds ahead, at most 10 m along-track spacing, a 20 m half-width corridor sampled every 10 m laterally, and a 2,048-query budget (hard maximum 4,096). It reports minimum ground/surface clearance, first caution/warning sample time, average closure to the lowest predicted clearance, evaluated horizon and explicit missing coverage. The budget truncates the evaluated horizon instead of silently widening spacing. Known hazards remain caution/warning with partial coverage; unknown never produces all-clear. “Complete” means all requested sample locations were covered, not continuous obstacle completeness between samples. This is neither the autopilot's intended path nor a maneuver prediction, and issues no command.

## Preparation dependencies and notices

These are optional pinned development dependencies. They are not vendored into the runtime or installed on the aircraft. Preserve each distribution's own bundled notices when redistributing a preparation environment.

| Dependency | Version | Distribution license |
| --- | --- | --- |
| NumPy | 2.0.2 | BSD-3-Clause; wheels include additional third-party notices |
| Rasterio | 1.4.3 | BSD; bundled GDAL components retain their own MIT/X-style notices |
| pyproj | 3.6.1 | MIT; bundled PROJ retains its notices |
| laspy | 2.6.1 | BSD |
| lazrs Python binding | 0.7.0 | MIT; retain Rust dependency notices in its distribution |

USGS 3DEP, NOAA GEOID12B and NGA EGM96 inputs used here are public-domain federal data. Each grid's embedded TIFF copyright states public domain; see [NOAA PROJ grid provenance](https://github.com/OSGeo/PROJ-data/blob/master/us_noaa/us_noaa_README.txt) and [NGA grid provenance](https://github.com/OSGeo/PROJ-data/blob/master/us_nga/us_nga_README.txt). Derived pack metadata retains attribution and source URLs. No Esri imagery is copied into this package. Source code is GPL-3.0-or-later.
