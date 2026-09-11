# Official terrain source investigation

Date: 2026-09-11. This records the first implementation-plan discovery task; it does not establish flight readiness. The operator subsequently approved the HGT adjustment described below.

## Source and format

The official ArduPilot service identifies SRTM1 as JAXA ALOS-derived, nominal one-arcsecond data, with TERRAIN_SPACING=30. Source inspected: ArduPilot/terraingen commit `bd0639f9b80d4b4cfb45c3cdc4eee964d40a463b`, and ArduPilot Plane-4.7.1 commit `dbe792162d06cab66c3475fd5556bf7a120f119e`.

The web generator returns an area ZIP. Current source also uses whole-degree gzip DAT objects under `https://terrain.ardupilot.org/tilesdat1/`. That endpoint is an observed implementation contract, not a published versioned API. Sources are mutable; store source timestamps, content hashes, format and generation metadata rather than treating the URL as an immutable release.

## Missing-height ambiguity — approved HGT adjustment

The pinned generator's `fast_gen.py` lines 87–88 replace raw HGT nodata `-32768` with `-1` before interpolation. `srtm.py` lines 408–409 do the same in the alternate path. Negative one metre can also be a valid elevation. The prebuilt DAT does not retain the original sample validity mask, so a CRC-valid DAT cannot distinguish these cases. Interpolation can mix the replacement value with neighboring heights; rejecting only DAT values equal to -1 would not repair the problem.

This conflicts with the approved design's requirement to reject missing data rather than invent terrain. The source investigation therefore does not approve a DAT-only serving implementation.

Approved adjustment: retain the same official SRTM1/ALOS source, but acquire its HGT source tiles, preserve their explicit missing-data sentinel, and generate requested 30 m subgrids using reference-tested ArduPilot coordinate/interpolation behavior. If any contributing sample is missing, withhold the affected subgrid and report incomplete coverage. This changes storage/processing format, not the terrain dataset. Do not retain a second durable DAT dataset; bounded derived RAM blocks are sufficient. It adds a reference-tested sampling path, but preserves the agreed missing-data semantics.

An alternative is DAT plus a separately proven source-validity mask, built from corresponding HGT input. That adds download/generation matching and dual-artifact validation; mutable upstream files make correspondence itself an acceptance problem. Treating DAT heights as canonical without source validity would weaken the approved contract and is not the recommended approach.

## HGT storage and sampling contract

The implementation plan uses a single validated raw HGT payload as the durable object. The official ZIP is download staging and integrity evidence, not a second retained terrain dataset. Each supported 3601×3601 tile is exactly 25,934,402 bytes (24.73 MiB), signed big-endian int16 with rows ordered north to south and columns west to east. The explicit missing value is -32768. Zero and -1 remain valid elevations. Tile identity and source generation live in a versioned manifest because raw HGT has no internal identity/version header.

The inspected N35W084 archive is 10,817,094 bytes, giving roughly 35.1 MiB of simultaneous ZIP-plus-raw staging for that example before metadata and filesystem overhead. Other tiles compress differently; admission uses independent bounded compressed/staging costs and exact raw size, not this example as a universal estimate. Validate the archive member identity, CRC, dimensions and decoded length before atomic publication. Read raw row/windows from disk and bound the combined window/derived-grid cache to 16 MiB; never allocate an entire tile as an assumed cache entry.

Interpolation with any contributing nodata stays unavailable. Valid tiles may contain missing regions; keep the validity information and report coverage gaps rather than rejecting every valid sample in that tile. Generate requested 30 m samples against pinned coordinate behavior, including neighboring tiles at overlaps and degree boundaries. Do not assign a new numeric datum correction without source evidence.

## Hardware storage evidence

Read-only SSH inspection of the image mule found `/var/lib/yonder` on the persistent ext4 state partition, bind-mounted from its app directory. The state partition is 512 MiB, with approximately 450 MiB available. `/var/lib/yonder/captures` is a separate 1.2 GiB ext4 media partition. Root is read-only. These observations establish mount layout, not a reboot persistence test.

The default 1 GiB storage reserve exceeds available state-volume space. Terrain preparation must refuse on that volume under that policy. The card's unallocated capacity is not permission to resize partitions or reduce recovery headroom. Software tests can use bounded temporary fixtures; live preparation awaits an explicitly suitable persistent-storage layout.

## References

- [Official terrain service](https://terrain.ardupilot.org/)
- [Pinned fast generator](https://github.com/ArduPilot/terraingen/blob/bd0639f9b80d4b4cfb45c3cdc4eee964d40a463b/fast_gen.py#L68-L89)
- [Pinned source tile reader](https://github.com/ArduPilot/terraingen/blob/bd0639f9b80d4b4cfb45c3cdc4eee964d40a463b/srtm.py#L399-L410)
- [Approved design](superpowers/specs/2026-09-11-onboard-terrain-service-design.md)
- [Implementation plan](superpowers/plans/2026-09-11-onboard-terrain-service.md)
