# Official HGT reference fixtures

These bounded fixtures establish source sampling facts for the official
ArduPilot SRTM1 terrain path. They are reference inputs for later codec tests;
they are not a complete degree tile and do not establish flight readiness.

`N35W084-bit0-source-window.hgt` and
`N35W084-bit55-source-window.hgt` retain byte-for-byte signed big-endian samples
from the pinned `N35W084.hgt` tile. `expected.json` records each window's
original north-to-south row and west-to-east column bounds, stride, checksum,
tile identity, request origin, 30 metre grid mapping, and expected 4×4 values.
Bit 55 is the block's north/east overlap boundary and is also bit 0 of the
neighboring block.

The files with `synthetic` in their names are deliberately mutated test data,
not terrain measurements. The bit-0 mutation contains raw HGT nodata `-32768`
and requires withholding the complete subgrid. The interpolation cases keep
nodata distinct from valid `-12`, valid `-1`, and valid zero elevations. The
expected result shows the erroneous value that replacing nodata with `-1`
would produce; it is never an accepted height.

The generator uses Python's standard library, performs no downloads, and does
not read pickle data. It requires explicit paths and rejects an archive whose
name, ZIP membership, byte lengths, dimensions, tile identity, archive hash,
or decompressed-member hash differs from the pinned source:

```sh
python3 scripts/terrain/official-fixtures.py \
  --input-archive "$HGT_ARCHIVE" \
  --output-dir "$EMPTY_OUTPUT_DIR"
```

Generation is deterministic. Run the command into two empty directories and
compare every file checksum. The generator records its own checksum and the
pinned upstream commits in `expected.json`.

Coordinate and bitmap behavior is grounded in ArduPilot Plane commit
`dbe792162d06cab66c3475fd5556bf7a120f119e`, particularly
`libraries/AP_Terrain/TerrainUtil.cpp` and `TerrainGCS.cpp`. HGT interpolation
and generated-grid rounding follow terraingen commit
`bd0639f9b80d4b4cfb45c3cdc4eee964d40a463b`, particularly `terrain_gen.py` and
`srtm.py`. Source provenance and dataset attribution are recorded in
`docs/terrain-official-source.md`.
