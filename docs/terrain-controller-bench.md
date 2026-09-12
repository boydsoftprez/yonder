# Terrain controller bench evidence

Date: 2026-09-11. Scope: a bounded, disarmed RAM/cache experiment supporting the onboard terrain design and planned R-FLT-27/28. This is not flight clearance or a completed service acceptance test.

## Setup and method

HEEWING-F405v2 running custom ArduPlane 4.7.1 (`dbe792162d06cab66c3475fd5556bf7a120f119e`) with terrain support. The Radxa's existing 115200-baud UART/mavlink-router route carried the experiment through a temporary loopback bridge and SSH tunnel. No service was stopped, serial ownership changed, GPS position injected, parameter written, firmware flashed, or arm command sent.

Observed configuration: Q_ENABLE=1, SCHED_LOOP_RATE=300, TERRAIN_ENABLE=1, TERRAIN_OPTIONS=2 (diskless), TERRAIN_SPACING=30, TERRAIN_CACHE_SZ=12, TERRAIN_FOLLOW=0, GPS1_TYPE=1. No GPS was connected and navigation was not initialized. The cache had already been allocated before this run; the experiment measures behavior during filling and replacement, not its initial allocation cost.

Source: official `https://terrain.ardupilot.org/SRTM1/N35W084.hgt.zip`, SHA-256 `8f25d774b59272e69fd52e6fb3b782c73eee581431f48574d8bbf1c83900d628`. The single 3601×3601 signed big-endian HGT contained no nodata samples. Coordinate helpers were taken from terraingen commit `bd0639f9b80d4b4cfb45c3cdc4eee964d40a463b`; bilinear source sampling preserved the raw nodata check.

The harness checked 24 locations spaced 0.009 degrees northward from 35.70°N, all at 83.36°W, then revisited the first four. Each check created a cache entry; the harness then explicitly sent its 56 subgrids at no more than 10 frames/second. It waited for a matching terrain-height report and completed transmission before proceeding. This direct seeding is experimental only: the production responder must still answer controller requests. Stop conditions included arming, heartbeat loss, boot-time regression and observed free memory below 8000 bytes.

## Observed result

The bounded cache experiment passed in 231.5 seconds:

| Observation | Result |
| --- | --- |
| Queried locations | 24 distinct blocks, then four successful revisits |
| Data sent | 1568 TERRAIN_DATA frames; all 56 subgrids transmitted on each visit |
| Free RAM | 14,856–20,000 bytes; final observation 15,440 bytes |
| Reported CPU load | 17.9–20.5% |
| Largest observed heartbeat interval | 1.147 seconds |
| Observed boot-time regressions | None |
| Autonomous TERRAIN_REQUEST messages | Zero |
| Height comparison | All 28 point heights within 0.0021 m of interpolation from the supplied grid |

All four revisits initially reported no available height (spacing zero), then returned the same height as their first visit after resupply. Together with the configured cache limit and source inspection, this supports cache eviction and reuse. There was no observed accumulating memory loss. The height comparison checks transport, indexing and interpolation consistency; it is not an independent survey of terrain accuracy or a complete production-codec validation.

The temporary bridge and tunnel closed after the run. No configuration restore was needed because the harness issued no parameter writes. Only authentic terrain data remained in volatile FC cache. The bounded test supports proceeding with service engineering; operational RAM sufficiency remains unproven.

## Firmware behavior that limits the test

Without an aircraft position, TERRAIN_CHECK did not produce TERRAIN_REQUEST in this build. The pinned implementation creates a GRID_CACHE_DISKWAIT entry, diskless IO does not advance that state, and the no-position request scan selects only states at or above GRID_CACHE_VALID. Direct TERRAIN_DATA can populate a matching entry's bitmap without changing its diskless state; height queries can consequently succeed while statistics continue to count that entry as pending.

Therefore `loaded=0` and `pending=672` do not mean no usable terrain in this experiment. These are 12 entries × 56 subgrids, reported according to the stale DISKWAIT state. Preserve those controller counters as observations, alongside their limitation. Do not translate them alone into coverage readiness or quietly reinterpret them as a successful load count.

## Remaining acceptance gates

- The subsequent [simulated-GPS UART experiment](terrain-controller-gps-simulation.md) observed genuine requests and replies across moving block boundaries. Real-sensor operation, prefetch behavior and request-driven return to evicted locations remain acceptance work.
- Measure memory with GPS/EKF and the intended operational peripherals and telemetry active. A disarmed no-GPS result cannot establish navigation or VTOL transition headroom.
- Verify whole-block completeness separately; transmitting all 56 subgrids and obtaining a point height is not an acknowledgement of every cell.
- Exercise the production service on persistent Radxa storage, browser closed and external network unavailable, including source nodata and storage-reserve refusal.
- Resolve the known state-volume capacity constraint before live area preparation. Preserve all earlier aircraft flight-readiness blockers.

## Source references

- [Request selection, terrain-data handling and statistics](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/libraries/AP_Terrain/TerrainGCS.cpp)
- [Cache replacement and grid geometry](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/libraries/AP_Terrain/TerrainUtil.cpp)
- [Allocation and height interpolation](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/libraries/AP_Terrain/AP_Terrain.cpp)
- [Diskless IO behavior](https://github.com/ArduPilot/ardupilot/blob/dbe792162d06cab66c3475fd5556bf7a120f119e/libraries/AP_Terrain/TerrainIO.cpp)
