// SPDX-License-Identifier: GPL-3.0-or-later

/** A bounded raw HGT window, located by its original 3601-sample tile indexes. */
export interface HgtWindowIdentity {
  tile: string;
  schemaVersion: 1;
  rowStart: number;
  columnStart: number;
  rows: number;
  columns: number;
}

/**
 * A validated HGT window. Raw HGT carries no identity header, so callers must
 * validate manifest provenance before passing its declared identity here.
 */
export interface HgtWindow {
  readonly identity: Readonly<HgtWindowIdentity>;
  /** Accepts original tile indexes, not indexes relative to this window. */
  sample(row: number, column: number): number | null;
}

/**
 * Per-window bound: the raw input and copied Int16Array may each reach this
 * size while decoding. The caller owns combined cache accounting for windows
 * and derived grids.
 */
export const MAX_HGT_WINDOW_BYTES = 16 * 1024 * 1024;

const HGT_TILE_SAMPLES = 3601;
const HGT_NODATA = -32768;

/**
 * Decodes a manifest-identified bounded HGT window without reading files or
 * allocating a full degree tile. The raw format has no self-identifying
 * header; this validates only the supplied identity's shape and geography.
 */
export function decodeHgtWindow(bytes: Uint8Array, expected: HgtWindowIdentity): HgtWindow {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('HGT window bytes must be a Uint8Array');
  }
  if (bytes.byteLength > MAX_HGT_WINDOW_BYTES) {
    throw new RangeError(`HGT window exceeds the ${MAX_HGT_WINDOW_BYTES}-byte maximum`);
  }

  const identity = validateIdentity(expected);
  const sampleCount = identity.rows * identity.columns;
  const expectedByteLength = sampleCount * Int16Array.BYTES_PER_ELEMENT;
  if (expectedByteLength > MAX_HGT_WINDOW_BYTES) {
    throw new RangeError(`HGT window exceeds the ${MAX_HGT_WINDOW_BYTES}-byte maximum`);
  }
  if (bytes.byteLength !== expectedByteLength) {
    throw new RangeError(`HGT window byte length must be exactly ${expectedByteLength}`);
  }

  const samples = new Int16Array(sampleCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * Int16Array.BYTES_PER_ELEMENT, false);
  }

  const immutableIdentity = Object.freeze({...identity});
  return Object.freeze({
    identity: immutableIdentity,
    sample(row: number, column: number): number | null {
      if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column)
        || row < immutableIdentity.rowStart
        || row >= immutableIdentity.rowStart + immutableIdentity.rows
        || column < immutableIdentity.columnStart
        || column >= immutableIdentity.columnStart + immutableIdentity.columns) {
        throw new RangeError('HGT sample coordinates are outside the decoded window');
      }

      const relativeRow = row - immutableIdentity.rowStart;
      const relativeColumn = column - immutableIdentity.columnStart;
      const height = samples[relativeRow * immutableIdentity.columns + relativeColumn];
      return height === HGT_NODATA ? null : height;
    },
  });
}

function validateIdentity(expected: HgtWindowIdentity): HgtWindowIdentity {
  if (typeof expected !== 'object' || expected === null) {
    throw new TypeError('HGT window identity must be an object');
  }
  if (expected.schemaVersion !== 1) {
    throw new RangeError('unsupported HGT window identity schema version');
  }
  validateCanonicalTile(expected.tile);
  validateTileIndex('rowStart', expected.rowStart);
  validateTileIndex('columnStart', expected.columnStart);
  validateWindowExtent('rows', expected.rows, expected.rowStart);
  validateWindowExtent('columns', expected.columns, expected.columnStart);

  return {
    tile: expected.tile,
    schemaVersion: 1,
    rowStart: expected.rowStart,
    columnStart: expected.columnStart,
    rows: expected.rows,
    columns: expected.columns,
  };
}

function validateCanonicalTile(tile: unknown): void {
  if (typeof tile !== 'string') {
    throw new TypeError('HGT tile identity must be a string');
  }
  const match = /^([NS])(\d{2})([EW])(\d{3})$/.exec(tile);
  if (match === null) {
    throw new RangeError('HGT tile identity must use canonical N35W084 form');
  }

  const latitudeDegrees = Number(match[2]);
  const longitudeDegrees = Number(match[4]);
  if ((latitudeDegrees === 0 && match[1] !== 'N')
    || (longitudeDegrees === 0 && match[3] !== 'E')) {
    throw new RangeError('HGT tile identity must use canonical N00/E000 zero directions');
  }
  const southWestLatitude = match[1] === 'N' ? latitudeDegrees : -latitudeDegrees;
  const southWestLongitude = match[3] === 'E' ? longitudeDegrees : -longitudeDegrees;
  if (southWestLatitude < -90 || southWestLatitude > 89
    || southWestLongitude < -180 || southWestLongitude > 179) {
    throw new RangeError('HGT tile identity is outside geographic tile bounds');
  }
}

function validateTileIndex(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 0 || value >= HGT_TILE_SAMPLES) {
    throw new RangeError(`${name} must be an integer inside the HGT tile`);
  }
}

function validateWindowExtent(name: string, value: unknown, start: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < 1 || value > HGT_TILE_SAMPLES || start + value > HGT_TILE_SAMPLES) {
    throw new RangeError(`${name} must be a positive integer within the HGT tile`);
  }
}
