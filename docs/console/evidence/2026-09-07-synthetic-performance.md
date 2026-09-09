# Synthetic vision cadence, streaming and surface continuity

R-FLT-08, R-FLT-09, R-FLT-11. Measurements are in
[the evidence record](2026-09-07-synthetic-performance.json).

The terrain renderer imposed a 50 ms drawing interval, producing about 18 frames
per second with frame-boundary rounding. Its 100 ms pose buffer did not span the
browser's default 250 ms flight polling interval, and freshness-only Vue updates
inserted duplicate observations. Terrain movement cells also rebuilt unchanged
Terrarium regions and discarded textures. The aircraft attitude source itself
measured 9.99 Hz over a passive five-second read.

The display now paces terrain and instruments independently up to 60 Hz, adapts
its interpolation buffer to received observations, rejects clock-only samples,
and never extrapolates aircraft pose. Invalid data and vehicle/datum changes
reset presentation. Unchanged meshes retain GPU buffers; prepared native meshes
use a stable coordinate origin and bounded cache. The georeferenced imagery atlas
survives geometry changes and is cleared when its source changes or opts out.
Coverage probes no longer cancel outstanding imagery for the installed region.

Nearby prepared geometry uses up to 24 native tiles within a 300 m search radius.
After visible data loads, at most two workers warm up to 16 more native tiles along
received ground track, up to 30 seconds / 1.5 km ahead. A selected ground relay
serves a validated manifest and only the requested checksum-verified files, with
bounded session caches and cancellation. Offline preload remains a separate
explicit action. No ground request is silently redirected through the aircraft.

Yellow shading uses a five-metre visual ramp before the caution threshold and a
200 ms arrival fade for newly loaded surfaces. Red shading bypasses that arrival
fade. The measured-clearance advisory calculations and thresholds are unchanged.
AGL appears beneath the MSL tape when compatible terrain is available and shows
an explicit unavailable dash otherwise.

## Browser observations

Hardware-accelerated Chromium, Apple M5 Max, 1440 × 900, 15-second windows:

| Scene | Terrain draws/s | 95th-percentile draw interval | Longest draw interval |
| --- | ---: | ---: | ---: |
| Original Terrarium renderer | 18.3 | 64.9 ms | 113.9 ms |
| Updated Terrarium renderer | 60.0 | 25.1 ms | 31.9 ms |
| Updated detailed terrain, cold browser streaming | 59.7 | 25.1 ms | 47.4 ms |

The steady detailed-terrain run made 56 flight reads (3.7/s), fetched 78 unique
terrain files from a 298-tile manifest, and ended with `EST AGL 275 FT`. It
reported no long tasks, page exceptions, or attempted aircraft writes. Geometry
uploads continue when the actual selected region changes; the fallback comparison
had zero uploads after warm-up rather than 180 in the original window.

The user's selected loiter was east of the original prepared footprint. A separate
2305 × 1793 local pack was prepared from the existing verified surveys and grids,
then loaded into the preview browser. Its 298 compressed tiles total 26,849,006
bytes. It has 84.41% ground and 82.03% surface coverage across the larger rectangle;
unknown areas remain unknown. A native sample at the active loiter returned
310.54 m ground in verified EGM96. This local demonstration expansion does not
change the bundled pack or provide global survey coverage.

## Verification

Regression tests first reproduced the 20-draw cap, duplicate observations,
rebuilding the same fallback region, interrupted imagery loads, and atlas retention
across source opt-out. Tests cover cadence at 1/2/4/8 Hz, packet loss, angle wrap,
source resets, native mesh reuse, bounded look-ahead, and ground-stream integrity,
cancellation, source isolation, cache bounds and imported-tile reuse.

Final dashboard validation: **691 tests across 54 files passed**. The production
widget build passed. Browser fixture checks passed for laptop, tablet, portrait
and phone layouts, day/night rendering, map/mission access and breadcrumb controls,
with no vehicle requests. The earlier independent review found the interrupted
imagery lifetime issue; the deferred-response regression now passes with imagery
and coverage-probe cancellation separated.
