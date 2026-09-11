#!/usr/bin/env python3
"""Generate bounded official-terrain fixtures from the pinned HGT archive.

The generated real windows retain the source tile's signed big-endian samples
and original row/column identity.  No network access or pickle input is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import sys
import zipfile


ARCHIVE_NAME = "N35W084.hgt.zip"
ARCHIVE_SHA256 = "8f25d774b59272e69fd52e6fb3b782c73eee581431f48574d8bbf1c83900d628"
MEMBER_NAME = "N35W084.hgt"
MEMBER_SHA256 = "526db36d5d3d01027732ff93a3b9d09a22636d429a7b7311bea0d3fc036f4a2c"
TILE_LATITUDE_DEGREES = 35
TILE_LONGITUDE_DEGREES = -84
TILE_DIMENSION = 3601
TILE_BYTE_LENGTH = TILE_DIMENSION * TILE_DIMENSION * 2

TERRAINGEN_COMMIT = "bd0639f9b80d4b4cfb45c3cdc4eee964d40a463b"
ARDUPILOT_COMMIT = "dbe792162d06cab66c3475fd5556bf7a120f119e"

REQUEST_LAT_E7 = 356_985_340
REQUEST_LON_E7 = -833_616_470
GRID_SPACING_M = 30
GRID_BLOCK_SPACING_NORTH = 24
GRID_BLOCK_SPACING_EAST = 28
GRID_BLOCK_SIZE_NORTH = 28
GRID_BLOCK_SIZE_EAST = 32
SUBGRID_SIZE = 4
SUBGRIDS_EAST = 8
REQUEST_GRID_INDEX_NORTH = 108
REQUEST_GRID_INDEX_EAST = 69
CORNER_TOLERANCE_CM = 2
NODATA = -32768


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def float32(value: float) -> float:
    return struct.unpack("<f", struct.pack("<f", value))[0]


LOCATION_SCALING_FACTOR = float32(0.011131884502145034)
LOCATION_SCALING_FACTOR_INV = float32(89.83204953368922)


def longitude_scale(latitude_degrees: float) -> float:
    radians = float32(math.radians(latitude_degrees))
    return max(float32(math.cos(radians)), 0.01)


def add_offset(
    latitude_e7: int,
    longitude_e7: int,
    north_m: float,
    east_m: float,
) -> tuple[int, int]:
    """Port pinned terraingen terrain_gen.py add_offset(format="4.1")."""
    latitude_delta = int(float(north_m) * LOCATION_SCALING_FACTOR_INV)
    midpoint_degrees = (latitude_e7 + latitude_delta * 0.5) * 1.0e-7
    longitude_delta = int(
        float(east_m)
        * LOCATION_SCALING_FACTOR_INV
        / longitude_scale(midpoint_degrees)
    )
    return latitude_e7 + latitude_delta, longitude_e7 + longitude_delta


def parse_tile_identity(name: str) -> tuple[int, int]:
    match = re.fullmatch(r"([NS])(\d{2})([EW])(\d{3})\.hgt", name)
    if match is None:
        raise ValueError(f"unexpected HGT member name: {name}")
    latitude = int(match.group(2)) * (-1 if match.group(1) == "S" else 1)
    longitude = int(match.group(4)) * (-1 if match.group(3) == "W" else 1)
    return latitude, longitude


def read_source_archive(path: Path) -> bytes:
    archive = path.read_bytes()
    digest = sha256(archive)
    if digest != ARCHIVE_SHA256:
        raise ValueError(
            f"archive SHA-256 mismatch: expected {ARCHIVE_SHA256}, got {digest}"
        )

    with zipfile.ZipFile(path, "r") as source_zip:
        members = source_zip.infolist()
        if len(members) != 1 or members[0].filename != MEMBER_NAME:
            names = [member.filename for member in members]
            raise ValueError(f"expected only {MEMBER_NAME}, got {names}")
        member = members[0]
        if member.flag_bits & 0x1:
            raise ValueError("encrypted HGT archives are not accepted")
        if member.file_size != TILE_BYTE_LENGTH:
            raise ValueError(
                f"HGT byte length mismatch: expected {TILE_BYTE_LENGTH}, "
                f"got {member.file_size}"
            )
        raw = source_zip.read(member)

    if len(raw) != TILE_BYTE_LENGTH:
        raise ValueError("decompressed HGT length changed after ZIP validation")
    member_digest = sha256(raw)
    if member_digest != MEMBER_SHA256:
        raise ValueError(
            f"HGT SHA-256 mismatch: expected {MEMBER_SHA256}, got {member_digest}"
        )
    dimension = math.isqrt(len(raw) // 2)
    if dimension != TILE_DIMENSION or dimension * dimension * 2 != len(raw):
        raise ValueError(f"unexpected HGT dimensions: {dimension}x{dimension}")
    if parse_tile_identity(MEMBER_NAME) != (
        TILE_LATITUDE_DEGREES,
        TILE_LONGITUDE_DEGREES,
    ):
        raise ValueError("HGT member identity does not match the pinned degree tile")
    return raw


def raw_height(raw: bytes, row: int, column: int) -> int:
    if not 0 <= row < TILE_DIMENSION or not 0 <= column < TILE_DIMENSION:
        raise ValueError(f"HGT sample outside tile: row={row}, column={column}")
    return struct.unpack_from(">h", raw, 2 * (row * TILE_DIMENSION + column))[0]


def interpolation(raw: bytes, latitude_e7: int, longitude_e7: int) -> dict[str, object]:
    latitude = latitude_e7 * 1.0e-7
    longitude = longitude_e7 * 1.0e-7
    x = (longitude - TILE_LONGITUDE_DEGREES) * (TILE_DIMENSION - 1)
    y = (latitude - TILE_LATITUDE_DEGREES) * (TILE_DIMENSION - 1)
    x_integer = int(x)
    y_integer = int(y)
    x_fraction = x - x_integer
    y_fraction = y - y_integer

    contributors: list[dict[str, object]] = []
    values: list[int] = []
    for x_delta, y_delta, label in (
        (0, 0, "southWest"),
        (1, 0, "southEast"),
        (0, 1, "northWest"),
        (1, 1, "northEast"),
    ):
        source_x = x_integer + x_delta
        source_y = y_integer + y_delta
        original_row = TILE_DIMENSION - source_y - 1
        value = raw_height(raw, original_row, source_x)
        values.append(value)
        contributors.append(
            {
                "corner": label,
                "originalRow": original_row,
                "originalColumn": source_x,
                "heightM": value,
            }
        )

    available = all(value != NODATA for value in values)
    result: float | None = None
    if available:
        south = values[1] * x_fraction + values[0] * (1.0 - x_fraction)
        north = values[3] * x_fraction + values[2] * (1.0 - x_fraction)
        result = north * y_fraction + south * (1.0 - y_fraction)

    return {
        "locationE7": {"lat": latitude_e7, "lon": longitude_e7},
        "pixel": {
            "x": x,
            "yFromSouth": y,
            "xInteger": x_integer,
            "yIntegerFromSouth": y_integer,
            "xFraction": x_fraction,
            "yFraction": y_fraction,
        },
        "contributors": contributors,
        "available": available,
        "interpolatedHeightM": result,
    }


def subgrid_point_location(bit: int, north: int, east: int) -> tuple[int, int]:
    subgrid_north = (bit // SUBGRIDS_EAST) * SUBGRID_SIZE
    subgrid_east = (bit % SUBGRIDS_EAST) * SUBGRID_SIZE
    global_north = (
        REQUEST_GRID_INDEX_NORTH * GRID_BLOCK_SPACING_NORTH
        + subgrid_north
        + north
    )
    global_east = (
        REQUEST_GRID_INDEX_EAST * GRID_BLOCK_SPACING_EAST
        + subgrid_east
        + east
    )
    return add_offset(
        TILE_LATITUDE_DEGREES * 10_000_000,
        TILE_LONGITUDE_DEGREES * 10_000_000,
        global_north * GRID_SPACING_M,
        global_east * GRID_SPACING_M,
    )


def build_subgrid(raw: bytes, bit: int) -> dict[str, object]:
    points: list[dict[str, object]] = []
    available = True
    for north in range(SUBGRID_SIZE):
        for east in range(SUBGRID_SIZE):
            location = subgrid_point_location(bit, north, east)
            sample = interpolation(raw, *location)
            available = available and bool(sample["available"])
            height = sample["interpolatedHeightM"]
            points.append(
                {
                    "northIndex": north,
                    "eastIndex": east,
                    "locationE7": sample["locationE7"],
                    "heightM": int(height) if height is not None else None,
                }
            )
    return {
        "bit": bit,
        "available": available,
        "dataOrder": "north-major: data[northIndex * 4 + eastIndex]",
        "heightsM": [point["heightM"] for point in points] if available else None,
        "points": points,
    }


def window_bounds(raw: bytes, bit: int) -> tuple[int, int, int, int]:
    rows: list[int] = []
    columns: list[int] = []
    for north in range(SUBGRID_SIZE):
        for east in range(SUBGRID_SIZE):
            sample = interpolation(raw, *subgrid_point_location(bit, north, east))
            for contributor in sample["contributors"]:  # type: ignore[union-attr]
                rows.append(int(contributor["originalRow"]))
                columns.append(int(contributor["originalColumn"]))
    return min(rows), max(rows), min(columns), max(columns)


def extract_window(
    raw: bytes,
    row_start: int,
    row_end: int,
    column_start: int,
    column_end: int,
) -> bytes:
    output = bytearray()
    width = column_end - column_start + 1
    for row in range(row_start, row_end + 1):
        offset = 2 * (row * TILE_DIMENSION + column_start)
        output.extend(raw[offset : offset + width * 2])
    return bytes(output)


def write_bytes(output_dir: Path, filename: str, data: bytes) -> dict[str, object]:
    (output_dir / filename).write_bytes(data)
    return {"file": filename, "byteLength": len(data), "sha256": sha256(data)}


def synthetic_cases() -> tuple[bytes, list[dict[str, object]]]:
    cases = [
        ("nodata-withheld", [[NODATA, 100], [100, 100]], None),
        ("valid-minus-one", [[-1, -1], [-1, -1]], -1.0),
        ("valid-negative", [[-12, -12], [-12, -12]], -12.0),
        ("valid-zero", [[0, 0], [0, 0]], 0.0),
    ]
    north_row: list[int] = []
    south_row: list[int] = []
    descriptions: list[dict[str, object]] = []
    for index, (case_id, rows, expected) in enumerate(cases):
        north_row.extend(rows[0])
        south_row.extend(rows[1])
        entry: dict[str, object] = {
            "id": case_id,
            "columns": [index * 2, index * 2 + 1],
            "sampleAt": {"xFraction": 0.5, "yFraction": 0.5},
            "available": expected is not None,
            "interpolatedHeightM": expected,
        }
        if case_id == "nodata-withheld":
            entry["reason"] = "a contributing HGT sample is -32768"
            entry["ifIncorrectlyReplacedWithMinusOneM"] = 74.75
        descriptions.append(entry)
    values = north_row + south_row
    return struct.pack(f">{len(values)}h", *values), descriptions


def mutate_bit0_nodata(real_window: bytes, metadata: dict[str, object]) -> tuple[bytes, dict[str, int]]:
    row = 1086
    column = 2298
    row_start = int(metadata["originalRowStart"])
    column_start = int(metadata["originalColumnStart"])
    width = int(metadata["columns"])
    offset = 2 * ((row - row_start) * width + column - column_start)
    mutated = bytearray(real_window)
    original = struct.unpack_from(">h", mutated, offset)[0]
    struct.pack_into(">h", mutated, offset, NODATA)
    return bytes(mutated), {
        "originalRow": row,
        "originalColumn": column,
        "originalHeightM": original,
        "replacement": NODATA,
    }


def generate(input_archive: Path, output_dir: Path) -> None:
    if input_archive.name != ARCHIVE_NAME:
        raise ValueError(f"input archive must be named {ARCHIVE_NAME}")
    raw = read_source_archive(input_archive)
    output_dir.mkdir(parents=True, exist_ok=True)
    if any(output_dir.iterdir()):
        raise ValueError(f"output directory must be empty: {output_dir}")

    source_grid_origin = subgrid_point_location(0, 0, 0)
    if source_grid_origin != (356_985_339, -833_616_470):
        raise AssertionError(f"unexpected pinned source grid origin: {source_grid_origin}")

    windows: list[dict[str, object]] = []
    window_bytes_by_bit: dict[int, bytes] = {}
    for bit in (0, 55):
        row_start, row_end, column_start, column_end = window_bounds(raw, bit)
        data = extract_window(raw, row_start, row_end, column_start, column_end)
        filename = f"N35W084-bit{bit}-source-window.hgt"
        file_metadata = write_bytes(output_dir, filename, data)
        metadata: dict[str, object] = {
            **file_metadata,
            "synthetic": False,
            "encoding": "signed int16, big-endian, row-major north-to-south",
            "originalRowStart": row_start,
            "originalRowEndInclusive": row_end,
            "originalColumnStart": column_start,
            "originalColumnEndInclusive": column_end,
            "rows": row_end - row_start + 1,
            "columns": column_end - column_start + 1,
            "rowStrideBytes": (column_end - column_start + 1) * 2,
            "coversSubgridBit": bit,
        }
        windows.append(metadata)
        window_bytes_by_bit[bit] = data

    bit0_metadata = windows[0]
    nodata_data, mutation = mutate_bit0_nodata(window_bytes_by_bit[0], bit0_metadata)
    nodata_file = write_bytes(
        output_dir, "N35W084-bit0-nodata-synthetic.hgt", nodata_data
    )

    special_data, special_cases = synthetic_cases()
    special_file = write_bytes(
        output_dir, "synthetic-interpolation-cases.hgt", special_data
    )

    script_path = Path(__file__).resolve()
    manifest = {
        "schemaVersion": 1,
        "dataset": {
            "provider": "ardupilot-srtm1",
            "identity": "N35W084",
            "tileSouthWestDegrees": {
                "lat": TILE_LATITUDE_DEGREES,
                "lon": TILE_LONGITUDE_DEGREES,
            },
            "dimensionSamples": [TILE_DIMENSION, TILE_DIMENSION],
            "encoding": "signed int16, big-endian, row-major north-to-south",
            "nodata": NODATA,
            "archive": {
                "name": ARCHIVE_NAME,
                "sha256": ARCHIVE_SHA256,
                "byteLength": input_archive.stat().st_size,
                "member": MEMBER_NAME,
                "memberSha256": MEMBER_SHA256,
                "memberByteLength": TILE_BYTE_LENGTH,
            },
        },
        "provenance": {
            "generator": "scripts/terrain/official-fixtures.py",
            "generatorSha256": sha256(script_path.read_bytes()),
            "terraingen": {
                "repository": "https://github.com/ArduPilot/terraingen",
                "commit": TERRAINGEN_COMMIT,
                "coordinateHelper": "terrain_gen.py format 4.1",
                "sourceReader": "srtm.py SRTMTile",
            },
            "ardupilot": {
                "repository": "https://github.com/ArduPilot/ardupilot",
                "commit": ARDUPILOT_COMMIT,
                "mappingSources": [
                    "libraries/AP_Terrain/TerrainUtil.cpp",
                    "libraries/AP_Terrain/TerrainGCS.cpp",
                ],
            },
            "rounding": {
                "coordinates": "pinned terraingen float32 constants and truncation toward zero",
                "gridHeights": "pinned GridBlock.fill int() truncation toward zero",
                "pointHeight": "unrounded bilinear metres",
            },
        },
        "request": {
            "originE7": {"lat": REQUEST_LAT_E7, "lon": REQUEST_LON_E7},
            "originDegrees": {
                "lat": REQUEST_LAT_E7 * 1.0e-7,
                "lon": REQUEST_LON_E7 * 1.0e-7,
            },
            "spacingM": GRID_SPACING_M,
            "degreeTile": {"lat": 35, "lon": -84},
            "gridIndexNorth": REQUEST_GRID_INDEX_NORTH,
            "gridIndexEast": REQUEST_GRID_INDEX_EAST,
            "sourceGridOriginE7": {
                "lat": source_grid_origin[0],
                "lon": source_grid_origin[1],
            },
            "sourceToRequestDeltaE7": {
                "lat": REQUEST_LAT_E7 - source_grid_origin[0],
                "lon": REQUEST_LON_E7 - source_grid_origin[1],
            },
            "controllerCornerToleranceCm": CORNER_TOLERANCE_CM,
            "subgridBitMapping": "bit = eastSubgrid + 8 * northSubgrid",
            "blockShapeSamples": [GRID_BLOCK_SIZE_NORTH, GRID_BLOCK_SIZE_EAST],
            "blockStrideSamples": [
                GRID_BLOCK_SPACING_NORTH,
                GRID_BLOCK_SPACING_EAST,
            ],
        },
        "realWindows": windows,
        "expected": {
            "requestOriginPoint": interpolation(raw, REQUEST_LAT_E7, REQUEST_LON_E7),
            "subgrids": [build_subgrid(raw, 0), build_subgrid(raw, 55)],
            "overlap": {
                "bit": 55,
                "description": "north/east boundary shared with bit 0 of block (109, 70)",
                "neighborGridIndexNorth": 109,
                "neighborGridIndexEast": 70,
                "neighborBit": 0,
            },
        },
        "synthetic": {
            "label": "synthetic; not measurements from the official source tile",
            "nodataSubgrid": {
                **nodata_file,
                "derivedFrom": str(bit0_metadata["file"]),
                "encoding": str(bit0_metadata["encoding"]),
                "shape": [bit0_metadata["rows"], bit0_metadata["columns"]],
                "originalWindow": {
                    "rowStart": bit0_metadata["originalRowStart"],
                    "columnStart": bit0_metadata["originalColumnStart"],
                },
                "mutation": mutation,
                "bit": 0,
                "available": False,
                "heightsM": None,
                "reason": "withhold the complete 4x4 subgrid because one contributing sample is nodata",
            },
            "interpolationCases": {
                **special_file,
                "encoding": "signed int16, big-endian, row-major north-to-south",
                "shape": [2, 8],
                "cases": special_cases,
            },
        },
    }
    (output_dir / "expected.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-archive", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        generate(args.input_archive.resolve(), args.output_dir.resolve())
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(f"official-fixtures: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
